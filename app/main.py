from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Generator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from app.pipeline import VideoProcessor
from app.recommendations import ItemProfile, RecommendationEngine


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_INDEX = BASE_DIR / "frontend" / "index.html"
DEFAULT_VIDEO_SOURCE = os.getenv("VIDEO_PATH", str(BASE_DIR / "sample.mp4"))


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


class StreamSourcePayload(BaseModel):
    source: str


class MenuItemPayload(BaseModel):
    key: str | None = Field(default=None, max_length=64)
    label: str = Field(min_length=1, max_length=80)
    units_per_order: float = Field(gt=0.0, le=10.0)
    batch_size: int = Field(ge=1, le=500)
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
            "baseline_drop_units": 16,
            "unit_cost_usd": 0.92,
        },
        {
            "key": "nuggets",
            "label": "Nuggets",
            "units_per_order": 0.36,
            "batch_size": 6,
            "baseline_drop_units": 12,
            "unit_cost_usd": 0.68,
        },
        {
            "key": "fries",
            "label": "Fries",
            "units_per_order": 0.72,
            "batch_size": 10,
            "baseline_drop_units": 18,
            "unit_cost_usd": 0.44,
        },
        {
            "key": "strips",
            "label": "Strips",
            "units_per_order": 0.15,
            "batch_size": 8,
            "baseline_drop_units": 8,
            "unit_cost_usd": 0.86,
        },
    ],
}


processor = VideoProcessor(
    video_path=DEFAULT_VIDEO_SOURCE,
    model_name=os.getenv("YOLO_MODEL", "yolo26m.pt"),
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
recommender = RecommendationEngine()
reco_lock = threading.Lock()


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


def _stream_source_response() -> dict[str, str]:
    return {
        "source": processor.get_video_source(),
        "default_source": DEFAULT_VIDEO_SOURCE,
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


@app.get("/api/recommendations")
def recommendations() -> JSONResponse:
    snapshot = processor.get_latest_snapshot()
    with reco_lock:
        response = recommender.generate(snapshot)
    return JSONResponse(response)


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


@app.get("/api/stream-source")
def get_stream_source() -> JSONResponse:
    return JSONResponse(_stream_source_response())


@app.post("/api/stream-source")
def update_stream_source(payload: StreamSourcePayload) -> JSONResponse:
    source = payload.source.strip()
    if not source:
        raise HTTPException(status_code=422, detail="source must not be empty")

    try:
        processor.set_video_source(source)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return JSONResponse(_stream_source_response())


@app.post("/api/stream-source/reset")
def reset_stream_source() -> JSONResponse:
    processor.set_video_source(DEFAULT_VIDEO_SOURCE)
    return JSONResponse(_stream_source_response())


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
