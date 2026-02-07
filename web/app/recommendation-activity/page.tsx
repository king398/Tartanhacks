"use client";

import { useEffect, useState } from "react";

import { fetchDashboardData } from "@/app/lib/api";
import type { Metrics, RecommendationItem, RecommendationResponse } from "@/app/lib/types";

type RecommendationLogEntry = {
  timestamp: string;
  queueState: string;
  actualCustomers: number;
  inStorePeople: number;
  driveThruCars: number;
  topItemLabel: string;
  topItemUnitLabel: string;
  topDeltaUnits: number;
  estimatedWaitReductionMin: number;
  estimatedRevenueProtectedUsd: number;
  signature: string;
};

const urgencyBadge: Record<RecommendationItem["urgency"], string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-300",
  low: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
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
  const baselineUnits = Number.isFinite(item.baseline_units) ? item.baseline_units : 0;
  const recommendedUnits = Number.isFinite(item.recommended_units) ? item.recommended_units : baselineUnits;
  const deltaUnits = Number.isFinite(item.delta_units) ? item.delta_units : recommendedUnits - baselineUnits;
  return { baselineUnits, recommendedUnits, deltaUnits };
}

export default function RecommendationActivityPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reco, setReco] = useState<RecommendationResponse | null>(null);
  const [activityLog, setActivityLog] = useState<RecommendationLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        setActivityLog((prev) => {
          const topDeltaItem = [...recoData.recommendations].sort((a, b) => {
            const aDelta = deriveRecommendationNumbers(a).deltaUnits;
            const bDelta = deriveRecommendationNumbers(b).deltaUnits;
            return Math.abs(bDelta) - Math.abs(aDelta);
          })[0];
          const decisionSignature = [
            recoData.forecast.queue_state,
            ...recoData.recommendations.map((item) => {
              const { deltaUnits } = deriveRecommendationNumbers(item);
              return `${item.item}:${deltaUnits}`;
            }),
          ].join("|");

          if (prev[0]?.signature === decisionSignature) {
            return prev;
          }

          const inStorePeople = Number(metricsData.in_store?.person_count ?? 0);
          const driveThruCars = Number(metricsData.drive_thru?.car_count ?? 0);
          const actualCustomers = inStorePeople + driveThruCars;

          const next: RecommendationLogEntry = {
            timestamp: recoData.timestamp,
            queueState: recoData.forecast.queue_state,
            actualCustomers,
            inStorePeople,
            driveThruCars,
            topItemLabel: topDeltaItem?.label ?? "No item",
            topItemUnitLabel: unitLabelFromItem(topDeltaItem),
            topDeltaUnits: topDeltaItem ? deriveRecommendationNumbers(topDeltaItem).deltaUnits : 0,
            estimatedWaitReductionMin: recoData.impact.estimated_wait_reduction_min,
            estimatedRevenueProtectedUsd: recoData.impact.estimated_revenue_protected_usd,
            signature: decisionSignature,
          };

          return [next, ...prev].slice(0, 18);
        });
        setError(null);
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
  }, []);

  const liveInStorePeople = Number(metrics?.in_store?.person_count ?? 0);
  const liveDriveThruCars = Number(metrics?.drive_thru?.car_count ?? 0);
  const actualCustomers = liveInStorePeople + liveDriveThruCars;

  return (
    <main className="mx-auto grid w-[min(1400px,calc(100%-24px))] gap-3 py-3 md:w-[min(1400px,calc(100%-36px))] md:py-4">
      <section className="panel rounded-3xl p-4 md:p-5">
        <div className="mb-3">
          <div>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">Recommended Activity</h1>
            <p className="text-sm text-muted md:text-base">
              Full-screen view of live unit-drop recommendations, urgency, and business impact.
            </p>
          </div>
        </div>

        {error ? <div className="mb-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

        {metrics?.stream_status && metrics.stream_status !== "ok" ? (
          <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            One or more streams are unavailable. {metrics.stream_error ?? "Check source URL, credentials, and network reachability."}
          </div>
        ) : null}

        <div className="mb-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Queue State</p>
            <p className="mt-2 display text-2xl font-semibold capitalize text-sky-900">{reco?.forecast.queue_state ?? "unknown"}</p>
            <p className="text-sm text-muted">Trend {reco?.forecast.trend_customers_per_min?.toFixed(2) ?? "0.00"} cust/min</p>
          </article>
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Actual Customers</p>
            <p className="mt-2 display text-2xl font-semibold text-sky-700">{actualCustomers.toFixed(1)}</p>
            <p className="text-sm text-muted">
              {liveInStorePeople} people + {liveDriveThruCars} cars
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
        </div>

        <section className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {(reco?.recommendations ?? []).map((item) => {
            const maxUnitSize = item.max_unit_size;
            const numbers = deriveRecommendationNumbers(item);
            const unitLabel = unitLabelFromItem(item);
            const recommendedUnits = maxUnitSize !== undefined ? Math.min(numbers.recommendedUnits, maxUnitSize) : numbers.recommendedUnits;
            const baselineUnits = maxUnitSize !== undefined ? Math.min(numbers.baselineUnits, maxUnitSize) : numbers.baselineUnits;
            const deltaUnits = recommendedUnits - baselineUnits;

            return (
              <article key={item.item} className="accent-card rounded-2xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="display text-base font-semibold text-graphite">{item.label}</h2>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] ${urgencyBadge[item.urgency]}`}>
                    {item.urgency}
                  </span>
                </div>

                <p className="mt-2 text-sm text-slate-700">
                  Recommended drop: <span className="font-semibold">{recommendedUnits} {unitLabel}</span>
                </p>
                <p className="text-sm text-muted">
                  Baseline drop: {baselineUnits} {unitLabel}
                </p>
                {item.ready_inventory_units !== undefined || item.fryer_inventory_units !== undefined ? (
                  <p className="text-sm text-muted">
                    Inventory: ready {item.ready_inventory_units ?? 0} | fryer {item.fryer_inventory_units ?? 0} {unitLabel}
                  </p>
                ) : null}
                <p className="mt-1 text-sm text-slate-700">
                  Delta: <span className="font-semibold">{deltaUnits > 0 ? `+${deltaUnits}` : deltaUnits} {unitLabel}</span>
                </p>
                {item.next_decision_in_sec !== undefined ? (
                  <p className="mt-1 text-xs text-muted">
                    {item.decision_locked ? `Next decision in ${item.next_decision_in_sec}s.` : `Decision refreshed. Next update in ${item.next_decision_in_sec}s.`}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-muted">{item.reason}</p>
              </article>
            );
          })}

          {reco?.recommendations.length ? null : (
            <div className="accent-card rounded-2xl border p-3 text-sm text-muted">Waiting for recommendations...</div>
          )}
        </section>

        <section className="mt-3 rounded-2xl border accent-card p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="display text-lg font-semibold text-graphite">Decision Log</h2>
            <p className="text-xs text-muted">Newest first, updates only when recommendation logic changes.</p>
          </div>

          {activityLog.length ? (
            <div className="grid gap-2">
              {activityLog.map((entry) => (
                <article key={entry.timestamp} className="rounded-xl border border-sky-200 bg-sky-50/80 p-3 text-sm text-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-graphite">{new Date(entry.timestamp).toLocaleTimeString()}</p>
                    <p className="text-xs uppercase tracking-[0.08em] text-sky-700">{entry.queueState}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Top action: {entry.topItemLabel} ({entry.topDeltaUnits > 0 ? `+${entry.topDeltaUnits}` : entry.topDeltaUnits} {entry.topItemUnitLabel})
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Actual load {entry.actualCustomers.toFixed(1)} customers ({entry.inStorePeople} people + {entry.driveThruCars} cars) | Wait reduction{" "}
                    {entry.estimatedWaitReductionMin.toFixed(1)} min |
                    Revenue protected {formatMoney(entry.estimatedRevenueProtectedUsd)}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Waiting for recommendation changes to build decision history...</p>
          )}
        </section>
      </section>
    </main>
  );
}
