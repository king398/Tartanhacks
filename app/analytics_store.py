from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

LOGGER = logging.getLogger(__name__)


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

    def record_feedback(
        self,
        *,
        timestamp: str,
        item_key: str,
        item_label: str,
        action: str,
        note: str | None,
        recommended_units: int,
        chosen_units: int,
        baseline_units: int,
        max_unit_size: int,
        unit_cost_usd: float,
        units_per_order: float,
        forecast_horizon_min: float,
        projected_customers: float,
        queue_state: str,
        avg_ticket_usd: float,
    ) -> dict[str, Any]:
        cleaned_timestamp = str(timestamp or _utc_iso_now())
        cleaned_note = (note or "").strip() or None

        bounded_recommended = max(0, int(recommended_units))
        bounded_chosen = max(0, int(chosen_units))
        bounded_baseline = max(0, int(baseline_units))
        bounded_max = max(1, int(max_unit_size))

        bounded_recommended = min(bounded_recommended, bounded_max)
        bounded_chosen = min(bounded_chosen, bounded_max)
        bounded_baseline = min(bounded_baseline, bounded_max)

        expected_waste_avoided_units = float(max(0, bounded_baseline - bounded_chosen))
        expected_cost_saved_usd = expected_waste_avoided_units * max(0.0, float(unit_cost_usd))

        payload = {
            "timestamp": cleaned_timestamp,
            "item_key": str(item_key),
            "item_label": str(item_label),
            "action": str(action),
            "note": cleaned_note,
            "recommended_units": bounded_recommended,
            "chosen_units": bounded_chosen,
            "baseline_units": bounded_baseline,
            "max_unit_size": bounded_max,
            "unit_cost_usd": max(0.0, float(unit_cost_usd)),
            "units_per_order": max(0.01, float(units_per_order)),
            "forecast_horizon_min": max(0.5, float(forecast_horizon_min)),
            "projected_customers": max(0.0, float(projected_customers)),
            "queue_state": str(queue_state or "unknown"),
            "avg_ticket_usd": max(0.0, float(avg_ticket_usd)),
            "expected_cost_saved_usd": float(expected_cost_saved_usd),
            "expected_waste_avoided_units": float(expected_waste_avoided_units),
        }

        with self._db_lock:
            conn = self._connect()
            try:
                self._evaluate_feedback_outcomes(conn=conn)
                cursor = conn.execute(
                    """
                    INSERT INTO recommendation_feedback (
                        timestamp,
                        item_key,
                        item_label,
                        action,
                        note,
                        recommended_units,
                        chosen_units,
                        baseline_units,
                        max_unit_size,
                        unit_cost_usd,
                        units_per_order,
                        forecast_horizon_min,
                        projected_customers,
                        queue_state,
                        avg_ticket_usd,
                        expected_cost_saved_usd,
                        expected_waste_avoided_units,
                        outcome_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload["timestamp"],
                        payload["item_key"],
                        payload["item_label"],
                        payload["action"],
                        payload["note"],
                        payload["recommended_units"],
                        payload["chosen_units"],
                        payload["baseline_units"],
                        payload["max_unit_size"],
                        payload["unit_cost_usd"],
                        payload["units_per_order"],
                        payload["forecast_horizon_min"],
                        payload["projected_customers"],
                        payload["queue_state"],
                        payload["avg_ticket_usd"],
                        payload["expected_cost_saved_usd"],
                        payload["expected_waste_avoided_units"],
                        "pending",
                    ),
                )
                conn.commit()
                row_id = int(cursor.lastrowid or 0)
            finally:
                conn.close()

        return {
            "id": row_id,
            **payload,
            "outcome_status": "pending",
            "evaluated_at": None,
            "actual_customers": None,
            "forecast_error_customers": None,
            "realized_waste_delta_units": None,
            "realized_cost_delta_usd": None,
            "realized_revenue_delta_usd": None,
        }

    def get_feedback_summary(self, *, minutes: int, limit: int) -> dict[str, Any]:
        bounded_minutes = max(5, min(10080, int(minutes)))
        bounded_limit = max(10, min(2000, int(limit)))
        since = (datetime.now(timezone.utc) - timedelta(minutes=bounded_minutes)).isoformat().replace("+00:00", "Z")

        with self._db_lock:
            conn = self._connect()
            try:
                self._evaluate_feedback_outcomes(conn=conn)
                rows = conn.execute(
                    """
                    SELECT
                        id,
                        timestamp,
                        item_key,
                        item_label,
                        action,
                        note,
                        recommended_units,
                        chosen_units,
                        baseline_units,
                        max_unit_size,
                        unit_cost_usd,
                        units_per_order,
                        forecast_horizon_min,
                        projected_customers,
                        queue_state,
                        avg_ticket_usd,
                        expected_cost_saved_usd,
                        expected_waste_avoided_units,
                        outcome_status,
                        evaluated_at,
                        actual_customers,
                        forecast_error_customers,
                        realized_waste_delta_units,
                        realized_cost_delta_usd,
                        realized_revenue_delta_usd
                    FROM recommendation_feedback
                    WHERE timestamp >= ?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (since, bounded_limit),
                ).fetchall()
            finally:
                conn.close()

        events = [self._feedback_row_to_dict(row) for row in rows]

        accepted = sum(1 for event in events if event["action"] == "accept")
        overridden = sum(1 for event in events if event["action"] == "override")
        ignored = sum(1 for event in events if event["action"] == "ignore")
        total_actions = len(events)
        adopted_actions = accepted + overridden
        adoption_rate = (adopted_actions / total_actions) if total_actions else 0.0

        expected_cost_saved_usd = sum(float(event["expected_cost_saved_usd"]) for event in events)
        expected_waste_avoided_units = sum(float(event["expected_waste_avoided_units"]) for event in events)

        evaluated_events = [event for event in events if event["outcome_status"] == "evaluated"]
        pending_events = [event for event in events if event["outcome_status"] == "pending"]
        insufficient_events = [event for event in events if event["outcome_status"] == "insufficient_data"]

        realized_cost_delta_usd = sum(float(event["realized_cost_delta_usd"] or 0.0) for event in evaluated_events)
        realized_waste_delta_units = sum(float(event["realized_waste_delta_units"] or 0.0) for event in evaluated_events)
        realized_revenue_delta_usd = sum(float(event["realized_revenue_delta_usd"] or 0.0) for event in evaluated_events)

        forecast_errors = [
            float(event["forecast_error_customers"])
            for event in evaluated_events
            if event["forecast_error_customers"] is not None
        ]
        forecast_mae_customers = (
            sum(abs(value) for value in forecast_errors) / len(forecast_errors)
            if forecast_errors
            else 0.0
        )
        forecast_bias_customers = (sum(forecast_errors) / len(forecast_errors)) if forecast_errors else 0.0

        realized_vs_expected_ratio = 0.0
        if abs(expected_cost_saved_usd) > 1e-6:
            realized_vs_expected_ratio = realized_cost_delta_usd / expected_cost_saved_usd

        if forecast_bias_customers > 0.2:
            prediction_direction = "under-predicting"
        elif forecast_bias_customers < -0.2:
            prediction_direction = "over-predicting"
        else:
            prediction_direction = "well-calibrated"

        return {
            "timestamp": _utc_iso_now(),
            "window_minutes": bounded_minutes,
            "count": total_actions,
            "adoption": {
                "accepted": accepted,
                "overridden": overridden,
                "ignored": ignored,
                "adopted": adopted_actions,
                "adoption_rate": round(adoption_rate, 4),
            },
            "outcomes": {
                "evaluated": len(evaluated_events),
                "pending": len(pending_events),
                "insufficient_data": len(insufficient_events),
                "expected_cost_saved_usd": round(expected_cost_saved_usd, 2),
                "realized_cost_delta_usd": round(realized_cost_delta_usd, 2),
                "expected_waste_avoided_units": round(expected_waste_avoided_units, 2),
                "realized_waste_delta_units": round(realized_waste_delta_units, 2),
                "realized_revenue_delta_usd": round(realized_revenue_delta_usd, 2),
                "realized_vs_expected_ratio": round(realized_vs_expected_ratio, 3),
            },
            "prediction_impact": {
                "forecast_mae_customers": round(forecast_mae_customers, 3),
                "forecast_bias_customers": round(forecast_bias_customers, 3),
                "direction": prediction_direction,
            },
            "events": events,
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
                LOGGER.exception("Analytics collector error: %s", exc)
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

            for point in self._history:
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

                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS recommendation_feedback (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp TEXT NOT NULL,
                        item_key TEXT NOT NULL,
                        item_label TEXT NOT NULL,
                        action TEXT NOT NULL,
                        note TEXT,
                        recommended_units INTEGER NOT NULL,
                        chosen_units INTEGER NOT NULL,
                        baseline_units INTEGER NOT NULL,
                        max_unit_size INTEGER NOT NULL,
                        unit_cost_usd REAL NOT NULL,
                        units_per_order REAL NOT NULL,
                        forecast_horizon_min REAL NOT NULL,
                        projected_customers REAL NOT NULL,
                        queue_state TEXT NOT NULL,
                        avg_ticket_usd REAL NOT NULL,
                        expected_cost_saved_usd REAL NOT NULL,
                        expected_waste_avoided_units REAL NOT NULL,
                        outcome_status TEXT NOT NULL DEFAULT 'pending',
                        evaluated_at TEXT,
                        actual_customers REAL,
                        forecast_error_customers REAL,
                        realized_waste_delta_units REAL,
                        realized_cost_delta_usd REAL,
                        realized_revenue_delta_usd REAL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_feedback_timestamp
                    ON recommendation_feedback(timestamp)
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_feedback_outcome_status
                    ON recommendation_feedback(outcome_status)
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

    def _evaluate_feedback_outcomes(self, *, conn: sqlite3.Connection) -> None:
        now = datetime.now(timezone.utc)
        pending_rows = conn.execute(
            """
            SELECT
                id,
                timestamp,
                baseline_units,
                chosen_units,
                units_per_order,
                unit_cost_usd,
                avg_ticket_usd,
                forecast_horizon_min,
                projected_customers
            FROM recommendation_feedback
            WHERE outcome_status = 'pending'
            ORDER BY id ASC
            LIMIT 1000
            """
        ).fetchall()

        if not pending_rows:
            return

        for row in pending_rows:
            feedback_timestamp = _parse_iso_timestamp(str(row["timestamp"]))
            horizon_min = max(0.5, float(row["forecast_horizon_min"] or 0.0))
            evaluation_cutoff = feedback_timestamp + timedelta(minutes=horizon_min)

            if now < evaluation_cutoff:
                continue

            start_iso = feedback_timestamp.isoformat().replace("+00:00", "Z")
            end_iso = evaluation_cutoff.isoformat().replace("+00:00", "Z")

            sample = conn.execute(
                """
                SELECT
                    AVG(total_customers) AS avg_customers,
                    COUNT(*) AS sample_count
                FROM analytics_samples
                WHERE timestamp >= ?
                  AND timestamp <= ?
                  AND stream_status IN ('ok', 'degraded')
                """,
                (start_iso, end_iso),
            ).fetchone()

            sample_count = int(sample["sample_count"] or 0)
            evaluated_at = _utc_iso_now()

            if sample_count <= 0:
                conn.execute(
                    """
                    UPDATE recommendation_feedback
                    SET outcome_status = 'insufficient_data',
                        evaluated_at = ?
                    WHERE id = ?
                    """,
                    (evaluated_at, int(row["id"])),
                )
                continue

            actual_customers = float(sample["avg_customers"] or 0.0)
            projected_customers = float(row["projected_customers"] or 0.0)
            forecast_error_customers = actual_customers - projected_customers

            units_per_order = max(0.01, float(row["units_per_order"] or 0.01))
            unit_cost_usd = max(0.0, float(row["unit_cost_usd"] or 0.0))
            avg_ticket_usd = max(0.0, float(row["avg_ticket_usd"] or 0.0))

            baseline_units = max(0, int(row["baseline_units"] or 0))
            chosen_units = max(0, int(row["chosen_units"] or 0))

            required_units = max(0, int(round(actual_customers * units_per_order)))
            baseline_overproduction = max(0, baseline_units - required_units)
            chosen_overproduction = max(0, chosen_units - required_units)

            realized_waste_delta_units = float(baseline_overproduction - chosen_overproduction)
            realized_cost_delta_usd = realized_waste_delta_units * unit_cost_usd

            baseline_shortfall = max(0, required_units - baseline_units)
            chosen_shortfall = max(0, required_units - chosen_units)
            shortfall_delta_units = float(baseline_shortfall - chosen_shortfall)
            realized_revenue_delta_usd = (shortfall_delta_units / units_per_order) * avg_ticket_usd

            conn.execute(
                """
                UPDATE recommendation_feedback
                SET outcome_status = 'evaluated',
                    evaluated_at = ?,
                    actual_customers = ?,
                    forecast_error_customers = ?,
                    realized_waste_delta_units = ?,
                    realized_cost_delta_usd = ?,
                    realized_revenue_delta_usd = ?
                WHERE id = ?
                """,
                (
                    evaluated_at,
                    actual_customers,
                    forecast_error_customers,
                    realized_waste_delta_units,
                    realized_cost_delta_usd,
                    realized_revenue_delta_usd,
                    int(row["id"]),
                ),
            )

        conn.commit()

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
    def _feedback_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "timestamp": str(row["timestamp"]),
            "item_key": str(row["item_key"]),
            "item_label": str(row["item_label"]),
            "action": str(row["action"]),
            "note": str(row["note"]) if row["note"] is not None else None,
            "recommended_units": int(row["recommended_units"]),
            "chosen_units": int(row["chosen_units"]),
            "baseline_units": int(row["baseline_units"]),
            "max_unit_size": int(row["max_unit_size"]),
            "unit_cost_usd": float(row["unit_cost_usd"]),
            "units_per_order": float(row["units_per_order"]),
            "forecast_horizon_min": float(row["forecast_horizon_min"]),
            "projected_customers": float(row["projected_customers"]),
            "queue_state": str(row["queue_state"]),
            "avg_ticket_usd": float(row["avg_ticket_usd"]),
            "expected_cost_saved_usd": float(row["expected_cost_saved_usd"]),
            "expected_waste_avoided_units": float(row["expected_waste_avoided_units"]),
            "outcome_status": str(row["outcome_status"]),
            "evaluated_at": str(row["evaluated_at"]) if row["evaluated_at"] is not None else None,
            "actual_customers": float(row["actual_customers"]) if row["actual_customers"] is not None else None,
            "forecast_error_customers": (
                float(row["forecast_error_customers"]) if row["forecast_error_customers"] is not None else None
            ),
            "realized_waste_delta_units": (
                float(row["realized_waste_delta_units"]) if row["realized_waste_delta_units"] is not None else None
            ),
            "realized_cost_delta_usd": (
                float(row["realized_cost_delta_usd"]) if row["realized_cost_delta_usd"] is not None else None
            ),
            "realized_revenue_delta_usd": (
                float(row["realized_revenue_delta_usd"]) if row["realized_revenue_delta_usd"] is not None else None
            ),
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
