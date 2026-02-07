from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from ultralytics import YOLO


@dataclass
class QueueSnapshot:
    timestamp: str
    stream_source: str
    stream_status: str
    stream_error: str | None
    drive_thru_car_count: int
    drive_thru_est_passengers: float
    in_store_person_count: int
    total_customers: float
    avg_service_time_sec: float
    estimated_wait_time_min: float
    frame_number: int
    inference_device: str
    processing_fps: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "stream_source": self.stream_source,
            "stream_status": self.stream_status,
            "stream_error": self.stream_error,
            "drive_thru": {
                "car_count": self.drive_thru_car_count,
                "est_passengers": self.drive_thru_est_passengers,
            },
            "in_store": {"person_count": self.in_store_person_count},
            "aggregates": {
                "total_customers": self.total_customers,
                "avg_service_time_sec": self.avg_service_time_sec,
                "estimated_wait_time_min": self.estimated_wait_time_min,
            },
            "frame_number": self.frame_number,
            "inference_device": self.inference_device,
            "performance": {
                "processing_fps": self.processing_fps,
            },
        }


class VideoProcessor:
    def __init__(
        self,
        video_path: str | Path,
        model_name: str = "yolo11n.pt",
        sample_fps: float = 30.0,
        conf: float = 0.35,
        iou: float = 0.5,
        imgsz: int = 640,
        people_per_car: float = 1.5,
        avg_service_time_sec: float = 45.0,
        drive_thru_roi: tuple[float, float, float, float] | None = None,
        in_store_roi: tuple[float, float, float, float] | None = None,
        detect_drive_thru_vehicles: bool = True,
        detect_in_store_people: bool = True,
        device: str | int | None = "cuda:0",
    ) -> None:
        self.video_path = str(video_path)
        self._source_lock = threading.Lock()
        self._source_version = 0
        self.sample_fps = max(1.0, sample_fps)
        self.conf = conf
        self.iou = iou
        self.imgsz = imgsz
        self.people_per_car = people_per_car
        self.avg_service_time_sec = avg_service_time_sec
        self.drive_thru_roi = drive_thru_roi
        self.in_store_roi = in_store_roi
        self.detect_drive_thru_vehicles = detect_drive_thru_vehicles
        self.detect_in_store_people = detect_in_store_people
        self.device = self._resolve_device(device)
        self.rtsp_transport = self._parse_rtsp_transport(os.getenv("RTSP_TRANSPORT", "tcp"))
        self.capture_open_timeout_msec = self._parse_positive_int(os.getenv("CAPTURE_OPEN_TIMEOUT_MSEC"), 10000)
        self.capture_read_timeout_msec = self._parse_positive_int(os.getenv("CAPTURE_READ_TIMEOUT_MSEC"), 10000)

        self._model = YOLO(model_name)
        self._vehicle_labels = {"car", "truck", "motorcycle", "bus"}
        self._person_labels = {"person", "pedestrian", "human", "man", "woman", "boy", "girl"}
        self._class_labels_by_id = self._build_class_label_map()
        self._vehicle_class_ids = {cls_id for cls_id, label in self._class_labels_by_id.items() if label in self._vehicle_labels}
        self._person_class_ids = {cls_id for cls_id, label in self._class_labels_by_id.items() if label in self._person_labels}

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

        self._latest_frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        self._latest_snapshot = self._empty_snapshot()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=3)

    def get_latest_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._latest_snapshot.to_dict()

    def get_latest_jpeg(self) -> bytes | None:
        with self._lock:
            frame = self._latest_frame.copy()
        ok, jpg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not ok:
            return None
        return jpg.tobytes()

    def get_video_source(self) -> str:
        with self._source_lock:
            return self.video_path

    def set_video_source(self, source: str | Path) -> str:
        normalized = str(source).strip()
        if not normalized:
            raise ValueError("Video source cannot be empty.")
        with self._source_lock:
            if normalized != self.video_path:
                self.video_path = normalized
                self._source_version += 1
            return self.video_path

    def _get_video_source_state(self) -> tuple[str, int]:
        with self._source_lock:
            return self.video_path, self._source_version

    def _run(self) -> None:
        frame_number = 0
        smoothed_fps = 0.0
        last_frame_tick: float | None = None
        while not self._stop_event.is_set():
            video_path, source_version = self._get_video_source_state()
            cap = self._open_capture(video_path)
            if not cap.isOpened():
                self._draw_error_frame(
                    "Cannot open stream. Check URL, credentials, network, and codec support.",
                    stream_source=video_path,
                )
                self._stop_event.wait(1.0)
                continue

            source_fps = cap.get(cv2.CAP_PROP_FPS)
            if source_fps <= 0:
                source_fps = 30.0
            frame_stride = max(1, int(round(source_fps / self.sample_fps)))
            target_delta = frame_stride / source_fps

            while not self._stop_event.is_set():
                _, current_version = self._get_video_source_state()
                if current_version != source_version:
                    break

                frame = self._read_with_stride(cap, frame_stride)
                if frame is None:
                    break

                now = time.perf_counter()
                if last_frame_tick is not None:
                    delta = now - last_frame_tick
                    if delta > 0:
                        instant_fps = 1.0 / delta
                        if smoothed_fps <= 0:
                            smoothed_fps = instant_fps
                        else:
                            smoothed_fps = (0.85 * smoothed_fps) + (0.15 * instant_fps)
                last_frame_tick = now

                start_time = time.perf_counter()
                annotated, snapshot = self._infer(frame, frame_number, smoothed_fps, stream_source=video_path)

                with self._lock:
                    self._latest_frame = annotated
                    self._latest_snapshot = snapshot

                frame_number += frame_stride
                elapsed = time.perf_counter() - start_time
                self._stop_event.wait(max(0.0, target_delta - elapsed))

            cap.release()

    def _infer(
        self,
        frame: np.ndarray,
        frame_number: int,
        processing_fps: float,
        stream_source: str,
    ) -> tuple[np.ndarray, QueueSnapshot]:
        draw = frame.copy()
        frame_h, frame_w = draw.shape[:2]
        drive_roi = self._to_absolute_roi(self.drive_thru_roi, frame_w, frame_h)
        store_roi = self._to_absolute_roi(self.in_store_roi, frame_w, frame_h)

        results = self._run_inference(draw)
        result = results[0]

        vehicle_ids: set[str | int] = set()
        person_ids: set[str | int] = set()

        boxes = result.boxes
        if boxes is not None:
            for idx, box in enumerate(boxes):
                cls_id = int(box.cls[0].item())
                label = self._class_label(cls_id)
                normalized_label = self._class_labels_by_id.get(cls_id, label.strip().lower())

                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                center_x = int((x1 + x2) / 2)
                center_y = int((y1 + y2) / 2)
                track_id: int | None = None
                if box.id is not None:
                    try:
                        maybe_id = float(box.id[0].item())
                    except (TypeError, ValueError):
                        maybe_id = float("nan")
                    if np.isfinite(maybe_id):
                        track_id = int(maybe_id)

                if (
                    self.detect_drive_thru_vehicles
                    and self._is_vehicle_label(cls_id, normalized_label)
                    and self._inside_roi(center_x, center_y, drive_roi)
                ):
                    identity = track_id if track_id is not None else f"vehicle-{idx}"
                    vehicle_ids.add(identity)
                    self._draw_box(draw, x1, y1, x2, y2, f"{label} #{identity}", (24, 136, 255))
                elif (
                    self.detect_in_store_people
                    and self._is_person_label(cls_id, normalized_label)
                    and self._inside_roi(center_x, center_y, store_roi)
                ):
                    identity = track_id if track_id is not None else f"person-{idx}"
                    person_ids.add(identity)
                    self._draw_box(draw, x1, y1, x2, y2, f"{label} #{identity}", (78, 204, 163))

        car_count = len(vehicle_ids)
        est_passengers = round(car_count * self.people_per_car, 1)
        person_count = len(person_ids)
        total_customers = round(est_passengers + person_count, 1)
        estimated_wait = round((total_customers * self.avg_service_time_sec) / 60.0, 1)

        if drive_roi:
            self._draw_roi(draw, drive_roi, "Drive-Thru ROI", (24, 136, 255))
        if store_roi:
            self._draw_roi(draw, store_roi, "In-Store ROI", (78, 204, 163))

        self._draw_hud(
            draw,
            car_count=car_count,
            est_passengers=est_passengers,
            person_count=person_count,
            total_customers=total_customers,
            estimated_wait=estimated_wait,
            processing_fps=processing_fps,
        )

        snapshot = QueueSnapshot(
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            stream_source=stream_source,
            stream_status="ok",
            stream_error=None,
            drive_thru_car_count=car_count,
            drive_thru_est_passengers=est_passengers,
            in_store_person_count=person_count,
            total_customers=total_customers,
            avg_service_time_sec=self.avg_service_time_sec,
            estimated_wait_time_min=estimated_wait,
            frame_number=frame_number,
            inference_device=str(self.device),
            processing_fps=round(processing_fps, 1),
        )
        return draw, snapshot

    def _run_inference(self, frame: np.ndarray):
        # For in-store counting, detection is more reliable than tracker association.
        if self.detect_in_store_people and not self.detect_drive_thru_vehicles:
            kwargs: dict[str, Any] = dict(
                source=frame,
                device=self.device,
                conf=self.conf,
                iou=self.iou,
                imgsz=self.imgsz,
                verbose=False,
            )
            if self._person_class_ids:
                kwargs["classes"] = sorted(self._person_class_ids)
            return self._model.predict(**kwargs)

        return self._model.track(
            source=frame,
            persist=True,
            tracker="bytetrack.yaml",
            device=self.device,
            conf=self.conf,
            iou=self.iou,
            imgsz=self.imgsz,
            verbose=False,
        )

    def _build_class_label_map(self) -> dict[int, str]:
        names = self._model.names
        if isinstance(names, dict):
            items = names.items()
        elif isinstance(names, list):
            items = enumerate(names)
        else:
            return {}

        normalized: dict[int, str] = {}
        for cls_id, raw_label in items:
            try:
                key = int(cls_id)
            except (TypeError, ValueError):
                continue
            normalized[key] = str(raw_label).strip().lower()
        return normalized

    def _class_label(self, cls_id: int) -> str:
        names = self._model.names
        if isinstance(names, dict):
            return str(names.get(cls_id, cls_id))
        if isinstance(names, list) and 0 <= cls_id < len(names):
            return str(names[cls_id])
        return str(cls_id)

    def _is_vehicle_label(self, cls_id: int, normalized_label: str) -> bool:
        return cls_id in self._vehicle_class_ids or normalized_label in self._vehicle_labels

    def _is_person_label(self, cls_id: int, normalized_label: str) -> bool:
        return cls_id in self._person_class_ids or normalized_label in self._person_labels

    @staticmethod
    def _draw_box(
        frame: np.ndarray,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        label: str,
        color: tuple[int, int, int],
    ) -> None:
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.rectangle(frame, (x1, max(0, y1 - 22)), (min(x2, x1 + 220), y1), color, -1)
        cv2.putText(frame, label[:28], (x1 + 4, max(16, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)

    @staticmethod
    def _draw_roi(frame: np.ndarray, roi: tuple[int, int, int, int], label: str, color: tuple[int, int, int]) -> None:
        x1, y1, x2, y2 = roi
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, label, (x1 + 8, y1 + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

    @staticmethod
    def _draw_hud(
        frame: np.ndarray,
        car_count: int,
        est_passengers: float,
        person_count: int,
        total_customers: float,
        estimated_wait: float,
        processing_fps: float,
    ) -> None:
        lines = [
            f"Drive-thru cars: {car_count}",
            f"Estimated passengers: {est_passengers}",
            f"In-store people: {person_count}",
            f"Total customers: {total_customers}",
            f"Estimated wait (min): {estimated_wait}",
            f"Processing FPS: {processing_fps:.1f}",
        ]
        box_width = 380
        box_height = 30 + (len(lines) * 28)
        overlay = frame.copy()
        cv2.rectangle(overlay, (20, 20), (20 + box_width, 20 + box_height), (20, 20, 20), -1)
        cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)
        for i, line in enumerate(lines):
            y = 50 + (i * 28)
            cv2.putText(frame, line, (35, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

    def _draw_error_frame(self, message: str, stream_source: str) -> None:
        error_frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        cv2.putText(error_frame, "Video Stream Error", (60, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3)
        cv2.putText(error_frame, message[:90], (60, 160), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        source_label = f"Source: {stream_source}"
        cv2.putText(error_frame, source_label[:110], (60, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 220, 255), 2)
        with self._lock:
            self._latest_frame = error_frame
            self._latest_snapshot = QueueSnapshot(
                timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                stream_source=stream_source,
                stream_status="error",
                stream_error=message,
                drive_thru_car_count=0,
                drive_thru_est_passengers=0.0,
                in_store_person_count=0,
                total_customers=0.0,
                avg_service_time_sec=self.avg_service_time_sec,
                estimated_wait_time_min=0.0,
                frame_number=0,
                inference_device=str(self.device),
                processing_fps=0.0,
            )

    def _empty_snapshot(self) -> QueueSnapshot:
        return QueueSnapshot(
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            stream_source=self.get_video_source(),
            stream_status="initializing",
            stream_error=None,
            drive_thru_car_count=0,
            drive_thru_est_passengers=0.0,
            in_store_person_count=0,
            total_customers=0.0,
            avg_service_time_sec=self.avg_service_time_sec,
            estimated_wait_time_min=0.0,
            frame_number=0,
            inference_device=str(self.device),
            processing_fps=0.0,
        )

    @staticmethod
    def _cuda_available() -> bool:
        try:
            import torch

            return bool(torch.cuda.is_available())
        except Exception:
            return False

    @classmethod
    def _resolve_device(cls, device: str | int | None) -> str | int:
        if isinstance(device, int):
            return device

        if device is None:
            return 0 if cls._cuda_available() else "cpu"

        text = str(device).strip()
        if not text:
            return 0 if cls._cuda_available() else "cpu"

        lowered = text.lower()
        if lowered == "auto":
            return 0 if cls._cuda_available() else "cpu"
        if lowered in {"gpu", "cuda"}:
            return 0
        if lowered.isdigit():
            return int(lowered)
        if lowered.startswith("cuda:"):
            return text
        return text

    @staticmethod
    def _to_absolute_roi(
        roi: tuple[float, float, float, float] | None,
        frame_w: int,
        frame_h: int,
    ) -> tuple[int, int, int, int] | None:
        if roi is None:
            return None
        x1, y1, x2, y2 = roi
        return (
            int(max(0.0, min(1.0, x1)) * frame_w),
            int(max(0.0, min(1.0, y1)) * frame_h),
            int(max(0.0, min(1.0, x2)) * frame_w),
            int(max(0.0, min(1.0, y2)) * frame_h),
        )

    @staticmethod
    def _inside_roi(x: int, y: int, roi: tuple[int, int, int, int] | None) -> bool:
        if roi is None:
            return True
        x1, y1, x2, y2 = roi
        return x1 <= x <= x2 and y1 <= y <= y2

    @staticmethod
    def _read_with_stride(cap: cv2.VideoCapture, frame_stride: int) -> np.ndarray | None:
        frame: np.ndarray | None = None
        for _ in range(frame_stride):
            ok, maybe_frame = cap.read()
            if not ok:
                return None
            frame = maybe_frame
        return frame

    @staticmethod
    def _parse_positive_int(value: str | None, default: int) -> int:
        if value is None:
            return default
        try:
            parsed = int(value)
        except ValueError:
            return default
        return parsed if parsed > 0 else default

    @staticmethod
    def _parse_rtsp_transport(value: str) -> str:
        normalized = value.strip().lower()
        if normalized in {"tcp", "udp"}:
            return normalized
        return "tcp"

    @staticmethod
    def _normalize_capture_source(source: str) -> str | int:
        candidate = source.strip()
        if candidate.isdigit():
            return int(candidate)
        return candidate

    def _open_capture(self, source: str) -> cv2.VideoCapture:
        normalized = self._normalize_capture_source(source)

        if isinstance(normalized, str) and normalized.lower().startswith(("rtsp://", "rtsps://")):
            options = (
                f"rtsp_transport;{self.rtsp_transport}|"
                f"stimeout;{self.capture_open_timeout_msec * 1000}|"
                f"rw_timeout;{self.capture_read_timeout_msec * 1000}"
            )
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = options
            cap = cv2.VideoCapture(normalized, cv2.CAP_FFMPEG)
            if cap.isOpened():
                return cap
            cap.release()

        return cv2.VideoCapture(normalized)
