from __future__ import annotations

import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator

from app.analytics_store import AnalyticsStore
from app.pipeline import VideoProcessor
from app.recommendations import ItemProfile, RecommendationEngine


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


def _env_list(name: str, default: list[str]) -> list[str]:
    value = os.getenv(name)
    if value is None:
        return default
    items = [item.strip() for item in value.split(",")]
    return [item for item in items if item]


DEFAULT_VIDEO_SOURCE = os.getenv("VIDEO_PATH", str(BASE_DIR / "sample.mp4"))
CAMERA_IDS = ("drive_thru", "in_store")
DEFAULT_CAMERA_SOURCES: dict[str, str] = {
    "drive_thru": os.getenv("DRIVE_THRU_VIDEO_PATH", DEFAULT_VIDEO_SOURCE),
    "in_store": os.getenv("IN_STORE_VIDEO_PATH", str(BASE_DIR / "sample1.mp4")),
}
AVG_SERVICE_TIME_SEC = _env_float("AVG_SERVICE_TIME_SEC", 45.0)
ANALYTICS_DB_PATH = os.getenv("ANALYTICS_DB_PATH", str(BASE_DIR / "analytics.db"))
ANALYTICS_SAMPLE_INTERVAL_SEC = _env_float("ANALYTICS_SAMPLE_INTERVAL_SEC", 1.0)
ANALYTICS_MEMORY_POINTS = _env_int("ANALYTICS_MEMORY_POINTS", 7200)


class StreamSourcePayload(BaseModel):
    source: str


class MenuItemPayload(BaseModel):
    key: str | None = Field(default=None, max_length=64)
    label: str = Field(min_length=1, max_length=80)
    units_per_order: float = Field(gt=0.0, le=10.0)
    batch_size: int = Field(ge=1, le=500)
    max_unit_size: int = Field(
        default=64,
        ge=1,
        le=5000,
        validation_alias=AliasChoices("max_unit_size", "max_batch_size"),
    )
    baseline_drop_units: int = Field(ge=0, le=5000)
    unit_cost_usd: float = Field(ge=0.0, le=1000.0)

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("label must not be empty")
        return stripped

    @model_validator(mode="after")
    def validate_unit_limit(self) -> MenuItemPayload:
        if self.batch_size > self.max_unit_size:
            raise ValueError(
                f"batch_size ({self.batch_size}) exceeds max_unit_size ({self.max_unit_size})"
            )
        return self


class BusinessProfilePayload(BaseModel):
    business_name: str = Field(min_length=1, max_length=120)
    business_type: str = Field(min_length=1, max_length=80)
    location: str = Field(min_length=1, max_length=120)
    service_model: str = Field(min_length=1, max_length=80)
    drop_cadence_min: float = Field(gt=0.0, le=60.0)
    avg_ticket_usd: float = Field(gt=0.0, le=500.0)
    menu_items: list[MenuItemPayload] = Field(min_length=1, max_length=24)

    @field_validator("business_name", "business_type", "location", "service_model")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value must not be empty")
        return stripped

SAMPLE_BUSINESS_PROFILE: dict[str, Any] = {
    "business_name": "Steel City Chicken",
    "business_type": "Fast Food",
    "location": "Pittsburgh, PA",
    "service_model": "Drive-thru + Counter",
    "drop_cadence_min": _env_float("RECO_DROP_CADENCE_MIN", 4.0),
    "avg_ticket_usd": _env_float("AVG_TICKET_USD", 10.5),
    "menu_items": [
        {
            "key": "fillets",
            "label": "Chicken Fillets",
            "units_per_order": 0.58,
            "batch_size": 8,
            "max_unit_size": 24,
            "baseline_drop_units": 16,
            "unit_cost_usd": 0.92,
        },
        {
            "key": "nuggets",
            "label": "Nuggets",
            "units_per_order": 0.36,
            "batch_size": 6,
            "max_unit_size": 20,
            "baseline_drop_units": 12,
            "unit_cost_usd": 0.68,
        },
        {
            "key": "fries",
            "label": "Fries",
            "units_per_order": 0.72,
            "batch_size": 10,
            "max_unit_size": 28,
            "baseline_drop_units": 18,
            "unit_cost_usd": 0.44,
        },
        {
            "key": "strips",
            "label": "Strips",
            "units_per_order": 0.15,
            "batch_size": 8,
            "max_unit_size": 20,
            "baseline_drop_units": 8,
            "unit_cost_usd": 0.86,
        },
    ],
}


