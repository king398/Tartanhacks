from __future__ import annotations

import math
import os
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any


@dataclass(frozen=True)
class ItemProfile:
    key: str
    label: str
    units_per_order: float
    batch_size: int
    max_unit_size: int
    baseline_drop_units: int
    unit_cost_usd: float
    unit_label: str = "units"


@dataclass
class FryerLot:
    units: int
    ready_at: datetime


@dataclass
class ItemInventoryState:
    ready_units: float
    fryer_lots: deque[FryerLot]


class RecommendationEngine:
    def __init__(self) -> None:
        self._history: deque[tuple[datetime, float]] = deque(maxlen=90)
        self.forecast_horizon_min = self._env_float("RECO_FORECAST_HORIZON_MIN", 8.0)
        self.drop_cadence_min = self._env_float("RECO_DROP_CADENCE_MIN", 4.0)
        self.decision_interval_sec = max(5.0, self._env_float("RECO_DECISION_INTERVAL_SEC", 30.0))
        self.cook_time_sec = max(30.0, self._env_float("RECO_COOK_TIME_SEC", self.drop_cadence_min * 60.0))
        self.avg_ticket_usd = self._env_float("AVG_TICKET_USD", 10.5)
        self.medium_urgency_customers = self._env_float("RECO_URGENCY_MEDIUM_CUSTOMERS", 8.0)
        self.high_urgency_customers = self._env_float("RECO_URGENCY_HIGH_CUSTOMERS", 16.0)
        if self.high_urgency_customers < self.medium_urgency_customers:
            self.high_urgency_customers = self.medium_urgency_customers

        self.business_name = "Steel City Chicken"
        self.business_type = "Fast Food"
        self.location = "Pittsburgh, PA"
        self.service_model = "Drive-thru + Counter"

        self.item_profiles: tuple[ItemProfile, ...] = (
            ItemProfile(
                key="fillets",
                label="Chicken Fillets",
                units_per_order=0.58,
                batch_size=8,
                max_unit_size=24,
                baseline_drop_units=16,
                unit_cost_usd=0.92,
                unit_label="fillets",
            ),
            ItemProfile(
                key="nuggets",
                label="Nuggets",
                units_per_order=0.36,
                batch_size=6,
                max_unit_size=20,
                baseline_drop_units=12,
                unit_cost_usd=0.68,
                unit_label="cups",
            ),
            ItemProfile(
                key="fries",
                label="Fries",
                units_per_order=0.72,
                batch_size=10,
                max_unit_size=28,
                baseline_drop_units=18,
                unit_cost_usd=0.44,
                unit_label="cups",
            ),
            ItemProfile(
                key="strips",
                label="Strips",
                units_per_order=0.15,
                batch_size=8,
                max_unit_size=20,
                baseline_drop_units=8,
                unit_cost_usd=0.86,
                unit_label="strips",
            ),
        )
        self._inventory: dict[str, ItemInventoryState] = {}
        self._last_inventory_timestamp: datetime | None = None
        self._last_decision_timestamp: datetime | None = None
        self._last_decision_by_item: dict[str, int] = {}
        self._reset_inventory_state()

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

    def _business_summary(self) -> dict[str, str]:
        return {
            "name": self.business_name,
            "type": self.business_type,
            "location": self.location,
            "service_model": self.service_model,
        }

    @staticmethod
    def _unit_label(value: str | None) -> str:
        normalized = (value or "").strip()
        return normalized or "units"

    def _qty(self, value: int | float, *, unit_label: str) -> str:
        if isinstance(value, float):
            return f"{value:.1f} {self._unit_label(unit_label)}"
        return f"{value} {self._unit_label(unit_label)}"

    def _reset_inventory_state(self) -> None:
        self._inventory = {}
        self._last_decision_by_item = {}
        for profile in self.item_profiles:
            baseline_units = min(int(profile.baseline_drop_units), int(profile.max_unit_size))
            self._inventory[profile.key] = ItemInventoryState(
                ready_units=float(max(0, baseline_units)),
                fryer_lots=deque(),
            )
            self._last_decision_by_item[profile.key] = 0
        self._last_inventory_timestamp = None
        self._last_decision_timestamp = None

    def _ensure_inventory_state(self) -> None:
        active_profiles = {profile.key: profile for profile in self.item_profiles}
        stale_keys = [key for key in self._inventory if key not in active_profiles]
        for key in stale_keys:
            self._inventory.pop(key, None)
            self._last_decision_by_item.pop(key, None)

        for key, profile in active_profiles.items():
            if key not in self._inventory:
                baseline_units = min(int(profile.baseline_drop_units), int(profile.max_unit_size))
                self._inventory[key] = ItemInventoryState(
                    ready_units=float(max(0, baseline_units)),
                    fryer_lots=deque(),
                )
            self._last_decision_by_item.setdefault(key, 0)

    def _demand_rate_units_per_min(self, projected_customers: float, profile: ItemProfile) -> float:
        horizon_min = max(0.5, float(self.forecast_horizon_min))
        customers_per_min = max(0.0, projected_customers) / horizon_min
        return customers_per_min * profile.units_per_order

    @staticmethod
    def _fryer_units(state: ItemInventoryState, *, ready_before: datetime | None = None) -> int:
        if ready_before is None:
            return int(sum(max(0, lot.units) for lot in state.fryer_lots))
        return int(sum(max(0, lot.units) for lot in state.fryer_lots if lot.ready_at <= ready_before))

    def _advance_inventory(self, *, timestamp: datetime, projected_customers: float) -> None:
        self._ensure_inventory_state()
        if self._last_inventory_timestamp is None:
            self._last_inventory_timestamp = timestamp
            return

        elapsed_sec = max(0.0, (timestamp - self._last_inventory_timestamp).total_seconds())
        if elapsed_sec <= 0.0:
            return

        for profile in self.item_profiles:
            state = self._inventory[profile.key]
            while state.fryer_lots and state.fryer_lots[0].ready_at <= timestamp:
                cooked_lot = state.fryer_lots.popleft()
                state.ready_units += float(max(0, cooked_lot.units))

            demand_rate_units_per_min = self._demand_rate_units_per_min(projected_customers, profile)
            consumed_units = demand_rate_units_per_min * (elapsed_sec / 60.0)
            state.ready_units = max(0.0, state.ready_units - consumed_units)
            state.ready_units = min(state.ready_units, float(profile.max_unit_size * 6))

        self._last_inventory_timestamp = timestamp

    def _decision_due(self, timestamp: datetime) -> tuple[bool, int]:
        if self._last_decision_timestamp is None:
            return True, 0

        elapsed_sec = max(0.0, (timestamp - self._last_decision_timestamp).total_seconds())
        if elapsed_sec >= self.decision_interval_sec:
            return True, 0

        remaining_sec = max(0, int(math.ceil(self.decision_interval_sec - elapsed_sec)))
        return False, remaining_sec

    def configure_business_profile(
        self,
        *,
        business_name: str,
        business_type: str,
        location: str,
        service_model: str,
        avg_ticket_usd: float,
        item_profiles: list[ItemProfile],
    ) -> dict[str, Any]:
        self.business_name = business_name.strip() or self.business_name
        self.business_type = business_type.strip() or self.business_type
        self.location = location.strip() or self.location
        self.service_model = service_model.strip() or self.service_model
        self.avg_ticket_usd = max(0.01, float(avg_ticket_usd))
        self.item_profiles = tuple(item_profiles)
        self._reset_inventory_state()
        return self.get_business_profile()

    def get_business_profile(self) -> dict[str, Any]:
        return {
            "business_name": self.business_name,
            "business_type": self.business_type,
            "location": self.location,
            "service_model": self.service_model,
            "avg_ticket_usd": round(self.avg_ticket_usd, 2),
            "menu_items": [
                {
                    "key": profile.key,
                    "label": profile.label,
                    "units_per_order": profile.units_per_order,
                    "batch_size": profile.batch_size,
                    "max_unit_size": profile.max_unit_size,
                    "baseline_drop_units": profile.baseline_drop_units,
                    "unit_cost_usd": profile.unit_cost_usd,
                    "unit_label": self._unit_label(profile.unit_label),
                }
                for profile in self.item_profiles
            ],
        }

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

    def _urgency_from_customer_count(self, total_customers: float) -> str:
        if total_customers >= self.high_urgency_customers:
            return "high"
        if total_customers >= self.medium_urgency_customers:
            return "medium"
        return "low"

    def _confidence(self, processing_fps: float) -> float:
        history_factor = self._clamp(len(self._history) / 18.0, 0.0, 1.0)
        fps_factor = self._clamp(processing_fps / 15.0, 0.0, 1.0)
        return round(self._clamp(0.45 + (0.35 * history_factor) + (0.2 * fps_factor), 0.45, 0.95), 2)

    @staticmethod
    def _target_drop_units(target_units: float, *, queue_state: str) -> int:
        # Keep surging queues conservative, but allow finer steady/falling recommendations.
        if queue_state == "surging":
            return int(math.ceil(target_units))
        if queue_state == "falling":
            return max(0, int(math.floor(target_units)))
        return max(0, int(round(target_units)))

    def _build_unavailable_response(
        self,
        *,
        current_customers: float,
        current_wait: float,
        stream_error: str | None,
    ) -> dict[str, Any]:
        fallback_urgency = self._urgency_from_customer_count(current_customers)
        now = datetime.now(timezone.utc)
        decision_due, remaining_sec = self._decision_due(now)
        self._ensure_inventory_state()
        recommendations = []
        for profile in self.item_profiles:
            baseline_units = min(int(profile.baseline_drop_units), int(profile.max_unit_size))
            state = self._inventory.get(profile.key)
            ready_units = int(round(state.ready_units)) if state else baseline_units
            fryer_units = self._fryer_units(state) if state else 0
            if self._last_decision_timestamp is None:
                recommended_units = baseline_units
            else:
                recommended_units = int(self._last_decision_by_item.get(profile.key, baseline_units))
            recommended_units = min(max(0, recommended_units), int(profile.max_unit_size))
            recommendations.append(
                {
                    "item": profile.key,
                    "label": profile.label,
                    "recommended_units": recommended_units,
                    "baseline_units": baseline_units,
                    "max_unit_size": profile.max_unit_size,
                    "unit_label": self._unit_label(profile.unit_label),
                    "delta_units": recommended_units - baseline_units,
                    "ready_inventory_units": ready_units,
                    "fryer_inventory_units": fryer_units,
                    "decision_locked": not decision_due,
                    "next_decision_in_sec": remaining_sec,
                    "urgency": fallback_urgency,
                    "reason": "Live stream is unavailable; holding the latest 30-second recommendation cycle.",
                }
            )

        notes = [
            "Recommendations are generated for the next cook cycle.",
            f"Recommendations refresh every {int(round(self.decision_interval_sec))}s; each refresh is treated as an immediate fryer drop.",
            "Business impact values are directional estimates for decision support.",
        ]
        if stream_error:
            notes.append(f"Stream issue: {stream_error}")

        return {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "business": self._business_summary(),
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
                "decision_interval_sec": int(round(self.decision_interval_sec)),
                "cook_time_sec": int(round(self.cook_time_sec)),
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

        self._advance_inventory(timestamp=timestamp, projected_customers=projected_customers)

        safety_ratio = 0.35 if queue_state == "surging" else 0.22 if queue_state == "steady" else 0.12
        urgency_by_customer_load = self._urgency_from_customer_count(current_customers)
        decision_due, decision_remaining_sec = self._decision_due(timestamp)
        decision_window_min = max(self.drop_cadence_min, self.decision_interval_sec / 60.0)
        coverage_deadline = timestamp + timedelta(minutes=decision_window_min)

        recommendations: list[dict[str, Any]] = []
        waste_avoided_units = 0.0
        cost_saved_usd = 0.0

        if decision_due:
            self._last_decision_by_item = {}

        for profile in self.item_profiles:
            state = self._inventory[profile.key]
            ready_units = max(0.0, state.ready_units)
            max_units = int(profile.max_unit_size)
            baseline_units = min(int(profile.baseline_drop_units), max_units)

            demand_rate_units_per_min = self._demand_rate_units_per_min(projected_customers, profile)
            forecast_window_demand_units = demand_rate_units_per_min * decision_window_min
            safety_units = forecast_window_demand_units * safety_ratio
            target_inventory_units = forecast_window_demand_units + safety_units

            fryer_units_total = self._fryer_units(state)
            fryer_units_in_window = self._fryer_units(state, ready_before=coverage_deadline)
            available_units_for_window = ready_units + float(fryer_units_in_window)
            required_drop_units = max(0.0, target_inventory_units - available_units_for_window)
            target_drop_units = self._target_drop_units(required_drop_units, queue_state=queue_state)

            if decision_due:
                recommended_units = min(target_drop_units, max_units)
                if recommended_units > 0:
                    ready_at = timestamp + timedelta(seconds=self.cook_time_sec)
                    state.fryer_lots.append(FryerLot(units=recommended_units, ready_at=ready_at))
                    fryer_units_total += recommended_units
                self._last_decision_by_item[profile.key] = recommended_units
            else:
                recommended_units = min(max(0, int(self._last_decision_by_item.get(profile.key, 0))), max_units)

            baseline_over = max(0.0, baseline_units - required_drop_units)
            recommended_over = max(0.0, recommended_units - required_drop_units)
            saved_units = max(0.0, baseline_over - recommended_over)
            waste_avoided_units += saved_units
            cost_saved_usd += saved_units * profile.unit_cost_usd

            ready_inventory_units = int(round(state.ready_units))
            fryer_inventory_units = self._fryer_units(state)
            delta_units = recommended_units - baseline_units

            if decision_due:
                if recommended_units > 0:
                    reason = (
                        f"Inventory ready {self._qty(ready_inventory_units, unit_label=profile.unit_label)}, "
                        f"fryer {self._qty(fryer_inventory_units, unit_label=profile.unit_label)}. "
                        f"Forecast {self._qty(forecast_window_demand_units, unit_label=profile.unit_label)} "
                        f"over next {decision_window_min:.1f} min; "
                        f"drop {self._qty(recommended_units, unit_label=profile.unit_label)} now."
                    )
                else:
                    reason = (
                        f"Inventory ready {self._qty(ready_inventory_units, unit_label=profile.unit_label)}, "
                        f"fryer {self._qty(fryer_inventory_units, unit_label=profile.unit_label)} already covers "
                        f"{self._qty(forecast_window_demand_units, unit_label=profile.unit_label)} "
                        f"forecast over next {decision_window_min:.1f} min."
                    )
            else:
                reason = (
                    f"Decision locked on {int(round(self.decision_interval_sec))}s cadence; "
                    f"next refresh in {decision_remaining_sec}s. Inventory ready "
                    f"{self._qty(ready_inventory_units, unit_label=profile.unit_label)}, "
                    f"fryer {self._qty(fryer_inventory_units, unit_label=profile.unit_label)}."
                )

            if decision_due and target_drop_units > max_units:
                reason = (
                    f"{reason} Capped at {self._qty(profile.max_unit_size, unit_label=profile.unit_label)} "
                    "based on configured max unit size."
                )

            recommendations.append(
                {
                    "item": profile.key,
                    "label": profile.label,
                    "recommended_units": recommended_units,
                    "baseline_units": baseline_units,
                    "max_unit_size": profile.max_unit_size,
                    "unit_label": self._unit_label(profile.unit_label),
                    "delta_units": delta_units,
                    "ready_inventory_units": ready_inventory_units,
                    "fryer_inventory_units": fryer_inventory_units,
                    "forecast_window_demand_units": round(forecast_window_demand_units, 1),
                    "decision_locked": not decision_due,
                    "next_decision_in_sec": decision_remaining_sec if not decision_due else int(round(self.decision_interval_sec)),
                    "urgency": urgency_by_customer_load,
                    "reason": reason,
                }
            )

        if decision_due:
            self._last_decision_timestamp = timestamp

        queue_pressure = self._clamp(projected_customers / 24.0, 0.0, 1.0)
        wait_reduction_min = self._clamp((waste_avoided_units / 8.0) + (queue_pressure * 1.5), 0.2, 3.2)
        expected_conversion_lift = self._clamp(wait_reduction_min * 0.025, 0.0, 0.16)
        revenue_protected_usd = round(projected_customers * expected_conversion_lift * self.avg_ticket_usd, 2)

        return {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "business": self._business_summary(),
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
                "decision_interval_sec": int(round(self.decision_interval_sec)),
                "cook_time_sec": int(round(self.cook_time_sec)),
                "avg_ticket_usd": round(self.avg_ticket_usd, 2),
                "notes": [
                    "Recommendations are generated for the next cook cycle.",
                    f"Recommendations refresh every {int(round(self.decision_interval_sec))}s; each refresh is treated as an immediate fryer drop.",
                    "Inventory state tracks ready inventory and in-fryer inventory by menu item.",
                    "Business impact values are directional estimates for decision support.",
                ],
            },
        }
