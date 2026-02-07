from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Generator

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from app.pipeline import VideoProcessor


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_INDEX = BASE_DIR / "frontend" / "index.html"


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _parse_roi(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None or not value.strip():
        return None
    parts = [p.strip() for p in value.split(",")]
    if len(parts) != 4:
        return None
    try:
        x1, y1, x2, y2 = [float(v) for v in parts]
    except ValueError:
        return None
    return (x1, y1, x2, y2)


processor = VideoProcessor(
    video_path=os.getenv("VIDEO_PATH", str(BASE_DIR / "sample.mp4")),
    model_name=os.getenv("YOLO_MODEL", "yolo26s.pt"),
    sample_fps=_env_float("SAMPLE_FPS", 30.0),
    conf=_env_float("CONF_THRESHOLD", 0.35),
    iou=_env_float("IOU_THRESHOLD", 0.5),
    imgsz=_env_int("IMG_SIZE", 640),
    people_per_car=_env_float("PEOPLE_PER_CAR", 1.5),
    avg_service_time_sec=_env_float("AVG_SERVICE_TIME_SEC", 45.0),
    drive_thru_roi=_parse_roi(os.getenv("DRIVE_THRU_ROI")),
    in_store_roi=_parse_roi(os.getenv("IN_STORE_ROI")),
    device=os.getenv("YOLO_DEVICE", "auto"),
)

app = FastAPI(title="Fast Food Line Estimation Demo", version="0.1.0")


@app.on_event("startup")
def on_startup() -> None:
    processor.start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    processor.stop()


@app.get("/")
def index() -> FileResponse:
    if not FRONTEND_INDEX.exists():
        raise HTTPException(status_code=404, detail="Frontend file not found.")
    return FileResponse(FRONTEND_INDEX)


@app.get("/api/metrics")
def metrics() -> JSONResponse:
    return JSONResponse(processor.get_latest_snapshot())


def _mjpeg_generator() -> Generator[bytes, None, None]:
    while True:
        jpg = processor.get_latest_jpeg()
        if jpg is None:
            time.sleep(0.1)
            continue
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
        time.sleep(0.03)


@app.get("/video/feed")
def video_feed() -> StreamingResponse:
    return StreamingResponse(
        _mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
