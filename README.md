# Fast Food Queue Intelligence Demo

This project is a real-time AI decision-support system for fast-food operations.

Pipeline:
`Video Feed -> YOLO + ByteTrack -> Queue Metrics -> Recommendation Engine -> Ops Dashboard`

## Core Components

- `app/pipeline.py`: CV pipeline for drive-thru vehicle counting and in-store person counting.
- `app/recommendations.py`: Trend-aware production recommendation engine.
- `app/main.py`: FastAPI service exposing metrics, recommendations, and MJPEG video stream.
- `frontend/index.html`: Legacy single-file dashboard served by FastAPI `/`.
- `web/`: Next.js + Tailwind + TypeScript dashboard (recommended UI).

## API Endpoints

- `GET /api/metrics`: real-time queue and performance metrics.
- `GET /api/metrics/{camera_id}`: per-camera metrics (`drive_thru`, `in_store`).
- `GET /api/recommendations`: dynamic unit-level recommendations + business impact estimates.
- `GET /api/demo-readiness`: live readiness score + pass/warn/fail checks for judging/demo reliability.
- `GET /api/analytics/history`: persisted analytics history for charts (`minutes`, `limit`, `bucket_sec` query params).
- `GET /api/analytics/live`: Server-Sent Events stream for live analytics updates.
- `GET /api/business-profile`: active business identity + menu profile used by recommendations.
- `POST /api/business-profile`: update business profile and menu items.
- `POST /api/business-profile/reset`: restore built-in sample business profile.
- `GET /api/stream-source`: active/default backend video source.
- `POST /api/stream-source`: switch to a new file path or stream URL at runtime.
- `POST /api/stream-source/reset`: restore the default source from `VIDEO_PATH`.
- `GET /api/stream-sources`: active/default stream sources for all cameras.
- `POST /api/stream-sources/{camera_id}`: update stream source for one camera.
- `POST /api/stream-sources/{camera_id}/reset`: reset one camera stream source.
- `GET /video/feed`: MJPEG annotated stream.
- `GET /video/feed/{camera_id}`: MJPEG stream for one camera.

Note: `GET /api/stream-source` and `GET /video/feed` are backward-compatible aliases for the `drive_thru` camera.

### Example `GET /api/recommendations` Response

```json
{
  "forecast": {
    "horizon_min": 8.0,
    "queue_state": "surging",
    "trend_customers_per_min": 1.15,
    "current_customers": 11.0,
    "projected_customers": 19.3,
    "confidence": 0.83
  },
  "recommendations": [
    {
      "item": "fillets",
      "unit_label": "fillets",
      "recommended_units": 19,
      "baseline_units": 16,
      "delta_units": 3,
      "urgency": "high"
    }
  ],
  "impact": {
    "estimated_wait_reduction_min": 2.1,
    "estimated_waste_avoided_units": 6.8,
    "estimated_cost_saved_usd": 4.23,
    "estimated_revenue_protected_usd": 11.74
  }
}
```

## Quick Start

### 1. Backend (FastAPI + YOLO)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a; source .env; set +a
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Backend URLs:
- `http://localhost:8000/api/metrics`
- `http://localhost:8000/api/recommendations`
- `http://localhost:8000/video/feed`
- `http://localhost:8000/` (legacy frontend)

### 2. Frontend (Next.js + Tailwind + TypeScript)

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev
```

Next.js dashboard URL:
- `http://localhost:3000`
- `http://localhost:3000/judge-brief`
- `http://localhost:3000/analytics`
- `http://localhost:3000/business-profile`

Use **Custom Stream Source** on the dashboard to switch to your own live stream without restarting the backend.
You can provide RTSP/HTTP URLs, local file paths, or a webcam index like `0`.

Use **Business Profile & Menu** on the dashboard to customize your business name, ticket assumptions, and menu items.
Recommendations and impact values update from this profile, including per-item unit labels (for example `cups`, `fillets`, `strips`), and you can reset to a sample business with one click.

## Key Environment Variables

- `VIDEO_PATH`: input video path.
- `YOLO_MODEL`: default `yolo26m.pt` (larger/more accurate).
- `YOLO_DEVICE`: default `cuda:0` to target GPU (also supports `auto`, `0`, or `cpu`).
- `DRIVE_THRU_VIDEO_PATH`: optional source override for drive-thru camera.
- `IN_STORE_VIDEO_PATH`: optional source override for in-store camera (defaults to `sample1.mp4`).
- `SAMPLE_FPS`: processed frames/sec (default `30`).
- `IMG_SIZE`: model input image size (default `960`).
- `DRIVE_THRU_CONF_THRESHOLD`: optional confidence override for drive-thru detections.
- `IN_STORE_CONF_THRESHOLD`: optional confidence override for in-store person detections (default `0.15`).
- `CORS_ORIGINS`: allowed frontend origins (default includes `localhost:3000`).
- `RECO_FORECAST_HORIZON_MIN`: recommendation forecast window.
- `RECO_DROP_CADENCE_MIN`: recommendation cadence assumption.
- `RECO_DECISION_INTERVAL_SEC`: decision refresh interval (default `30` seconds).
- `RECO_COOK_TIME_SEC`: assumed fryer-to-ready cook time for inventory tracking (default `RECO_DROP_CADENCE_MIN * 60`).
- `AVG_TICKET_USD`: used for directional revenue impact estimate.
- `ANALYTICS_DB_PATH`: SQLite path for persisted analytics history (default `analytics.db` in repo root).
- `ANALYTICS_SAMPLE_INTERVAL_SEC`: background analytics sample cadence (default `1.0` sec).
- `ANALYTICS_MEMORY_POINTS`: in-memory rolling analytics cache size (default `7200` points).

## Notes

- Recommendation outputs are decision-support heuristics, not guaranteed forecasts.
- Business impact values are directional estimates for ops planning.
- GPU use can be checked via `inference_device` from `/api/metrics`.
