from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso_timestamp(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


class AnalyticsStore:
    def __init__(
        self,
        *,
        db_path: str | Path,
        sample_interval_sec: float = 1.0,
        memory_points: int = 7200,
    ) -> None:
        self.db_path = Path(db_path)
        self.sample_interval_sec = max(0.5, float(sample_interval_sec))
        self.memory_points = max(300, int(memory_points))

        self._history: deque[dict[str, Any]] = deque(maxlen=self.memory_points)
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._db_lock = threading.Lock()

        self._latest_id = 0
        self._latest_metrics: dict[str, Any] | None = None
        self._latest_recommendation: dict[str, Any] | None = None

        self._sample_provider: Callable[[], tuple[dict[str, Any], dict[str, Any]]] | None = None
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

        self._prepare_storage()
        self._hydrate_memory_cache()

    def start(self, sample_provider: Callable[[], tuple[dict[str, Any], dict[str, Any]]]) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._sample_provider = sample_provider
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=3.0)

    def get_latest_metrics(self) -> dict[str, Any] | None:
        with self._lock:
            if self._latest_metrics is None:
                return None
            return dict(self._latest_metrics)

    def get_latest_recommendation(self) -> dict[str, Any] | None:
        with self._lock:
            if self._latest_recommendation is None:
                return None
            return dict(self._latest_recommendation)

    def get_history(self, *, minutes: int, limit: int, bucket_sec: int) -> dict[str, Any]:
        bounded_minutes = max(1, min(1440, int(minutes)))
        bounded_limit = max(60, min(20000, int(limit)))
        bounded_bucket = max(1, min(120, int(bucket_sec)))
        since = (datetime.now(timezone.utc) - timedelta(minutes=bounded_minutes)).isoformat().replace("+00:00", "Z")

        with self._db_lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT
                        id,
                        timestamp,
                        stream_status,
                        total_customers,
                        wait_minutes,
                        trend,
                        confidence,
                        processing_fps,
                        queue_state,
                        projected_customers,
                        revenue_protected_usd,
                        wait_reduction_min
                    FROM analytics_samples
                    WHERE timestamp >= ?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (since, bounded_limit),
                ).fetchall()
            finally:
                conn.close()

        points = [self._row_to_point(row) for row in reversed(rows)]
        if bounded_bucket > 1 and points:
            points = self._bucket_points(points, bucket_sec=bounded_bucket)

        return {
            "timestamp": _utc_iso_now(),
            "window_minutes": bounded_minutes,
            "bucket_sec": bounded_bucket,
            "count": len(points),
            "points": points,
        }

    def stream_events(self, *, last_id: int = 0):
        cursor = max(0, int(last_id))
        while not self._stop_event.is_set():
            point = self._wait_for_point_after(cursor, timeout_sec=15.0)
            if point is None:
                yield ": keep-alive\n\n"
                continue

            cursor = int(point.get("id", cursor))
            payload = json.dumps(point, separators=(",", ":"))
            yield f"id: {cursor}\nevent: analytics\ndata: {payload}\n\n"

    def _run(self) -> None:
        while not self._stop_event.is_set():
            provider = self._sample_provider
            if provider is None:
                self._stop_event.wait(self.sample_interval_sec)
                continue

            try:
                metrics, recommendation = provider()
                point = self._build_point(metrics, recommendation)
                row_id = self._insert_point(point)
            except Exception as exc:  # pragma: no cover - guardrail for runtime stability
                print(f"[analytics] collector error: {exc}")
                self._stop_event.wait(self.sample_interval_sec)
                continue

            with self._condition:
                point["id"] = row_id
                self._history.append(point)
                self._latest_id = row_id
                self._latest_metrics = metrics
                self._latest_recommendation = recommendation
                self._condition.notify_all()

            self._stop_event.wait(self.sample_interval_sec)

    def _wait_for_point_after(self, point_id: int, timeout_sec: float) -> dict[str, Any] | None:
        deadline = time.monotonic() + max(0.1, timeout_sec)
        with self._condition:
            while self._latest_id <= point_id and not self._stop_event.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(timeout=remaining)

            if self._latest_id <= point_id:
                return None

            for point in reversed(self._history):
                if int(point.get("id", 0)) > point_id:
                    return dict(point)

            return None

    def _prepare_storage(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._db_lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS analytics_samples (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp TEXT NOT NULL,
                        stream_status TEXT NOT NULL,
                        total_customers REAL NOT NULL,
                        wait_minutes REAL NOT NULL,
                        trend REAL NOT NULL,
                        confidence REAL NOT NULL,
                        processing_fps REAL NOT NULL,
                        queue_state TEXT NOT NULL,
                        projected_customers REAL NOT NULL,
                        revenue_protected_usd REAL NOT NULL,
                        wait_reduction_min REAL NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_analytics_samples_timestamp
                    ON analytics_samples(timestamp)
                    """
                )
                conn.commit()
            finally:
                conn.close()

    def _hydrate_memory_cache(self) -> None:
        with self._db_lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT
                        id,
                        timestamp,
                        stream_status,
                        total_customers,
                        wait_minutes,
                        trend,
                        confidence,
                        processing_fps,
                        queue_state,
                        projected_customers,
                        revenue_protected_usd,
                        wait_reduction_min
                    FROM analytics_samples
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (self.memory_points,),
                ).fetchall()
            finally:
                conn.close()

        hydrated = [self._row_to_point(row) for row in reversed(rows)]
        with self._lock:
            self._history.clear()
            self._history.extend(hydrated)
            if hydrated:
                self._latest_id = int(hydrated[-1]["id"])

    def _insert_point(self, point: dict[str, Any]) -> int:
        with self._db_lock:
            conn = self._connect()
            try:
                cursor = conn.execute(
                    """
                    INSERT INTO analytics_samples (
                        timestamp,
                        stream_status,
                        total_customers,
                        wait_minutes,
                        trend,
                        confidence,
                        processing_fps,
                        queue_state,
                        projected_customers,
                        revenue_protected_usd,
                        wait_reduction_min
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        point["timestamp"],
                        point["stream_status"],
                        point["total_customers"],
                        point["wait_minutes"],
                        point["trend"],
                        point["confidence"],
                        point["processing_fps"],
                        point["queue_state"],
                        point["projected_customers"],
                        point["revenue_protected_usd"],
                        point["wait_reduction_min"],
                    ),
                )
                conn.commit()
                return int(cursor.lastrowid or 0)
            finally:
                conn.close()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.db_path), timeout=30.0)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _build_point(metrics: dict[str, Any], recommendation: dict[str, Any]) -> dict[str, Any]:
        return {
            "timestamp": str(metrics.get("timestamp", _utc_iso_now())),
            "stream_status": str(metrics.get("stream_status", "initializing")),
            "total_customers": float(metrics.get("aggregates", {}).get("total_customers", 0.0) or 0.0),
            "wait_minutes": float(metrics.get("aggregates", {}).get("estimated_wait_time_min", 0.0) or 0.0),
            "trend": float(recommendation.get("forecast", {}).get("trend_customers_per_min", 0.0) or 0.0),
            "confidence": float(recommendation.get("forecast", {}).get("confidence", 0.0) or 0.0),
            "processing_fps": float(metrics.get("performance", {}).get("processing_fps", 0.0) or 0.0),
            "queue_state": str(recommendation.get("forecast", {}).get("queue_state", "unknown")),
            "projected_customers": float(recommendation.get("forecast", {}).get("projected_customers", 0.0) or 0.0),
            "revenue_protected_usd": float(recommendation.get("impact", {}).get("estimated_revenue_protected_usd", 0.0) or 0.0),
            "wait_reduction_min": float(recommendation.get("impact", {}).get("estimated_wait_reduction_min", 0.0) or 0.0),
        }

    @staticmethod
    def _row_to_point(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "timestamp": str(row["timestamp"]),
            "stream_status": str(row["stream_status"]),
            "total_customers": float(row["total_customers"]),
            "wait_minutes": float(row["wait_minutes"]),
            "trend": float(row["trend"]),
            "confidence": float(row["confidence"]),
            "processing_fps": float(row["processing_fps"]),
            "queue_state": str(row["queue_state"]),
            "projected_customers": float(row["projected_customers"]),
            "revenue_protected_usd": float(row["revenue_protected_usd"]),
            "wait_reduction_min": float(row["wait_reduction_min"]),
        }

    @staticmethod
    def _bucket_points(points: list[dict[str, Any]], *, bucket_sec: int) -> list[dict[str, Any]]:
        buckets: dict[int, dict[str, Any]] = {}

        for point in points:
            ts = _parse_iso_timestamp(str(point.get("timestamp")))
            epoch = int(ts.timestamp())
            bucket_epoch = epoch - (epoch % bucket_sec)
            bucket = buckets.get(bucket_epoch)
            if bucket is None:
                bucket = {
                    "id": int(point.get("id", 0)),
                    "timestamp": datetime.fromtimestamp(bucket_epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
                    "stream_status": point.get("stream_status", "initializing"),
                    "total_customers_sum": 0.0,
                    "wait_minutes_sum": 0.0,
                    "trend_sum": 0.0,
                    "confidence_sum": 0.0,
                    "processing_fps_sum": 0.0,
                    "projected_customers_sum": 0.0,
                    "revenue_protected_usd_sum": 0.0,
                    "wait_reduction_min_sum": 0.0,
                    "count": 0,
                    "queue_state": point.get("queue_state", "unknown"),
                }
                buckets[bucket_epoch] = bucket

            bucket["id"] = max(int(bucket["id"]), int(point.get("id", 0)))
            bucket["stream_status"] = point.get("stream_status", bucket["stream_status"])
            bucket["queue_state"] = point.get("queue_state", bucket["queue_state"])
            bucket["total_customers_sum"] += float(point.get("total_customers", 0.0) or 0.0)
            bucket["wait_minutes_sum"] += float(point.get("wait_minutes", 0.0) or 0.0)
            bucket["trend_sum"] += float(point.get("trend", 0.0) or 0.0)
            bucket["confidence_sum"] += float(point.get("confidence", 0.0) or 0.0)
            bucket["processing_fps_sum"] += float(point.get("processing_fps", 0.0) or 0.0)
            bucket["projected_customers_sum"] += float(point.get("projected_customers", 0.0) or 0.0)
            bucket["revenue_protected_usd_sum"] += float(point.get("revenue_protected_usd", 0.0) or 0.0)
            bucket["wait_reduction_min_sum"] += float(point.get("wait_reduction_min", 0.0) or 0.0)
            bucket["count"] += 1

        aggregated: list[dict[str, Any]] = []
        for bucket_epoch in sorted(buckets.keys()):
            bucket = buckets[bucket_epoch]
            count = max(1, int(bucket["count"]))
            aggregated.append(
                {
                    "id": int(bucket["id"]),
                    "timestamp": str(bucket["timestamp"]),
                    "stream_status": str(bucket["stream_status"]),
                    "total_customers": round(float(bucket["total_customers_sum"]) / count, 2),
                    "wait_minutes": round(float(bucket["wait_minutes_sum"]) / count, 2),
                    "trend": round(float(bucket["trend_sum"]) / count, 3),
                    "confidence": round(float(bucket["confidence_sum"]) / count, 3),
                    "processing_fps": round(float(bucket["processing_fps_sum"]) / count, 2),
                    "queue_state": str(bucket["queue_state"]),
                    "projected_customers": round(float(bucket["projected_customers_sum"]) / count, 2),
                    "revenue_protected_usd": round(float(bucket["revenue_protected_usd_sum"]) / count, 2),
                    "wait_reduction_min": round(float(bucket["wait_reduction_min_sum"]) / count, 2),
                }
            )

        return aggregated
