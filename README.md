# Fast Food Line Estimation Demo

This repo contains a working MVP for your architecture using **Ultralytics YOLO** (latest package), MP4 input, and a simple frontend dashboard.

Pipeline implemented:
`MP4 Input -> ROI filtering -> YOLO detection + ByteTrack tracking -> queue aggregation -> REST + live frontend`

## What You Get

- `app/pipeline.py`: Video processor using Ultralytics `YOLO(...).track(...)`
- `app/main.py`: FastAPI server with:
  - `GET /video/feed` (MJPEG annotated stream)
  - `GET /api/metrics` (JSON queue metrics)
  - `GET /` (dashboard frontend)
- `frontend/index.html`: Demo UI showing stream + live counts/wait-time

## Metrics Produced

```json
{
  "timestamp": "2026-02-06T18:30:00Z",
  "drive_thru": {
    "car_count": 5,
    "est_passengers": 7.5
  },
  "in_store": {
    "person_count": 3
  },
  "aggregates": {
    "total_customers": 10.5,
    "avg_service_time_sec": 45.0,
    "estimated_wait_time_min": 7.9
  },
  "frame_number": 120,
  "inference_device": "0",
  "performance": {
    "processing_fps": 18.4
  }
}
```

## Quick Start

1. Install dependencies:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. Place your demo video in project root (example: `sample.mp4`).
3. Configure environment:
   ```bash
   cp .env.example .env
   ```
4. Run server:
   ```bash
   export $(grep -v '^#' .env | xargs)
   uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```
5. Open:
   - `http://localhost:8000/`

## Config (Environment Variables)

- `VIDEO_PATH`: input mp4 path
- `YOLO_MODEL`: default `yolo26m.pt`
- `YOLO_DEVICE`: `auto` (uses CUDA if available), or set `0`, `cuda:0`, or `cpu`
- `SAMPLE_FPS`: processed frames/sec (default `30`)
- `CONF_THRESHOLD`, `IOU_THRESHOLD`, `IMG_SIZE`
- `PEOPLE_PER_CAR`: heuristic multiplier for drive-thru
- `AVG_SERVICE_TIME_SEC`: average order completion time
- `DRIVE_THRU_ROI`: normalized ROI (`x1,y1,x2,y2`)
- `IN_STORE_ROI`: normalized ROI (`x1,y1,x2,y2`)

## Notes

- This is an MVP occupancy estimator, not a production billing/counting system.
- Wait time is heuristic in this version: `total_customers * avg_service_time_sec / 60`.
- Tracking is done with ByteTrack via Ultralytics.
- Dashboard/API expose `inference_device` so you can verify GPU usage at runtime.
