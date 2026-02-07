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
        self.medium_urgency_shortfall_ratio = self._clamp(
            self._env_float("RECO_URGENCY_MEDIUM_SHORTFALL_RATIO", 0.15),
            0.0,
            1.0,
        )
        self.high_urgency_shortfall_ratio = self._clamp(
            self._env_float("RECO_URGENCY_HIGH_SHORTFALL_RATIO", 0.35),
            0.0,
            1.0,
        )
        if self.high_urgency_shortfall_ratio < self.medium_urgency_shortfall_ratio:
            self.high_urgency_shortfall_ratio = self.medium_urgency_shortfall_ratio

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
        self._feedback_multiplier_by_item: dict[str, float] = {}
        self._feedback_events_by_item: dict[str, int] = {}
        self._reset_inventory_state()
        self._reset_feedback_state()

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

    def _reset_feedback_state(self) -> None:
        self._feedback_multiplier_by_item = {}
        self._feedback_events_by_item = {}
        for profile in self.item_profiles:
            self._feedback_multiplier_by_item[profile.key] = 1.0
            self._feedback_events_by_item[profile.key] = 0

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

    def _ensure_feedback_state(self) -> None:
        active_profiles = {profile.key: profile for profile in self.item_profiles}
        stale_keys = [key for key in self._feedback_multiplier_by_item if key not in active_profiles]
        for key in stale_keys:
            self._feedback_multiplier_by_item.pop(key, None)
            self._feedback_events_by_item.pop(key, None)

        for key in active_profiles:
            self._feedback_multiplier_by_item.setdefault(key, 1.0)
            self._feedback_events_by_item.setdefault(key, 0)

    def _demand_rate_units_per_min(self, customer_load: float, profile: ItemProfile) -> float:
        cadence_min = max(0.5, float(self.drop_cadence_min))
        customers_per_min = max(0.0, customer_load) / cadence_min
        return customers_per_min * profile.units_per_order

    @staticmethod
    def _round_to_nearest_unit(units: float) -> int:
        if units <= 0.0:
            return 0
        return int(math.floor(units + 0.5))

    def _stabilized_customer_count(self, current_customers: float) -> float:
        if not self._history:
            return max(0.0, current_customers)
        window_size = min(12, len(self._history))
        recent_values = [point[1] for point in list(self._history)[-window_size:]]
        trailing_avg = sum(recent_values) / max(1, window_size)
        stabilized = (0.65 * trailing_avg) + (0.35 * max(0.0, current_customers))
        return max(0.0, stabilized)

    @staticmethod
    def _fryer_units(state: ItemInventoryState, *, ready_before: datetime | None = None) -> int:
        if ready_before is None:
            return int(sum(max(0, lot.units) for lot in state.fryer_lots))
        return int(sum(max(0, lot.units) for lot in state.fryer_lots if lot.ready_at <= ready_before))

    def _advance_inventory(self, *, timestamp: datetime, customer_load: float) -> None:
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

            demand_rate_units_per_min = self._demand_rate_units_per_min(customer_load, profile)
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
        self._reset_feedback_state()
        return self.get_business_profile()

    def apply_operator_feedback(
        self,
        *,
        item_key: str,
        action: str,
        recommended_units: int,
        chosen_units: int,
    ) -> dict[str, Any]:
        self._ensure_feedback_state()
        if item_key not in self._feedback_multiplier_by_item:
            raise ValueError(f"Unknown recommendation item '{item_key}'.")

        prior_multiplier = float(self._feedback_multiplier_by_item.get(item_key, 1.0))
        bounded_recommended = max(0, int(recommended_units))
        bounded_chosen = max(0, int(chosen_units))
        normalized_action = action.strip().lower()

        if normalized_action == "accept":
            signal = 1.0
        else:
            reference_units = max(1.0, float(bounded_recommended))
            signal = self._clamp(float(bounded_chosen) / reference_units, 0.65, 1.35)

        smoothing = 0.18
        updated_multiplier = self._clamp(
            (1.0 - smoothing) * prior_multiplier + (smoothing * signal),
            0.75,
            1.25,
        )

        self._feedback_multiplier_by_item[item_key] = updated_multiplier
        self._feedback_events_by_item[item_key] = int(self._feedback_events_by_item.get(item_key, 0)) + 1

        return {
            "item": item_key,
            "action": normalized_action,
            "multiplier_before": round(prior_multiplier, 3),
            "multiplier_after": round(updated_multiplier, 3),
            "feedback_events": int(self._feedback_events_by_item[item_key]),
        }

    def get_feedback_adaptation_summary(self) -> dict[str, Any]:
        self._ensure_feedback_state()
        entries = []
        for profile in self.item_profiles:
            key = profile.key
            entries.append(
                {
                    "item": key,
                    "label": profile.label,
                    "multiplier": round(float(self._feedback_multiplier_by_item.get(key, 1.0)), 3),
                    "feedback_events": int(self._feedback_events_by_item.get(key, 0)),
                }
            )

        total_events = sum(int(entry["feedback_events"]) for entry in entries)
        avg_multiplier = (
            sum(float(entry["multiplier"]) for entry in entries) / max(1, len(entries))
            if entries
            else 1.0
        )
        return {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "total_feedback_events": int(total_events),
            "avg_multiplier": round(float(avg_multiplier), 3),
            "items": entries,
        }

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

    def _urgency_from_inventory_gap(
        self,
        *,
        projected_demand_units: float,
        available_inventory_units: float,
    ) -> tuple[str, float, float]:
        safe_projected_demand = max(0.0, float(projected_demand_units))
        safe_available_inventory = max(0.0, float(available_inventory_units))
        shortfall_units = max(0.0, safe_projected_demand - safe_available_inventory)
        if safe_projected_demand <= 0.0:
            return "low", shortfall_units, 0.0

        shortfall_ratio = self._clamp(shortfall_units / safe_projected_demand, 0.0, 1.0)
        if shortfall_ratio >= self.high_urgency_shortfall_ratio:
            return "high", shortfall_units, shortfall_ratio
        if shortfall_ratio >= self.medium_urgency_shortfall_ratio:
            return "medium", shortfall_units, shortfall_ratio
        return "low", shortfall_units, shortfall_ratio

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
        effective_customers = max(0.0, current_customers)
        self._ensure_feedback_state()
        self._ensure_inventory_state()
        for profile in self.item_profiles:
            state = self._inventory[profile.key]
            max_units = int(profile.max_unit_size)
            baseline_units = min(int(profile.baseline_drop_units), int(profile.max_unit_size))
            ready_inventory_units = max(0, self._round_to_nearest_unit(state.ready_units))
            fryer_inventory_units = max(0, self._fryer_units(state))
            available_inventory_units = float(max(0, ready_inventory_units + fryer_inventory_units))

            raw_target_units = max(0.0, effective_customers * profile.units_per_order)
            feedback_multiplier = float(self._feedback_multiplier_by_item.get(profile.key, 1.0))
            adjusted_target_units = raw_target_units * feedback_multiplier
            rounded_target_units = self._round_to_nearest_unit(adjusted_target_units)
            recommended_units = min(rounded_target_units, max_units)
            feedback_events = int(self._feedback_events_by_item.get(profile.key, 0))
            urgency_supply_units = available_inventory_units + float(max(0, recommended_units))
            urgency_by_gap, projected_shortfall_units, projected_shortfall_ratio = self._urgency_from_inventory_gap(
                projected_demand_units=raw_target_units,
                available_inventory_units=urgency_supply_units,
            )

            reason = (
                "Live stream is unavailable; using the latest total customer estimate (drive-thru + in-store). "
                f"{effective_customers:.1f} customers x {profile.units_per_order:.2f} "
                f"{self._unit_label(profile.unit_label)}/order = {raw_target_units:.1f} projected demand. "
                f"Effective supply {urgency_supply_units:.1f} "
                f"(ready + fryer {available_inventory_units:.1f}, planned drop {recommended_units}). "
                f"projected shortfall {projected_shortfall_units:.1f} ({projected_shortfall_ratio * 100:.0f}%). "
                f"Rounded to nearest whole unit => "
                f"{self._qty(rounded_target_units, unit_label=profile.unit_label)}; "
                f"drop {self._qty(recommended_units, unit_label=profile.unit_label)} now."
            )
            if feedback_events > 0:
                reason = (
                    f"{reason} Feedback multiplier {feedback_multiplier:.2f}x "
                    f"({feedback_events} operator actions) applied."
                )

            if rounded_target_units > max_units:
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
                    "delta_units": recommended_units - baseline_units,
                    "forecast_window_demand_units": round(raw_target_units, 1),
                    "ready_inventory_units": ready_inventory_units,
                    "fryer_inventory_units": fryer_inventory_units,
                    "projected_inventory_gap_units": round(projected_shortfall_units, 1),
                    "projected_inventory_gap_ratio": round(projected_shortfall_ratio, 3),
                    "feedback_multiplier": round(feedback_multiplier, 3),
                    "feedback_events": feedback_events,
                    "urgency": urgency_by_gap,
                    "reason": reason,
                }
            )

        notes = [
            "Recommendations are generated for the next cook cycle.",
            "Drop sizing is based on current total customer count (drive-thru + in-store) and per-order item averages.",
            "Each item recommendation is rounded to the nearest whole unit.",
            "Recommendations are capped at each item's configured max unit size.",
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
                "urgency_thresholds": {
                    "medium_shortfall_ratio": round(self.medium_urgency_shortfall_ratio, 3),
                    "high_shortfall_ratio": round(self.high_urgency_shortfall_ratio, 3),
                },
                "notes": notes,
            },
        }

    def generate(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        timestamp = self._parse_timestamp(snapshot.get("timestamp"))
        current_customers = float(
            snapshot.get("aggregates", {}).get(
                "total_customers",
                snapshot.get("in_store", {}).get("person_count", 0.0),
            )
            or 0.0
        )
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
        self._ensure_feedback_state()

        trend_per_min = self._trend_per_min()
        queue_state = self._state_from_trend(trend_per_min)
        stabilized_customers = self._stabilized_customer_count(current_customers)
        projected_customers = max(0.0, stabilized_customers + (trend_per_min * max(0.0, self.forecast_horizon_min)))
        effective_customers = projected_customers

        self._advance_inventory(timestamp=timestamp, customer_load=current_customers)
        decision_due, next_decision_in_sec = self._decision_due(timestamp)

        recommendations: list[dict[str, Any]] = []
        waste_avoided_units = 0.0
        cost_saved_usd = 0.0

        for profile in self.item_profiles:
            state = self._inventory[profile.key]
            max_units = int(profile.max_unit_size)
            baseline_units = min(int(profile.baseline_drop_units), max_units)
            ready_inventory_units = max(0, self._round_to_nearest_unit(state.ready_units))
            fryer_inventory_units = max(0, self._fryer_units(state))
            available_inventory_units = float(max(0, ready_inventory_units + fryer_inventory_units))

            raw_target_units = max(0.0, effective_customers * profile.units_per_order)
            feedback_multiplier = float(self._feedback_multiplier_by_item.get(profile.key, 1.0))
            adjusted_target_units = raw_target_units * feedback_multiplier
            rounded_target_units = self._round_to_nearest_unit(adjusted_target_units)
            target_units = min(rounded_target_units, max_units)
            feedback_events = int(self._feedback_events_by_item.get(profile.key, 0))

            if decision_due:
                recommended_units = target_units
                self._last_decision_by_item[profile.key] = recommended_units
                if recommended_units > 0:
                    state.fryer_lots.append(
                        FryerLot(
                            units=recommended_units,
                            ready_at=timestamp + timedelta(seconds=self.cook_time_sec),
                        )
                    )
            else:
                held_units = int(self._last_decision_by_item.get(profile.key, target_units))
                recommended_units = min(max(0, held_units), max_units)

            urgency_supply_units = available_inventory_units + (float(max(0, recommended_units)) if decision_due else 0.0)
            urgency_by_gap, projected_shortfall_units, projected_shortfall_ratio = self._urgency_from_inventory_gap(
                projected_demand_units=raw_target_units,
                available_inventory_units=urgency_supply_units,
            )
            saved_units = max(0.0, float(baseline_units - recommended_units))
            waste_avoided_units += saved_units
            cost_saved_usd += saved_units * profile.unit_cost_usd

            delta_units = recommended_units - baseline_units
            supply_context = (
                f"Effective supply {urgency_supply_units:.1f} "
                f"(ready + fryer {available_inventory_units:.1f}, planned drop {recommended_units})."
                if decision_due
                else f"Effective supply {urgency_supply_units:.1f} (ready + fryer inventory)."
            )

            reason = (
                f"Projected {effective_customers:.1f} customers in {self.forecast_horizon_min:.1f} min "
                f"(current {current_customers:.1f}, trend {trend_per_min:.2f}/min) x {profile.units_per_order:.2f} "
                f"{self._unit_label(profile.unit_label)}/order = {raw_target_units:.1f} projected demand. "
                f"{supply_context} "
                f"projected shortfall {projected_shortfall_units:.1f} ({projected_shortfall_ratio * 100:.0f}%). "
                f"Rounded to nearest whole unit => "
                f"{self._qty(target_units, unit_label=profile.unit_label)}; "
                f"drop {self._qty(recommended_units, unit_label=profile.unit_label)} now."
            )
            if feedback_events > 0:
                reason = (
                    f"{reason} Feedback multiplier {feedback_multiplier:.2f}x "
                    f"({feedback_events} operator actions) applied."
                )

            if rounded_target_units > max_units:
                reason = (
                    f"{reason} Capped at {self._qty(profile.max_unit_size, unit_label=profile.unit_label)} "
                    "based on configured max unit size."
                )
            if not decision_due:
                reason = f"{reason} Decision lock active for {next_decision_in_sec}s to avoid oscillation."

            recommendations.append(
                {
                    "item": profile.key,
                    "label": profile.label,
                    "recommended_units": recommended_units,
                    "baseline_units": baseline_units,
                    "max_unit_size": profile.max_unit_size,
                    "unit_label": self._unit_label(profile.unit_label),
                    "delta_units": delta_units,
                    "forecast_window_demand_units": round(raw_target_units, 1),
                    "ready_inventory_units": ready_inventory_units,
                    "fryer_inventory_units": fryer_inventory_units,
                    "projected_inventory_gap_units": round(projected_shortfall_units, 1),
                    "projected_inventory_gap_ratio": round(projected_shortfall_ratio, 3),
                    "decision_locked": not decision_due,
                    "next_decision_in_sec": next_decision_in_sec,
                    "feedback_multiplier": round(feedback_multiplier, 3),
                    "feedback_events": feedback_events,
                    "urgency": urgency_by_gap,
                    "reason": reason,
                }
            )

        if decision_due:
            self._last_decision_timestamp = timestamp

        queue_pressure = self._clamp(effective_customers / 24.0, 0.0, 1.0)
        wait_reduction_min = self._clamp((waste_avoided_units / 8.0) + (queue_pressure * 1.5), 0.2, 3.2)
        expected_conversion_lift = self._clamp(wait_reduction_min * 0.025, 0.0, 0.16)
        revenue_protected_usd = round(effective_customers * expected_conversion_lift * self.avg_ticket_usd, 2)

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
                "urgency_thresholds": {
                    "medium_shortfall_ratio": round(self.medium_urgency_shortfall_ratio, 3),
                    "high_shortfall_ratio": round(self.high_urgency_shortfall_ratio, 3),
                },
                "notes": [
                    "Drop sizing is based on projected customer count (drive-thru + in-store) and per-order item averages.",
                    "Urgency is based on projected inventory shortfall ratio ((projected demand - available inventory) / projected demand).",
                    "Decisions are held for a short interval to reduce recommendation oscillation.",
                    "Each item recommendation is rounded to the nearest whole unit.",
                    "Recommendations are capped at each item's configured max unit size.",
                    "Operator feedback continuously tunes item-level multipliers toward real kitchen behavior.",
                    "Business impact values are directional estimates for decision support.",
                ],
            },
        }
