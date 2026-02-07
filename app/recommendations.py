from __future__ import annotations

import math
import os
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class ItemProfile:
    key: str
    label: str
    units_per_order: float
    batch_size: int
    baseline_drop_units: int
    unit_cost_usd: float


class RecommendationEngine:
    def __init__(self) -> None:
        self._history: deque[tuple[datetime, float]] = deque(maxlen=90)
        self.forecast_horizon_min = self._env_float("RECO_FORECAST_HORIZON_MIN", 8.0)
        self.drop_cadence_min = self._env_float("RECO_DROP_CADENCE_MIN", 4.0)
        self.avg_ticket_usd = self._env_float("AVG_TICKET_USD", 10.5)

        self.item_profiles: tuple[ItemProfile, ...] = (
            ItemProfile(
                key="fillets",
                label="Chicken Fillets",
                units_per_order=0.58,
                batch_size=8,
                baseline_drop_units=16,
                unit_cost_usd=0.92,
            ),
            ItemProfile(
                key="nuggets",
                label="Nuggets",
                units_per_order=0.36,
                batch_size=6,
                baseline_drop_units=12,
                unit_cost_usd=0.68,
            ),
            ItemProfile(
                key="fries",
                label="Fries",
                units_per_order=0.72,
                batch_size=10,
                baseline_drop_units=18,
                unit_cost_usd=0.44,
            ),
            ItemProfile(
                key="strips",
                label="Strips",
                units_per_order=0.15,
                batch_size=8,
                baseline_drop_units=8,
                unit_cost_usd=0.86,
            ),
        )

    @staticmethod
    def _env_float(name: str, default: float) -> float:
        value = os.getenv(name)
        if value is None:
            return default
        try:
            return float(value)
        except ValueError:
            return default

    @staticmethod
    def _parse_timestamp(value: str | None) -> datetime:
        if not value:
            return datetime.now(timezone.utc)
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(timezone.utc)

    @staticmethod
    def _clamp(value: float, lower: float, upper: float) -> float:
        return max(lower, min(upper, value))

    def _trend_per_min(self) -> float:
        if len(self._history) < 2:
            return 0.0

        oldest_t, oldest_customers = self._history[0]
        newest_t, newest_customers = self._history[-1]
        delta_min = (newest_t - oldest_t).total_seconds() / 60.0
        if delta_min <= 0:
            return 0.0

        return (newest_customers - oldest_customers) / delta_min

    def _state_from_trend(self, trend_per_min: float) -> str:
        if trend_per_min >= 0.85:
            return "surging"
        if trend_per_min <= -0.75:
            return "falling"
        return "steady"

    def _confidence(self, processing_fps: float) -> float:
        history_factor = self._clamp(len(self._history) / 18.0, 0.0, 1.0)
        fps_factor = self._clamp(processing_fps / 15.0, 0.0, 1.0)
        return round(self._clamp(0.45 + (0.35 * history_factor) + (0.2 * fps_factor), 0.45, 0.95), 2)

    def _build_unavailable_response(
        self,
        *,
        current_customers: float,
        current_wait: float,
        stream_error: str | None,
    ) -> dict[str, Any]:
        recommendations = []
        for profile in self.item_profiles:
            baseline_batches = math.ceil(profile.baseline_drop_units / profile.batch_size)
            baseline_units = baseline_batches * profile.batch_size
            recommendations.append(
                {
                    "item": profile.key,
                    "label": profile.label,
                    "recommended_batches": baseline_batches,
                    "recommended_units": baseline_units,
                    "baseline_batches": baseline_batches,
                    "baseline_units": baseline_units,
                    "delta_batches": 0,
                    "urgency": "low",
                    "reason": "Live stream is unavailable; holding baseline plan until frames are flowing.",
                }
            )

        notes = [
            "Recommendations are generated for the next cook cycle.",
            "Business impact values are directional estimates for decision support.",
        ]
        if stream_error:
            notes.append(f"Stream issue: {stream_error}")

        return {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "forecast": {
                "horizon_min": round(self.forecast_horizon_min, 1),
                "queue_state": "unavailable",
                "trend_customers_per_min": 0.0,
                "current_customers": round(current_customers, 1),
                "projected_customers": round(current_customers, 1),
                "confidence": 0.45,
            },
            "recommendations": recommendations,
            "impact": {
                "estimated_wait_reduction_min": 0.0,
                "estimated_waste_avoided_units": 0.0,
                "estimated_cost_saved_usd": 0.0,
                "estimated_revenue_protected_usd": 0.0,
                "current_wait_time_min": round(current_wait, 1),
            },
            "assumptions": {
                "drop_cadence_min": round(self.drop_cadence_min, 1),
                "avg_ticket_usd": round(self.avg_ticket_usd, 2),
                "notes": notes,
            },
        }

    def generate(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        timestamp = self._parse_timestamp(snapshot.get("timestamp"))
        current_customers = float(snapshot.get("aggregates", {}).get("total_customers", 0.0) or 0.0)
        current_wait = float(snapshot.get("aggregates", {}).get("estimated_wait_time_min", 0.0) or 0.0)
        processing_fps = float(snapshot.get("performance", {}).get("processing_fps", 0.0) or 0.0)
        stream_status = str(snapshot.get("stream_status", "ok")).lower()
        stream_error = snapshot.get("stream_error")

        if stream_status != "ok":
            return self._build_unavailable_response(
                current_customers=current_customers,
                current_wait=current_wait,
                stream_error=str(stream_error) if stream_error else None,
            )

        self._history.append((timestamp, current_customers))

        trend_per_min = self._trend_per_min()
        queue_state = self._state_from_trend(trend_per_min)
        trend_boost = 0.9 if queue_state == "surging" else 0.7 if queue_state == "steady" else 0.5
        projected_customers = max(0.0, current_customers + (trend_per_min * self.forecast_horizon_min * trend_boost))

        safety_ratio = 0.35 if queue_state == "surging" else 0.22 if queue_state == "steady" else 0.12

        recommendations: list[dict[str, Any]] = []
        waste_avoided_units = 0.0
        cost_saved_usd = 0.0

        for profile in self.item_profiles:
            required_units = projected_customers * profile.units_per_order
            safety_units = profile.batch_size * safety_ratio
            target_units = required_units + safety_units

            if projected_customers < 2.5 and queue_state == "falling":
                min_batches = 0
            else:
                min_batches = 1

            recommended_batches = max(min_batches, math.ceil(target_units / profile.batch_size))
            recommended_units = recommended_batches * profile.batch_size
            baseline_batches = math.ceil(profile.baseline_drop_units / profile.batch_size)
            baseline_units = baseline_batches * profile.batch_size

            baseline_over = max(0.0, baseline_units - required_units)
            recommended_over = max(0.0, recommended_units - required_units)
            saved_units = max(0.0, baseline_over - recommended_over)

            waste_avoided_units += saved_units
            cost_saved_usd += saved_units * profile.unit_cost_usd

            delta_batches = recommended_batches - baseline_batches
            urgency = "high" if queue_state == "surging" and recommended_batches >= baseline_batches else "medium" if queue_state == "steady" else "low"

            if delta_batches > 0:
                reason = f"Queue {queue_state}; increase by {delta_batches} batch(es) to absorb demand spike."
            elif delta_batches < 0:
                reason = f"Queue {queue_state}; reduce by {abs(delta_batches)} batch(es) to limit overproduction."
            else:
                reason = "Current pace matches forecasted demand for the next cook cycle."

            recommendations.append(
                {
                    "item": profile.key,
                    "label": profile.label,
                    "recommended_batches": recommended_batches,
                    "recommended_units": recommended_units,
                    "baseline_batches": baseline_batches,
                    "baseline_units": baseline_units,
                    "delta_batches": delta_batches,
                    "urgency": urgency,
                    "reason": reason,
                }
            )

        queue_pressure = self._clamp(projected_customers / 24.0, 0.0, 1.0)
        wait_reduction_min = self._clamp((waste_avoided_units / 8.0) + (queue_pressure * 1.5), 0.2, 3.2)
        expected_conversion_lift = self._clamp(wait_reduction_min * 0.025, 0.0, 0.16)
        revenue_protected_usd = round(projected_customers * expected_conversion_lift * self.avg_ticket_usd, 2)

        return {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "forecast": {
                "horizon_min": round(self.forecast_horizon_min, 1),
                "queue_state": queue_state,
                "trend_customers_per_min": round(trend_per_min, 2),
                "current_customers": round(current_customers, 1),
                "projected_customers": round(projected_customers, 1),
                "confidence": self._confidence(processing_fps),
            },
            "recommendations": recommendations,
            "impact": {
                "estimated_wait_reduction_min": round(wait_reduction_min, 1),
                "estimated_waste_avoided_units": round(waste_avoided_units, 1),
                "estimated_cost_saved_usd": round(cost_saved_usd, 2),
                "estimated_revenue_protected_usd": revenue_protected_usd,
                "current_wait_time_min": round(current_wait, 1),
            },
            "assumptions": {
                "drop_cadence_min": round(self.drop_cadence_min, 1),
                "avg_ticket_usd": round(self.avg_ticket_usd, 2),
                "notes": [
                    "Recommendations are generated for the next cook cycle.",
                    "Business impact values are directional estimates for decision support.",
                ],
            },
        }