def _build_processor(video_source: str, *, camera_id: str) -> VideoProcessor:
    common_kwargs = dict(
        model_name=os.getenv("YOLO_MODEL", "yolo11n.pt"),
        sample_fps=_env_float("SAMPLE_FPS", 30.0),
        iou=_env_float("IOU_THRESHOLD", 0.5),
        imgsz=_env_int("IMG_SIZE", 640),
        people_per_car=_env_float("PEOPLE_PER_CAR", 1.5),
        avg_service_time_sec=AVG_SERVICE_TIME_SEC,
        device=os.getenv("YOLO_DEVICE", "cuda:0"),
    )

    if camera_id == "drive_thru":
        return VideoProcessor(
            video_path=video_source,
            conf=_env_float("DRIVE_THRU_CONF_THRESHOLD", _env_float("CONF_THRESHOLD", 0.35)),
            drive_thru_roi=_parse_roi(os.getenv("DRIVE_THRU_ROI")),
            in_store_roi=None,
            detect_drive_thru_vehicles=True,
            detect_in_store_people=False,
            **common_kwargs,
        )

    return VideoProcessor(
        video_path=video_source,
        conf=_env_float("IN_STORE_CONF_THRESHOLD", 0.2),
        drive_thru_roi=None,
        in_store_roi=None,
        detect_drive_thru_vehicles=False,
        detect_in_store_people=True,
        **common_kwargs,
    )


processors: dict[str, VideoProcessor] = {
    camera_id: _build_processor(DEFAULT_CAMERA_SOURCES[camera_id], camera_id=camera_id) for camera_id in CAMERA_IDS
}
recommender = RecommendationEngine()
reco_lock = threading.Lock()
analytics_store = AnalyticsStore(
    db_path=ANALYTICS_DB_PATH,
    sample_interval_sec=ANALYTICS_SAMPLE_INTERVAL_SEC,
    memory_points=ANALYTICS_MEMORY_POINTS,
)


def _slugify(value: str) -> str:
    token = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return token or "item"


def _build_item_profiles(menu_items: list[MenuItemPayload]) -> list[ItemProfile]:
    normalized: list[ItemProfile] = []
    seen_keys: set[str] = set()

    for position, item in enumerate(menu_items, start=1):
        base_key = _slugify(item.key or item.label)
        key = base_key
        suffix = 2
        while key in seen_keys:
            key = f"{base_key}_{suffix}"
            suffix += 1
        seen_keys.add(key)

        normalized.append(
            ItemProfile(
                key=key,
                label=item.label,
                units_per_order=float(item.units_per_order),
                batch_size=int(item.batch_size),
                max_unit_size=int(item.max_unit_size),
                baseline_drop_units=int(item.baseline_drop_units),
                unit_cost_usd=float(item.unit_cost_usd),
            )
        )

        if position > 32:
            break

    return normalized


def _apply_business_profile(payload: BusinessProfilePayload) -> dict[str, Any]:
    item_profiles = _build_item_profiles(payload.menu_items)
    return recommender.configure_business_profile(
        business_name=payload.business_name,
        business_type=payload.business_type,
        location=payload.location,
        service_model=payload.service_model,
        drop_cadence_min=payload.drop_cadence_min,
        avg_ticket_usd=payload.avg_ticket_usd,
        item_profiles=item_profiles,
    )


def _validate_camera_id(camera_id: str) -> str:
    normalized = camera_id.strip().lower()
    if normalized not in CAMERA_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown camera '{camera_id}'.")
    return normalized


def _stream_source_response(camera_id: str) -> dict[str, str]:
    return {
        "camera_id": camera_id,
        "source": processors[camera_id].get_video_source(),
        "default_source": DEFAULT_CAMERA_SOURCES[camera_id],
    }


def _all_stream_sources_response() -> dict[str, Any]:
    return {
        "sources": {
            camera_id: _stream_source_response(camera_id)
            for camera_id in CAMERA_IDS
        }
    }


