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
- `GET /api/recommendations`: dynamic batch recommendations + business impact estimates.
- `GET /api/stream-source`: active/default backend video source.
- `POST /api/stream-source`: switch to a new file path or stream URL at runtime.
- `POST /api/stream-source/reset`: restore the default source from `VIDEO_PATH`.
- `GET /video/feed`: MJPEG annotated stream.

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
      "recommended_batches": 3,
      "baseline_batches": 2,
      "delta_batches": 1,
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
- `http://localhost:3000/analytics`

Use **Custom Stream Source** on the dashboard to switch to your own live stream without restarting the backend.

## Key Environment Variables

- `VIDEO_PATH`: input video path.
- `YOLO_MODEL`: default `yolo26m.pt`.
- `YOLO_DEVICE`: `auto`, `0`, `cuda:0`, or `cpu`.
- `SAMPLE_FPS`: processed frames/sec (default `30`).
- `IMG_SIZE`: model input image size (default `640`).
- `CORS_ORIGINS`: allowed frontend origins (default includes `localhost:3000`).
- `RECO_FORECAST_HORIZON_MIN`: recommendation forecast window.
- `RECO_DROP_CADENCE_MIN`: recommendation cadence assumption.
- `AVG_TICKET_USD`: used for directional revenue impact estimate.

## Notes

- Recommendation outputs are decision-support heuristics, not guaranteed forecasts.
- Business impact values are directional estimates for ops planning.
- GPU use can be checked via `inference_device` from `/api/metrics`.
