"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchDashboardData,
  fetchRecommendationFeedbackSummary,
  submitRecommendationFeedback,
} from "@/app/lib/api";
import type {
  Metrics,
  RecommendationFeedbackAction,
  RecommendationFeedbackSummary,
  RecommendationItem,
  RecommendationResponse,
} from "@/app/lib/types";

const FEEDBACK_WINDOW_MIN = 240;
const FEEDBACK_LIMIT = 200;

type SortMode = "item" | "waste_risk";
type DecisionAction = RecommendationFeedbackAction;
type ShortcutAction = "accept" | "ignore";
type ItemIconType = "fries" | "fillet" | "nuggets" | "strips" | "generic";

type ItemDecision = {
  action: DecisionAction;
  chosenUnits: number;
  atIso: string;
};

type PreparedRecommendation = {
  item: RecommendationItem;
  unitLabel: string;
  baselineUnits: number;
  recommendedUnits: number;
  deltaVsUsual: number;
  demandUnits: number;
  onHandUnits: number;
  cookTimeMin: number;
  wasteRiskPct: number;
  posPerHour: number;
  horizonMin: number;
  horizonLabel: string;
  actionImpact: number;
  iconType: ItemIconType;
};

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatSigned(value: number, digits: number): string {
  const formatted = value.toFixed(digits);
  if (value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

function formatClock(value: string | null | undefined): string {
  if (!value) {
    return "--";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

function formatClockShort(value: string | null | undefined): string {
  if (!value) {
    return "--";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function unitLabelFromItem(item: RecommendationItem | null | undefined): string {
  const normalized = item?.unit_label?.trim();
  return normalized && normalized.length ? normalized : "units";
}

function deriveRecommendationNumbers(item: RecommendationItem): {
  baselineUnits: number;
  recommendedUnits: number;
  deltaUnits: number;
} {
  const baselineUnits = Number.isFinite(item.baseline_units) ? Number(item.baseline_units) : 0;
  const recommendedUnits = Number.isFinite(item.recommended_units)
    ? Number(item.recommended_units)
    : baselineUnits;
  const deltaUnits = Number.isFinite(item.delta_units)
    ? Number(item.delta_units)
    : recommendedUnits - baselineUnits;

  return { baselineUnits, recommendedUnits, deltaUnits };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function recommendationSignature(item: RecommendationItem): string {
  const numbers = deriveRecommendationNumbers(item);
  const demandUnits = Number.isFinite(item.forecast_window_demand_units)
    ? Number(item.forecast_window_demand_units)
    : numbers.recommendedUnits;

  return [
    Math.round(numbers.recommendedUnits * 10) / 10,
    Math.round(numbers.baselineUnits * 10) / 10,
    Math.round(demandUnits * 10) / 10,
    Number(item.decision_locked ? 1 : 0),
    Math.round(Number(item.next_decision_in_sec ?? 0)),
  ].join("|");
}

function removeKeysFromRecord<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.length) {
    return record;
  }

  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function inferItemIconType(item: RecommendationItem): ItemIconType {
  const source = `${item.item} ${item.label}`.toLowerCase();

  if (source.includes("fry") || source.includes("fries") || source.includes("cup")) {
    return "fries";
  }
  if (source.includes("fillet") || source.includes("chicken") || source.includes("leg")) {
    return "fillet";
  }
  if (source.includes("nugget")) {
    return "nuggets";
  }
  if (source.includes("strip") || source.includes("tender")) {
    return "strips";
  }

  return "generic";
}

function buildSparklinePath(values: number[]): string {
  const safe = values.length ? values : [0, 0, 0, 0, 0];
  const max = Math.max(...safe);
  const min = Math.min(...safe);
  const range = Math.max(1, max - min);

  return safe
    .map((value, index) => {
      const x = safe.length === 1 ? 0 : (index / (safe.length - 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(" ");
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <path d="M4 10.5L8 14.5L16 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SkipIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <path d="M5 6L12 10L5 14V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M14.5 5.5V14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function InfoIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 9V13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="10" cy="6.5" r="1" fill="currentColor" />
    </svg>
  );
}

function ItemIcon({ type }: { type: ItemIconType }) {
  if (type === "fries") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5 text-orange-700">
        <rect x="6" y="9" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 9V5M12 9V4.5M16 9V5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === "fillet") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5 text-amber-800">
        <path d="M6 13C6 10 8.5 8 11.5 8C14.5 8 17 10 17 13C17 16 14.5 18 11.5 18C8.5 18 6 16 6 13Z" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="18.5" cy="13" r="1.6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }

  if (type === "nuggets") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5 text-yellow-700">
        <circle cx="8" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="13.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="15.5" cy="14.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }

  if (type === "strips") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5 text-rose-700">
        <path d="M6 8C8.5 8 11.5 7.5 14 6.5C15.5 6 17 7 17 8.5C17 10 16 11.5 14 12.5C11.5 13.8 8.7 14.2 6.2 14.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M7 11.5C9.5 11.5 12.5 11 15 10C16.5 9.5 18 10.5 18 12C18 13.5 17 15 15 16C12.5 17.3 9.7 17.7 7.2 17.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5 text-slate-700">
      <rect x="6" y="6" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 12H15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function decisionMessage(decision: ItemDecision, unitLabel: string): string {
  if (decision.action === "ignore") {
    return "Ignored recommendation until next update";
  }

  if (decision.action === "accept") {
    return `Accepted ${decision.chosenUnits} ${unitLabel} at ${formatClockShort(decision.atIso)}`;
  }

  return `Override applied to ${decision.chosenUnits} ${unitLabel} at ${formatClockShort(decision.atIso)}`;
}

export default function RecommendationActivityPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reco, setReco] = useState<RecommendationResponse | null>(null);
  const [feedbackSummary, setFeedbackSummary] = useState<RecommendationFeedbackSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const [sortMode, setSortMode] = useState<SortMode>("item");
  const [overrideDraftByItem, setOverrideDraftByItem] = useState<Record<string, string>>({});
  const [feedbackBusyByItem, setFeedbackBusyByItem] = useState<Record<string, boolean>>({});
  const [feedbackStatusByItem, setFeedbackStatusByItem] = useState<Record<string, string | null>>({});
  const [selectedActionByItem, setSelectedActionByItem] = useState<Record<string, ShortcutAction | null>>({});
  const [decisionByItem, setDecisionByItem] = useState<Record<string, ItemDecision | null>>({});
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null);
  const [demandHistoryByItem, setDemandHistoryByItem] = useState<Record<string, number[]>>({});
  const [pulseByItem, setPulseByItem] = useState<Record<string, boolean>>({});

  const signaturesRef = useRef<Record<string, string>>({});
  const pulseTimeoutRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const triggerCardPulse = useCallback((itemKey: string) => {
    setPulseByItem((prev) => ({ ...prev, [itemKey]: true }));

    const existingTimer = pulseTimeoutRef.current[itemKey];
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    pulseTimeoutRef.current[itemKey] = setTimeout(() => {
      setPulseByItem((prev) => ({ ...prev, [itemKey]: false }));
    }, 210);
  }, []);

  useEffect(() => {
    const timeoutMap = pulseTimeoutRef.current;

    return () => {
      const timers = Object.values(timeoutMap);
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;

    const poll = async () => {
      try {
        const [metricsData, recoData] = await fetchDashboardData();
        if (!alive) {
          return;
        }

        setMetrics(metricsData);
        setReco(recoData);
        setError(null);

        setOverrideDraftByItem((prev) => {
          const next: Record<string, string> = {};
          for (const item of recoData.recommendations ?? []) {
            next[item.item] = prev[item.item] ?? "";
          }
          return next;
        });

        setDemandHistoryByItem((prev) => {
          const next: Record<string, number[]> = {};
          for (const item of recoData.recommendations ?? []) {
            const demandUnits = Number.isFinite(item.forecast_window_demand_units)
              ? Number(item.forecast_window_demand_units)
              : Number.isFinite(item.recommended_units)
                ? Number(item.recommended_units)
                : 0;
            const history = [...(prev[item.item] ?? []), Math.max(0, demandUnits)].slice(-18);
            next[item.item] = history;
          }
          return next;
        });

        const previousSignatures = signaturesRef.current;
        const nextSignatures: Record<string, string> = {};
        const changedKeys: string[] = [];

        for (const item of recoData.recommendations ?? []) {
          const signature = recommendationSignature(item);
          nextSignatures[item.item] = signature;
          if (previousSignatures[item.item] && previousSignatures[item.item] !== signature) {
            changedKeys.push(item.item);
          }
        }

        for (const previousKey of Object.keys(previousSignatures)) {
          if (!nextSignatures[previousKey]) {
            changedKeys.push(previousKey);
          }
        }

        signaturesRef.current = nextSignatures;

        if (changedKeys.length) {
          setDecisionByItem((prev) => removeKeysFromRecord(prev, changedKeys));
          setSelectedActionByItem((prev) => removeKeysFromRecord(prev, changedKeys));
          setFeedbackStatusByItem((prev) => removeKeysFromRecord(prev, changedKeys));
          for (const key of changedKeys) {
            triggerCardPulse(key);
          }
        }
      } catch (err) {
        if (!alive) {
          return;
        }
        setError(err instanceof Error ? err.message : "Unknown recommendation loading error.");
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), 1500);

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, [triggerCardPulse]);

  useEffect(() => {
    let alive = true;

    const pollFeedback = async () => {
      try {
        const summary = await fetchRecommendationFeedbackSummary({
          minutes: FEEDBACK_WINDOW_MIN,
          limit: FEEDBACK_LIMIT,
        });
        if (!alive) {
          return;
        }
        setFeedbackSummary(summary);
        setFeedbackError(null);
      } catch (err) {
        if (!alive) {
          return;
        }
        setFeedbackError(err instanceof Error ? err.message : "Unable to load feedback outcomes.");
      }
    };

    void pollFeedback();
    const intervalId = setInterval(() => void pollFeedback(), 5000);

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, []);

  const applyFeedback = useCallback(async (item: RecommendationItem, action: DecisionAction) => {
    setFeedbackBusyByItem((prev) => ({ ...prev, [item.item]: true }));
    setFeedbackStatusByItem((prev) => ({ ...prev, [item.item]: null }));

    try {
      const payload: {
        item: string;
        action: DecisionAction;
        override_units?: number;
      } = {
        item: item.item,
        action,
      };

      const recommendationNumbers = deriveRecommendationNumbers(item);
      const maxUnitSize = Number.isFinite(item.max_unit_size)
        ? Number(item.max_unit_size)
        : undefined;
      const safeRecommended = clamp(Math.round(Math.max(0, recommendationNumbers.recommendedUnits)), 0, maxUnitSize ?? 99999);
      let chosenUnits = safeRecommended;

      if (action === "override") {
        const rawOverride = (overrideDraftByItem[item.item] ?? "").trim();
        const parsedOverride = Number.parseInt(rawOverride, 10);

        if (!Number.isFinite(parsedOverride)) {
          throw new Error("Enter a valid whole-number override amount.");
        }

        chosenUnits = clamp(Math.max(0, parsedOverride), 0, maxUnitSize ?? 99999);
        payload.override_units = chosenUnits;
      }

      const response = await submitRecommendationFeedback(payload);
      const eventTimestamp = response.feedback.timestamp || new Date().toISOString();

      setDecisionByItem((prev) => ({
        ...prev,
        [item.item]: {
          action,
          chosenUnits,
          atIso: eventTimestamp,
        },
      }));

      if (action === "accept" || action === "ignore") {
        setSelectedActionByItem((prev) => ({ ...prev, [item.item]: action }));
      }

      setFeedbackStatusByItem((prev) => ({
        ...prev,
        [item.item]: `Model multiplier ${response.adaptation.multiplier_before.toFixed(2)}x -> ${response.adaptation.multiplier_after.toFixed(2)}x`,
      }));

      if (action === "override") {
        setOverrideDraftByItem((prev) => ({ ...prev, [item.item]: "" }));
      }

      triggerCardPulse(item.item);

      try {
        const [[metricsData, recoData], summaryData] = await Promise.all([
          fetchDashboardData(),
          fetchRecommendationFeedbackSummary({
            minutes: FEEDBACK_WINDOW_MIN,
            limit: FEEDBACK_LIMIT,
          }),
        ]);
        setMetrics(metricsData);
        setReco(recoData);
        setFeedbackSummary(summaryData);
        setFeedbackError(null);
      } catch (refreshErr) {
        setFeedbackError(refreshErr instanceof Error ? refreshErr.message : "Unable to refresh feedback metrics.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to submit feedback.";
      if (action === "accept" || action === "ignore") {
        setSelectedActionByItem((prev) => ({ ...prev, [item.item]: null }));
      }
      setFeedbackStatusByItem((prev) => ({ ...prev, [item.item]: `Error: ${message}` }));
    } finally {
      setFeedbackBusyByItem((prev) => ({ ...prev, [item.item]: false }));
    }
  }, [overrideDraftByItem, triggerCardPulse]);

  const clearDecisionLock = useCallback((itemKey: string) => {
    setDecisionByItem((prev) => ({ ...prev, [itemKey]: null }));
    setSelectedActionByItem((prev) => ({ ...prev, [itemKey]: null }));
    setFeedbackStatusByItem((prev) => ({ ...prev, [itemKey]: null }));
  }, []);

  const preparedRecommendations = useMemo<PreparedRecommendation[]>(() => {
    const horizonForDemand = Math.max(1, Number(reco?.forecast.horizon_min ?? 15));
    const fallbackCookMin = Math.max(0, Number(reco?.assumptions.cook_time_sec ?? 0) / 60);

    const prepared = (reco?.recommendations ?? []).map((item) => {
      const rawNumbers = deriveRecommendationNumbers(item);
      const maxUnitSize = Number.isFinite(item.max_unit_size)
        ? Number(item.max_unit_size)
        : undefined;

      const baselineUnits = clamp(Math.round(Math.max(0, rawNumbers.baselineUnits)), 0, maxUnitSize ?? 99999);
      const recommendedUnits = clamp(Math.round(Math.max(0, rawNumbers.recommendedUnits)), 0, maxUnitSize ?? 99999);
      const unitLabel = unitLabelFromItem(item);

      const readyUnits = Number.isFinite(item.ready_inventory_units)
        ? Number(item.ready_inventory_units)
        : 0;
      const fryerUnits = Number.isFinite(item.fryer_inventory_units)
        ? Number(item.fryer_inventory_units)
        : 0;
      const onHandUnits = Math.max(0, readyUnits + fryerUnits);

      const demandUnits = Number.isFinite(item.forecast_window_demand_units)
        ? Number(item.forecast_window_demand_units)
        : Number(recommendedUnits);

      const oversupplyUnits = Math.max(0, recommendedUnits + onHandUnits - demandUnits);
      const wasteRiskPct = clamp((oversupplyUnits / Math.max(1, demandUnits)) * 100, 0, 100);

      const horizonMin = Number(item.next_decision_in_sec ?? 0) > 0
        ? Math.max(1, Math.round(Number(item.next_decision_in_sec) / 60))
        : Math.max(
          1,
          Number.isFinite(reco?.assumptions.decision_interval_sec)
            ? Math.round(Number(reco?.assumptions.decision_interval_sec) / 60)
            : Math.round(Number(reco?.assumptions.drop_cadence_min ?? reco?.forecast.horizon_min ?? 15)),
        );

      const actionImpact = Math.max(0, baselineUnits - recommendedUnits);

      return {
        item,
        unitLabel,
        baselineUnits,
        recommendedUnits,
        deltaVsUsual: recommendedUnits - baselineUnits,
        demandUnits,
        onHandUnits,
        cookTimeMin: fallbackCookMin,
        wasteRiskPct,
        posPerHour: (Math.max(0, demandUnits) / Math.max(1, horizonForDemand)) * 60,
        horizonMin,
        horizonLabel: `Next ${horizonMin} ${horizonMin === 1 ? "minute" : "minutes"}`,
        actionImpact,
        iconType: inferItemIconType(item),
      };
    });

    const sorted = [...prepared].sort((a, b) => {
      if (sortMode === "item") {
        return a.item.label.localeCompare(b.item.label);
      }

      if (sortMode === "waste_risk") {
        if (b.wasteRiskPct !== a.wasteRiskPct) {
          return b.wasteRiskPct - a.wasteRiskPct;
        }
        if (b.actionImpact !== a.actionImpact) {
          return b.actionImpact - a.actionImpact;
        }
        if (b.recommendedUnits !== a.recommendedUnits) {
          return b.recommendedUnits - a.recommendedUnits;
        }
        return a.item.label.localeCompare(b.item.label);
      }

      if (b.actionImpact !== a.actionImpact) {
        return b.actionImpact - a.actionImpact;
      }
      if (b.recommendedUnits !== a.recommendedUnits) {
        return b.recommendedUnits - a.recommendedUnits;
      }
      return a.item.label.localeCompare(b.item.label);
    });

    return sorted;
  }, [reco, sortMode]);

  const allRecommendationCards = useMemo<PreparedRecommendation[]>(() => {
    const horizonForDemand = Math.max(1, Number(reco?.forecast.horizon_min ?? 15));
    const fallbackCookMin = Math.max(0, Number(reco?.assumptions.cook_time_sec ?? 0) / 60);

    return (reco?.recommendations ?? []).map((item) => {
      const rawNumbers = deriveRecommendationNumbers(item);
      const maxUnitSize = Number.isFinite(item.max_unit_size)
        ? Number(item.max_unit_size)
        : undefined;
      const baselineUnits = clamp(Math.round(Math.max(0, rawNumbers.baselineUnits)), 0, maxUnitSize ?? 99999);
      const recommendedUnits = clamp(Math.round(Math.max(0, rawNumbers.recommendedUnits)), 0, maxUnitSize ?? 99999);
      const unitLabel = unitLabelFromItem(item);
      const demandUnits = Number.isFinite(item.forecast_window_demand_units)
        ? Number(item.forecast_window_demand_units)
        : Number(recommendedUnits);
      const onHandUnits = Math.max(0, Number(item.ready_inventory_units ?? 0) + Number(item.fryer_inventory_units ?? 0));
      const oversupplyUnits = Math.max(0, recommendedUnits + onHandUnits - demandUnits);

      return {
        item,
        unitLabel,
        baselineUnits,
        recommendedUnits,
        deltaVsUsual: recommendedUnits - baselineUnits,
        demandUnits,
        onHandUnits,
        cookTimeMin: fallbackCookMin,
        wasteRiskPct: clamp((oversupplyUnits / Math.max(1, demandUnits)) * 100, 0, 100),
        posPerHour: (Math.max(0, demandUnits) / Math.max(1, horizonForDemand)) * 60,
        horizonMin: Math.max(1, Number(reco?.forecast.horizon_min ?? 15)),
        horizonLabel: `Next ${Math.max(1, Number(reco?.forecast.horizon_min ?? 15))} minutes`,
        actionImpact: Math.max(0, baselineUnits - recommendedUnits),
        iconType: inferItemIconType(item),
      };
    });
  }, [reco]);

  const recommendationMap = useMemo(() => {
    return new Map(preparedRecommendations.map((entry) => [entry.item.item, entry]));
  }, [preparedRecommendations]);

  useEffect(() => {
    if (!preparedRecommendations.length) {
      setActiveItemKey(null);
      return;
    }

    const hasActive = activeItemKey && recommendationMap.has(activeItemKey);
    if (!hasActive) {
      setActiveItemKey(preparedRecommendations[0].item.item);
    }
  }, [activeItemKey, preparedRecommendations, recommendationMap]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName.toLowerCase();
      const editing = Boolean(
        target?.isContentEditable
        || tagName === "input"
        || tagName === "textarea"
        || tagName === "select",
      );

      if (editing) {
        return;
      }

      const lowered = event.key.toLowerCase();
      if (lowered !== "a" && lowered !== "i") {
        return;
      }

      const fallbackKey = preparedRecommendations[0]?.item.item ?? null;
      const targetKey = activeItemKey ?? fallbackKey;
      if (!targetKey) {
        return;
      }

      const card = recommendationMap.get(targetKey);
      if (!card) {
        return;
      }

      const busy = feedbackBusyByItem[targetKey] ?? false;
      const alreadyLocked = Boolean(decisionByItem[targetKey]);
      const backendLocked = Boolean(card.item.decision_locked);
      if (busy || alreadyLocked || backendLocked) {
        return;
      }

      const action: ShortcutAction = lowered === "a" ? "accept" : "ignore";
      event.preventDefault();
      setSelectedActionByItem((prev) => ({ ...prev, [targetKey]: action }));
      void applyFeedback(card.item, action);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeItemKey, applyFeedback, decisionByItem, feedbackBusyByItem, preparedRecommendations, recommendationMap]);

  const liveInStorePeople = Number(metrics?.in_store?.person_count ?? 0);
  const liveDriveThruCars = Number(metrics?.drive_thru?.car_count ?? 0);
  const liveDriveThruPassengers = Number(metrics?.drive_thru?.est_passengers ?? 0);
  const actualCustomers = Number(metrics?.aggregates?.total_customers ?? liveInStorePeople + liveDriveThruPassengers);

  const adoptionRatePercent = useMemo(
    () => (feedbackSummary?.adoption.adoption_rate ?? 0) * 100,
    [feedbackSummary?.adoption.adoption_rate],
  );

  const totalRecommendedByUnit = useMemo(() => {
    const totals = new Map<string, number>();

    for (const card of allRecommendationCards) {
      totals.set(card.unitLabel, (totals.get(card.unitLabel) ?? 0) + card.recommendedUnits);
    }

    return [...totals.entries()].map(([unit, total]) => ({
      unit,
      total,
    }));
  }, [allRecommendationCards]);

  const totalRecommendedLabel = totalRecommendedByUnit.length
    ? totalRecommendedByUnit.map(({ unit, total }) => `${total} ${unit}`).join(" · ")
    : "No active recommendations";

  const activeCardLabel = useMemo(() => {
    if (!activeItemKey) {
      return "";
    }

    return recommendationMap.get(activeItemKey)?.item.label ?? "";
  }, [activeItemKey, recommendationMap]);

  return (
    <main className="mx-auto grid w-[min(1400px,calc(100%-24px))] gap-3 py-3 md:w-[min(1400px,calc(100%-36px))] md:py-4">
      <section className="panel rounded-3xl p-4 md:p-5">
        <div className="mb-3">
          <div>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">Recommended Activity</h1>
            <p className="text-sm text-muted md:text-base">
              Full-screen view of live unit-drop recommendations and measured feedback outcomes.
            </p>
          </div>
        </div>

        {error ? <div className="mb-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
        {feedbackError ? (
          <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{feedbackError}</div>
        ) : null}

        {metrics?.stream_status && metrics.stream_status !== "ok" ? (
          <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            One or more streams are unavailable. {metrics.stream_error ?? "Check source URL, credentials, and network reachability."}
          </div>
        ) : null}

        <section className="mb-3 rounded-2xl border accent-card p-4 md:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Live Summary</p>
              <p className="mt-1 display text-lg font-semibold text-graphite">Total recommended: {totalRecommendedLabel}</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-muted">
                <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
                Last updated: {formatClock(reco?.timestamp)}
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700">
                <span className="font-semibold">Sort by:</span>
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  className="bg-transparent text-sm font-semibold text-slate-800 focus:outline-none"
                >
                  <option value="item">Item name</option>
                  <option value="waste_risk">Waste risk</option>
                </select>
              </label>
            </div>
          </div>

        </section>

        <section className="grid min-h-[56vh] auto-rows-fr gap-3 xl:grid-cols-2">
          {preparedRecommendations.map((card, index) => {
            const { item } = card;
            const busy = feedbackBusyByItem[item.item] ?? false;
            const feedbackStatus = feedbackStatusByItem[item.item];
            const currentDecision = decisionByItem[item.item];
            const backendDecisionLocked = Boolean(item.decision_locked);
            const actionLocked = Boolean(currentDecision);
            const controlsDisabled = busy || backendDecisionLocked || actionLocked;
            const selectedAction = selectedActionByItem[item.item] ?? null;
            const isActive = activeItemKey === item.item;
            const shouldDim = card.recommendedUnits === 0;

            const overrideDraft = overrideDraftByItem[item.item] ?? "";
            const hasOverrideDraft = overrideDraft.trim().length > 0;
            const overrideApplyDisabled = busy || backendDecisionLocked || actionLocked || !hasOverrideDraft;

            const demandHistory = demandHistoryByItem[item.item] ?? [card.demandUnits];
            const sparklinePath = buildSparklinePath(demandHistory);

            const metricsPreview = `POS ${Math.round(card.posPerHour)}/h · Waste risk ${Math.round(card.wasteRiskPct)}%`;

            return (
              <article
                key={item.item}
                tabIndex={0}
                onFocus={() => setActiveItemKey(item.item)}
                onMouseEnter={() => setActiveItemKey(item.item)}
                className={[
                  "h-full rounded-3xl border p-4 shadow-sm transition-all duration-200 md:p-6",
                  shouldDim ? "opacity-[0.84]" : "opacity-100",
                  isActive ? "ring-2 ring-sky-300 ring-offset-1" : "",
                  pulseByItem[item.item] ? "recommendation-pulse" : "",
                ].join(" ")}
                style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
              >
                <div className="mb-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-600">Item</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white">
                        <ItemIcon type={card.iconType} />
                      </span>
                      <h2 className="display truncate text-3xl leading-tight font-bold text-slate-900 md:text-5xl">{item.label}</h2>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-300 bg-white p-6">
                  <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-[0.12em] text-slate-600">
                    <span>Recommended Drop</span>
                    <span title={`Based on last ${Math.max(1, Number(reco?.forecast.horizon_min ?? 15))} min demand and queue trend`}>
                      <InfoIcon className="h-3.5 w-3.5 text-slate-500" />
                    </span>
                  </div>

                  <p className="mt-2 flex items-end gap-2 leading-none">
                    <span className="display text-5xl font-black text-slate-900 md:text-6xl">{card.recommendedUnits}</span>
                    <span className="display pb-1 text-xl font-semibold text-slate-700 md:text-2xl">{card.unitLabel}</span>
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${card.deltaVsUsual < 0 ? "border-emerald-300 bg-emerald-50 text-emerald-700" : card.deltaVsUsual > 0 ? "border-amber-300 bg-amber-50 text-amber-700" : "border-slate-300 bg-slate-100 text-slate-700"}`}>
                      {formatSigned(card.deltaVsUsual, 0)} vs usual
                    </span>
                    <span className="rounded-full border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800">
                      {card.horizonLabel}
                    </span>
                  </div>

                </div>

                <details className="mt-3 rounded-2xl border border-slate-300 bg-white p-6 text-xs text-slate-700">
                  <summary className="cursor-pointer select-none font-semibold text-slate-800">
                    More metrics: {metricsPreview}
                  </summary>

                  <div className="mt-4 space-y-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <article className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-600">Demand (last {Math.max(1, Number(reco?.forecast.horizon_min ?? 15))}m)</p>
                        <p className="display mt-1 text-xl font-bold text-slate-900">{card.demandUnits.toFixed(1)} {card.unitLabel}</p>
                      </article>

                      <article className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-600">On-hand</p>
                        <p className="display mt-1 text-xl font-bold text-slate-900">{card.onHandUnits.toFixed(1)} {card.unitLabel}</p>
                      </article>

                      <article className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-600">Cook time</p>
                        <p className="display mt-1 text-xl font-bold text-slate-900">{card.cookTimeMin.toFixed(1)} min</p>
                      </article>

                      <article className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-600">Waste risk</p>
                        <p className="display mt-1 text-xl font-bold text-slate-900">{Math.round(card.wasteRiskPct)}%</p>
                      </article>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                      <div className="mb-1 flex items-center justify-between">
                        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-600">Demand sparkline</p>
                        <p className="text-[11px] font-semibold text-slate-500">Last {demandHistory.length} points</p>
                      </div>
                      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-10 w-full">
                        <polyline
                          points={sparklinePath}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          className="text-sky-600"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>

                    {item.reason ? <p className="text-xs leading-relaxed text-slate-700">{item.reason}</p> : null}
                  </div>
                </details>

                <div className="mt-2 rounded-xl border border-slate-300 bg-white p-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-600">Operator Feedback</p>
                  </div>

                  <div className={`flex flex-wrap gap-1.5 ${actionLocked ? "opacity-55" : ""}`} role="radiogroup" aria-label={`Feedback choice for ${item.label}`}>
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => {
                        setSelectedActionByItem((prev) => ({ ...prev, [item.item]: "accept" }));
                        void applyFeedback(item, "accept");
                      }}
                      className={[
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
                        selectedAction === "accept"
                          ? "border-emerald-500 bg-emerald-600 text-white shadow-sm"
                          : "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50",
                        controlsDisabled ? "cursor-not-allowed opacity-60" : "",
                      ].join(" ")}
                    >
                      {selectedAction === "accept" ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                      <span>{busy && selectedAction === "accept" ? "Saving..." : "Accept"}</span>
                    </button>

                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => {
                        setSelectedActionByItem((prev) => ({ ...prev, [item.item]: "ignore" }));
                        void applyFeedback(item, "ignore");
                      }}
                      className={[
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
                        selectedAction === "ignore"
                          ? "border-amber-500 bg-amber-500 text-white shadow-sm"
                          : "border-amber-300 bg-white text-amber-700 hover:bg-amber-50",
                        controlsDisabled ? "cursor-not-allowed opacity-60" : "",
                      ].join(" ")}
                    >
                      {selectedAction === "ignore" ? <SkipIcon className="h-3.5 w-3.5" /> : null}
                      <span>{busy && selectedAction === "ignore" ? "Saving..." : "Ignore"}</span>
                    </button>
                  </div>

                  <div className={`mt-2 flex flex-wrap items-center gap-1.5 ${actionLocked ? "opacity-55" : ""}`}>
                    <label htmlFor={`override-${item.item}`} className="text-xs font-semibold text-slate-700">
                      Override to:
                    </label>
                    <input
                      id={`override-${item.item}`}
                      type="number"
                      min={0}
                      max={item.max_unit_size ?? 5000}
                      step={1}
                      disabled={busy || backendDecisionLocked || actionLocked}
                      placeholder={`${card.recommendedUnits}`}
                      value={overrideDraft}
                      onChange={(event) =>
                        setOverrideDraftByItem((prev) => ({
                          ...prev,
                          [item.item]: event.target.value,
                        }))
                      }
                      className="accent-input w-24 rounded-lg border border-slate-300 px-2 py-0.5 text-xs text-slate-800 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-100"
                    />

                    <button
                      type="button"
                      disabled={overrideApplyDisabled}
                      onClick={() => void applyFeedback(item, "override")}
                      className={[
                        "rounded-lg border px-2.5 py-0.5 text-[11px] font-semibold transition",
                        hasOverrideDraft
                          ? "border-sky-400 bg-sky-600 text-white hover:brightness-105"
                          : "border-slate-300 bg-slate-100 text-slate-500",
                        overrideApplyDisabled ? "cursor-not-allowed opacity-70" : "",
                      ].join(" ")}
                    >
                      {busy ? "Saving..." : "Apply"}
                    </button>
                  </div>

                  {currentDecision ? (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-800">
                      <div className="flex items-center gap-1.5">
                        {currentDecision.action === "ignore"
                          ? <SkipIcon className="h-3.5 w-3.5" />
                          : <CheckIcon className="h-3.5 w-3.5" />}
                        <span>{decisionMessage(currentDecision, card.unitLabel)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => clearDecisionLock(item.item)}
                        className="text-xs font-semibold text-sky-700 underline decoration-sky-400 underline-offset-2"
                      >
                        Change
                      </button>
                    </div>
                  ) : null}

                  {feedbackStatus ? (
                    <p className={`mt-1.5 text-xs ${feedbackStatus.startsWith("Error:") ? "text-red-600" : "text-slate-600"}`}>
                      {feedbackStatus}
                    </p>
                  ) : null}

                  <p className="mt-1 text-[10px] text-slate-500">
                    Shortcuts: Accept (A)  Ignore (I){isActive && activeCardLabel ? ` for ${activeCardLabel}` : ""}
                  </p>
                </div>
              </article>
            );
          })}

          {preparedRecommendations.length ? null : (
            <div className="accent-card rounded-3xl border p-6 text-sm text-muted">Waiting for recommendations...</div>
          )}
        </section>

        <div className="mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Queue State</p>
            <p className="mt-2 display text-2xl font-semibold capitalize text-sky-900">{reco?.forecast.queue_state ?? "unknown"}</p>
            <p className="text-sm text-muted">Trend {reco?.forecast.trend_customers_per_min?.toFixed(2) ?? "0.00"} cust/min</p>
          </article>

          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Actual Customers</p>
            <p className="mt-2 display text-2xl font-semibold text-sky-700">{actualCustomers.toFixed(1)}</p>
            <p className="text-sm text-muted">
              {liveInStorePeople} in-store + {liveDriveThruPassengers.toFixed(1)} drive-thru est. passengers ({liveDriveThruCars} cars)
            </p>
          </article>

          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Wait Reduction</p>
            <p className="mt-2 display text-2xl font-semibold text-amber-700">
              {reco?.impact.estimated_wait_reduction_min?.toFixed(1) ?? "0.0"} min
            </p>
            <p className="text-sm text-muted">Current {reco?.impact.current_wait_time_min?.toFixed(1) ?? "0.0"} min</p>
          </article>

          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Protected Revenue</p>
            <p className="mt-2 display text-2xl font-semibold text-emerald-700">
              {formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}
            </p>
            <p className="text-sm text-muted">Directional estimate</p>
          </article>

          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Adoption Rate</p>
            <p className="mt-2 display text-2xl font-semibold text-cyan-700">{adoptionRatePercent.toFixed(1)}%</p>
            <p className="text-sm text-muted">
              {feedbackSummary?.adoption.adopted ?? 0} adopted / {feedbackSummary?.count ?? 0} actions
            </p>
          </article>

        </div>

      </section>
    </main>
  );
}