def _parse_iso_timestamp(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


def _aggregate_snapshot() -> dict[str, Any]:
    snapshots = {camera_id: processors[camera_id].get_latest_snapshot() for camera_id in CAMERA_IDS}
    drive_snapshot = snapshots["drive_thru"]
    store_snapshot = snapshots["in_store"]

    drive_thru_car_count = int(drive_snapshot.get("drive_thru", {}).get("car_count", 0) or 0)
    drive_thru_est_passengers = float(drive_snapshot.get("drive_thru", {}).get("est_passengers", 0.0) or 0.0)
    in_store_person_count = int(store_snapshot.get("in_store", {}).get("person_count", 0) or 0)

    total_customers = round(drive_thru_est_passengers + in_store_person_count, 1)
    estimated_wait_time_min = round((total_customers * AVG_SERVICE_TIME_SEC) / 60.0, 1)

    statuses = [str(snapshot.get("stream_status", "initializing")).lower() for snapshot in snapshots.values()]
    if all(status == "ok" for status in statuses):
        stream_status = "ok"
    elif any(status == "ok" for status in statuses):
        stream_status = "degraded"
    elif all(status == "error" for status in statuses):
        stream_status = "error"
    else:
        stream_status = "initializing"

    errors = [
        f"{camera_id}: {snapshot.get('stream_error')}"
        for camera_id, snapshot in snapshots.items()
        if snapshot.get("stream_error")
    ]
    stream_error = "; ".join(errors) if errors else None

    stream_source = " | ".join(
        f"{camera_id}={snapshot.get('stream_source', '')}" for camera_id, snapshot in snapshots.items()
    )

    timestamps = [_parse_iso_timestamp(str(snapshot.get("timestamp", ""))) for snapshot in snapshots.values()]
    newest_timestamp = max(timestamps).isoformat().replace("+00:00", "Z")

    fps_values = [
        float(snapshot.get("performance", {}).get("processing_fps", 0.0) or 0.0)
        for snapshot in snapshots.values()
    ]
    avg_fps = round(sum(fps_values) / max(1, len(fps_values)), 1)

    inference_device = ", ".join(
        f"{camera_id}:{snapshot.get('inference_device', '-')}"
        for camera_id, snapshot in snapshots.items()
    )

    return {
        "timestamp": newest_timestamp,
        "stream_source": stream_source,
        "stream_status": stream_status,
        "stream_error": stream_error,
        "drive_thru": {
            "car_count": drive_thru_car_count,
            "est_passengers": round(drive_thru_est_passengers, 1),
        },
        "in_store": {
            "person_count": in_store_person_count,
        },
        "aggregates": {
            "total_customers": total_customers,
            "avg_service_time_sec": AVG_SERVICE_TIME_SEC,
            "estimated_wait_time_min": estimated_wait_time_min,
        },
        "inference_device": inference_device,
        "performance": {
            "processing_fps": avg_fps,
        },
        "cameras": snapshots,
    }


def _generate_recommendations(snapshot: dict[str, Any]) -> dict[str, Any]:
    with reco_lock:
        return recommender.generate(snapshot)


def _analytics_sample_provider() -> tuple[dict[str, Any], dict[str, Any]]:
    snapshot = _aggregate_snapshot()
    recommendations_payload = _generate_recommendations(snapshot)
    return snapshot, recommendations_payload


def _build_demo_readiness() -> dict[str, Any]:
    snapshot = _aggregate_snapshot()
    now = datetime.now(timezone.utc)
    snapshot_timestamp = _parse_iso_timestamp(str(snapshot.get("timestamp", "")))
    data_age_sec = max(0.0, (now - snapshot_timestamp).total_seconds())
    average_fps = float(snapshot.get("performance", {}).get("processing_fps", 0.0) or 0.0)

    cameras = snapshot.get("cameras", {})
    camera_statuses = {
        camera_id: str(cameras.get(camera_id, {}).get("stream_status", "initializing")).lower()
        for camera_id in CAMERA_IDS
    }

    with reco_lock:
        profile = recommender.get_business_profile()

    business_name = str(profile.get("business_name", "")).strip()
    menu_items = profile.get("menu_items", [])
    menu_item_count = len(menu_items) if isinstance(menu_items, list) else 0
    drop_cadence_min = float(profile.get("drop_cadence_min", 0.0) or 0.0)
    avg_ticket_usd = float(profile.get("avg_ticket_usd", 0.0) or 0.0)

    checks: list[dict[str, Any]] = []
    score = 0
    failure_count = 0

    def add_check(check_id: str, label: str, status: str, detail: str, points: int) -> None:
        nonlocal score, failure_count
        checks.append(
            {
                "id": check_id,
                "label": label,
                "status": status,
                "detail": detail,
                "points": points,
            }
        )
        score += points
        if status == "fail":
            failure_count += 1

    if all(status == "ok" for status in camera_statuses.values()):
        add_check(
            "streams",
            "Live Camera Streams",
            "pass",
            "Both drive-thru and in-store feeds are live.",
            35,
        )
    elif any(status == "ok" for status in camera_statuses.values()):
        add_check(
            "streams",
            "Live Camera Streams",
            "warn",
            "Only one camera feed is live; results are directionally useful but less robust.",
            20,
        )
    else:
        add_check(
            "streams",
            "Live Camera Streams",
            "fail",
            "No live camera feeds are healthy right now.",
            2,
        )

    if data_age_sec <= 3.0:
        add_check(
            "freshness",
            "Telemetry Freshness",
            "pass",
            f"Latest telemetry is fresh ({data_age_sec:.1f}s old).",
            20,
        )
    elif data_age_sec <= 8.0:
        add_check(
            "freshness",
            "Telemetry Freshness",
            "warn",
            f"Telemetry is slightly delayed ({data_age_sec:.1f}s old).",
            10,
        )
    else:
        add_check(
            "freshness",
            "Telemetry Freshness",
            "fail",
            f"Telemetry is stale ({data_age_sec:.1f}s old).",
            0,
        )

    if average_fps >= 10.0:
        add_check(
            "throughput",
            "Inference Throughput",
            "pass",
            f"Inference is running at {average_fps:.1f} FPS.",
            20,
        )
    elif average_fps >= 5.0:
        add_check(
            "throughput",
            "Inference Throughput",
            "warn",
            f"Inference is usable but slower than ideal at {average_fps:.1f} FPS.",
            12,
        )
    else:
        add_check(
            "throughput",
            "Inference Throughput",
            "fail",
            f"Inference throughput is low at {average_fps:.1f} FPS.",
            4,
        )

    if business_name and menu_item_count >= 3 and avg_ticket_usd > 0:
        add_check(
            "business_profile",
            "Business Configuration",
            "pass",
            f"Business profile '{business_name}' has {menu_item_count} menu items configured.",
            15,
        )
    elif menu_item_count >= 1:
        add_check(
            "business_profile",
            "Business Configuration",
            "warn",
            "Business profile is present but limited; add more menu coverage for stronger recommendations.",
            8,
        )
    else:
        add_check(
            "business_profile",
            "Business Configuration",
            "fail",
            "Business profile is incomplete; recommendations may not reflect real operations.",
            0,
        )

    if 0.5 <= drop_cadence_min <= 15.0:
        add_check(
            "cadence",
            "Recommendation Cadence",
            "pass",
            f"Recommendation cadence is tuned to {drop_cadence_min:.1f} minutes.",
            10,
        )
    elif drop_cadence_min > 0:
        add_check(
            "cadence",
            "Recommendation Cadence",
            "warn",
            f"Cadence is set to {drop_cadence_min:.1f} minutes; verify this matches kitchen rhythm.",
            5,
        )
    else:
        add_check(
            "cadence",
            "Recommendation Cadence",
            "fail",
            "Cadence is not configured.",
            0,
        )

    blockers = [check["label"] for check in checks if check["status"] == "fail"]
    if failure_count == 0 and score >= 80:
        readiness_status = "ready"
    elif score >= 55:
        readiness_status = "degraded"
    else:
        readiness_status = "blocked"

    return {
        "timestamp": now.isoformat().replace("+00:00", "Z"),
        "score": int(max(0, min(100, score))),
        "status": readiness_status,
        "blockers": blockers,
        "summary": {
            "stream_status": str(snapshot.get("stream_status", "initializing")).lower(),
            "data_age_sec": round(data_age_sec, 1),
            "processing_fps": round(average_fps, 1),
            "camera_statuses": camera_statuses,
            "business_name": business_name or "Unconfigured",
            "menu_item_count": menu_item_count,
        },
        "checks": checks,
    }


with reco_lock:
    _apply_business_profile(BusinessProfilePayload.model_validate(SAMPLE_BUSINESS_PROFILE))


app = FastAPI(title="Fast Food Line Estimation Demo", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_env_list("CORS_ORIGINS", ["http://localhost:3000", "http://127.0.0.1:3000"]),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    for processor in processors.values():
        processor.start()
    analytics_store.start(_analytics_sample_provider)


@app.on_event("shutdown")
def on_shutdown() -> None:
    analytics_store.stop()
    for processor in processors.values():
        processor.stop()


@app.get("/")
def index() -> FileResponse:
    if not FRONTEND_INDEX.exists():
        raise HTTPException(status_code=404, detail="Frontend file not found.")
    return FileResponse(FRONTEND_INDEX)


@app.get("/api/metrics")
def metrics() -> JSONResponse:
    cached = analytics_store.get_latest_metrics()
    if cached is not None:
        return JSONResponse(cached)
    return JSONResponse(_aggregate_snapshot())


@app.get("/api/metrics/{camera_id}")
def camera_metrics(camera_id: str) -> JSONResponse:
    normalized = _validate_camera_id(camera_id)
    return JSONResponse(processors[normalized].get_latest_snapshot())


@app.get("/api/recommendations")
def recommendations() -> JSONResponse:
    cached = analytics_store.get_latest_recommendation()
    if cached is not None:
        return JSONResponse(cached)

    snapshot = _aggregate_snapshot()
    return JSONResponse(_generate_recommendations(snapshot))


@app.get("/api/demo-readiness")
def demo_readiness() -> JSONResponse:
    return JSONResponse(_build_demo_readiness())


@app.get("/api/analytics/history")
def analytics_history(
    minutes: int = Query(default=60, ge=1, le=1440),
    limit: int = Query(default=3600, ge=60, le=20000),
    bucket_sec: int = Query(default=1, ge=1, le=120),
) -> JSONResponse:
    payload = analytics_store.get_history(minutes=minutes, limit=limit, bucket_sec=bucket_sec)
    return JSONResponse(payload)


@app.get("/api/analytics/live")
def analytics_live(last_id: int = Query(default=0, ge=0)) -> StreamingResponse:
    return StreamingResponse(
        analytics_store.stream_events(last_id=last_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/business-profile")
def get_business_profile() -> JSONResponse:
    with reco_lock:
        profile = recommender.get_business_profile()
    return JSONResponse(profile)


@app.post("/api/business-profile")
def update_business_profile(payload: BusinessProfilePayload) -> JSONResponse:
    with reco_lock:
        profile = _apply_business_profile(payload)
    return JSONResponse(profile)


@app.post("/api/business-profile/reset")
def reset_business_profile() -> JSONResponse:
    payload = BusinessProfilePayload.model_validate(SAMPLE_BUSINESS_PROFILE)
    with reco_lock:
        profile = _apply_business_profile(payload)
    return JSONResponse(profile)


# Backward-compatible single-source endpoints default to drive_thru.
@app.get("/api/stream-source")
def get_stream_source() -> JSONResponse:
    return JSONResponse(_stream_source_response("drive_thru"))


@app.post("/api/stream-source")
def update_stream_source(payload: StreamSourcePayload) -> JSONResponse:
    source = payload.source.strip()
    if not source:
        raise HTTPException(status_code=422, detail="source must not be empty")

    try:
        processors["drive_thru"].set_video_source(source)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return JSONResponse(_stream_source_response("drive_thru"))


@app.post("/api/stream-source/reset")
def reset_stream_source() -> JSONResponse:
    processors["drive_thru"].set_video_source(DEFAULT_CAMERA_SOURCES["drive_thru"])
    return JSONResponse(_stream_source_response("drive_thru"))


@app.get("/api/stream-sources")
def get_stream_sources() -> JSONResponse:
    return JSONResponse(_all_stream_sources_response())


@app.post("/api/stream-sources/{camera_id}")
def update_stream_source_for_camera(camera_id: str, payload: StreamSourcePayload) -> JSONResponse:
    normalized = _validate_camera_id(camera_id)
    source = payload.source.strip()
    if not source:
        raise HTTPException(status_code=422, detail="source must not be empty")

    try:
        processors[normalized].set_video_source(source)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return JSONResponse(_stream_source_response(normalized))


@app.post("/api/stream-sources/{camera_id}/reset")
def reset_stream_source_for_camera(camera_id: str) -> JSONResponse:
    normalized = _validate_camera_id(camera_id)
    processors[normalized].set_video_source(DEFAULT_CAMERA_SOURCES[normalized])
    return JSONResponse(_stream_source_response(normalized))


def _mjpeg_generator(camera_id: str) -> Generator[bytes, None, None]:
    processor = processors[camera_id]
    while True:
        jpg = processor.get_latest_jpeg()
        if jpg is None:
            time.sleep(0.1)
            continue
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
        time.sleep(0.03)


# Backward-compatible feed defaults to drive_thru.
@app.get("/video/feed")
def video_feed() -> StreamingResponse:
    return StreamingResponse(
        _mjpeg_generator("drive_thru"),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/video/feed/{camera_id}")
def video_feed_for_camera(camera_id: str) -> StreamingResponse:
    normalized = _validate_camera_id(camera_id)
    return StreamingResponse(
        _mjpeg_generator(normalized),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
