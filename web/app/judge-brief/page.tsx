"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { API_BASE, fetchDashboardData, fetchDemoReadiness } from "@/app/lib/api";
import type { DemoReadiness, DemoReadinessCheckStatus, Metrics, RecommendationItem, RecommendationResponse } from "@/app/lib/types";

const readinessBadge: Record<string, string> = {
  ready: "bg-emerald-100 text-emerald-700 border-emerald-200",
  degraded: "bg-amber-100 text-amber-700 border-amber-200",
  blocked: "bg-red-100 text-red-700 border-red-200",
};

const checkStatusBadge: Record<DemoReadinessCheckStatus, string> = {
  pass: "bg-emerald-100 text-emerald-700 border-emerald-200",
  warn: "bg-amber-100 text-amber-700 border-amber-200",
  fail: "bg-red-100 text-red-700 border-red-200",
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

export default function JudgeBriefPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reco, setReco] = useState<RecommendationResponse | null>(null);
  const [readiness, setReadiness] = useState<DemoReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const poll = async () => {
      try {
        const [[metricsData, recoData], readinessData] = await Promise.all([fetchDashboardData(), fetchDemoReadiness()]);
        if (!alive) {
          return;
        }

        setMetrics(metricsData);
        setReco(recoData);
        setReadiness(readinessData);
        setError(null);
      } catch (err) {
        if (!alive) {
          return;
        }
        setError(err instanceof Error ? err.message : "Unable to load live judge briefing data.");
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), 1500);

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, []);

  const latestUpdated = useMemo(() => {
    if (!metrics?.timestamp) {
      return "Waiting for stream...";
    }
    return `Updated: ${new Date(metrics.timestamp).toLocaleString()}`;
  }, [metrics?.timestamp]);

  const readinessClassName = readiness ? readinessBadge[readiness.status] ?? readinessBadge.blocked : readinessBadge.blocked;
  const streamCoverageText = useMemo(() => {
    const driveStatus = metrics?.cameras?.drive_thru?.stream_status ?? "initializing";
    const storeStatus = metrics?.cameras?.in_store?.stream_status ?? "initializing";
    return `Drive-thru: ${driveStatus} | In-store: ${storeStatus}`;
  }, [metrics?.cameras]);

  const topAction = useMemo(() => {
    const items = reco?.recommendations ?? [];
    if (!items.length) {
      return null;
    }
    return [...items].sort((a, b) => {
      const aDelta = deriveRecommendationNumbers(a).deltaUnits;
      const bDelta = deriveRecommendationNumbers(b).deltaUnits;
      return Math.abs(bDelta) - Math.abs(aDelta);
    })[0];
  }, [reco?.recommendations]);
  const topActionNumbers = useMemo(
    () => (topAction ? deriveRecommendationNumbers(topAction) : null),
    [topAction],
  );
  const topActionUnitLabel = useMemo(
    () => unitLabelFromItem(topAction),
    [topAction],
  );

  const stateNarrative = useMemo(() => {
    if (!metrics || !reco) {
      return "Collecting live evidence...";
    }

    const queueState = reco.forecast.queue_state;
    const trend = reco.forecast.trend_customers_per_min;
    const wait = metrics.aggregates.estimated_wait_time_min;

    if (queueState === "surging") {
      return `Demand is rising at ${trend.toFixed(2)} customers/min with ${wait.toFixed(1)} minutes estimated wait. The system is proactively increasing production on high-pressure items.`;
    }
    if (queueState === "falling") {
      return `Demand is falling at ${trend.toFixed(2)} customers/min with ${wait.toFixed(1)} minutes estimated wait. The system is reducing production to avoid waste while preserving readiness.`;
    }
    return `Demand is stable at ${trend.toFixed(2)} customers/min with ${wait.toFixed(1)} minutes estimated wait. The system is maintaining balanced cook cycles.`;
  }, [metrics, reco]);

  return (
    <main className="mx-auto grid w-[min(1280px,calc(100%-24px))] gap-4 py-4 md:w-[min(1280px,calc(100%-36px))] md:py-6">
      <section className="panel rounded-3xl p-5 md:p-6">
        <div className="mb-5 flex flex-col gap-3 md:mb-6 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Judge Briefing</p>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">One Screen for Problem, Proof, and Payoff</h1>
            <p className="mt-1 text-sm text-muted md:text-base">
              This view is designed for evaluation: why the problem matters, what the model is seeing right now, and what action it recommends.
            </p>
          </div>

          <div className="space-y-2 text-sm text-muted md:text-right">
            <div>{latestUpdated}</div>
            <div>{streamCoverageText}</div>
            <div className="text-xs">Backend: {API_BASE}</div>
          </div>
        </div>

        {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Demo Readiness</p>
            <p className="mt-2 display text-2xl font-semibold text-graphite">
              {readiness?.score ?? 0}
              <span className="ml-1 text-sm font-medium text-muted">/100</span>
            </p>
            <span className={`mt-2 inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] ${readinessClassName}`}>
              {readiness?.status ?? "blocked"}
            </span>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Current Queue Load</p>
            <p className="mt-2 display text-2xl font-semibold text-cyan-700">{metrics?.aggregates.total_customers?.toFixed(1) ?? "0.0"}</p>
            <p className="text-sm text-muted">Wait {metrics?.aggregates.estimated_wait_time_min?.toFixed(1) ?? "0.0"} min</p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Forecasted Queue</p>
            <p className="mt-2 display text-2xl font-semibold text-amber-700">{reco?.forecast.projected_customers?.toFixed(1) ?? "0.0"}</p>
            <p className="text-sm text-muted">State {reco?.forecast.queue_state ?? "unknown"}</p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Protected Revenue</p>
            <p className="mt-2 display text-2xl font-semibold text-emerald-700">
              {formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}
            </p>
            <p className="text-sm text-muted">Directional estimate</p>
          </article>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <article className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">The Live Story</h2>
          <p className="mt-2 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700">{stateNarrative}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">Drive-Thru Cars</p>
              <p className="mt-1 display text-xl font-semibold text-cyan-700">{metrics?.drive_thru.car_count ?? 0}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">In-Store People</p>
              <p className="mt-1 display text-xl font-semibold text-emerald-700">{metrics?.in_store.person_count ?? 0}</p>
            </div>
          </div>
        </article>

        <article className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Action Recommendation</h2>
          {topAction && topActionNumbers ? (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="display text-lg font-semibold text-graphite">{topAction.label}</h3>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] ${urgencyBadge[topAction.urgency]}`}>
                  {topAction.urgency}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-700">
                Recommended drop <span className="font-semibold">{topActionNumbers.recommendedUnits} {topActionUnitLabel}</span>, baseline {topActionNumbers.baselineUnits} {topActionUnitLabel}.
              </p>
              {topAction.ready_inventory_units !== undefined || topAction.fryer_inventory_units !== undefined ? (
                <p className="mt-1 text-sm text-muted">
                  Inventory: ready {topAction.ready_inventory_units ?? 0} | fryer {topAction.fryer_inventory_units ?? 0} {topActionUnitLabel}
                </p>
              ) : null}
              <p className="mt-1 text-sm text-slate-700">
                Delta: <span className="font-semibold">{topActionNumbers.deltaUnits > 0 ? `+${topActionNumbers.deltaUnits}` : topActionNumbers.deltaUnits} {topActionUnitLabel}</span>
              </p>
              {topAction.next_decision_in_sec !== undefined ? (
                <p className="mt-1 text-xs text-muted">
                  {topAction.decision_locked ? `Next decision in ${topAction.next_decision_in_sec}s.` : `Decision refreshed. Next update in ${topAction.next_decision_in_sec}s.`}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted">{topAction.reason}</p>
            </div>
          ) : (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-muted">Waiting for recommendations...</div>
          )}

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">Wait Reduction</p>
              <p className="mt-1 display text-xl font-semibold text-amber-700">{reco?.impact.estimated_wait_reduction_min?.toFixed(1) ?? "0.0"} min</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">Waste Avoided</p>
              <p className="mt-1 display text-xl font-semibold text-emerald-700">{reco?.impact.estimated_waste_avoided_units?.toFixed(1) ?? "0.0"} units</p>
            </div>
          </div>
        </article>

        <aside className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Live Reliability Checks</h2>
          <div className="mt-3 grid gap-2">
            {(readiness?.checks ?? []).map((check) => (
              <article key={check.id} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-graphite">{check.label}</p>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${checkStatusBadge[check.status]}`}>
                    {check.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">{check.detail}</p>
                <p className="mt-1 text-[11px] font-semibold text-slate-500">{check.points} pts</p>
              </article>
            ))}
            {readiness?.checks?.length ? null : (
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-muted">Waiting for readiness checks...</div>
            )}
          </div>
        </aside>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <article className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">90-Second Demo Script</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li>Start on this page: call out live readiness, current queue load, and projected load.</li>
            <li>Show recommended action and explain the operational reason in plain language.</li>
            <li>Jump to Live View to show both camera feeds and real-time counters.</li>
            <li>Open Business Profile to prove the engine adapts to different menus and economics.</li>
          </ol>
        </article>

        <aside className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Quick Navigation</h2>
          <div className="mt-3 grid gap-2">
            <Link href="/" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
              Open Live View
            </Link>
            <Link href="/analytics" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
              Open Analytics
            </Link>
            <Link href="/recommendation-activity" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
              Open Recommendation Activity
            </Link>
            <Link href="/business-profile" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
              Open Business Profile
            </Link>
          </div>
        </aside>
      </section>
    </main>
  );
}
