"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { API_BASE, fetchDashboardData } from "@/app/lib/api";
import type { Metrics, RecommendationResponse } from "@/app/lib/types";

type AnalyticsPoint = {
  timestamp: string;
  totalCustomers: number;
  waitMinutes: number;
  trend: number;
  confidence: number;
  processingFps: number;
  queueState: string;
};

const MAX_HISTORY_POINTS = 120;

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function sparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);

  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function AnalyticsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reco, setReco] = useState<RecommendationResponse | null>(null);
  const [history, setHistory] = useState<AnalyticsPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const poll = async () => {
      try {
        const [metricsData, recoData] = await fetchDashboardData();
        if (!alive) {
          return;
        }

        const nextPoint: AnalyticsPoint = {
          timestamp: metricsData.timestamp,
          totalCustomers: metricsData.aggregates.total_customers,
          waitMinutes: metricsData.aggregates.estimated_wait_time_min,
          trend: recoData.forecast.trend_customers_per_min,
          confidence: recoData.forecast.confidence,
          processingFps: metricsData.performance?.processing_fps ?? 0,
          queueState: recoData.forecast.queue_state,
        };

        setMetrics(metricsData);
        setReco(recoData);
        setHistory((prev) => {
          const next = [...prev, nextPoint];
          return next.slice(-MAX_HISTORY_POINTS);
        });
        setError(null);
      } catch (err) {
        if (!alive) {
          return;
        }
        setError(err instanceof Error ? err.message : "Unknown analytics loading error.");
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), 1500);

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, []);

  const summary = useMemo(() => {
    if (!history.length) {
      return {
        avgWait: 0,
        peakCustomers: 0,
        minCustomers: 0,
        avgTrend: 0,
        avgConfidence: 0,
        avgFps: 0,
        queueShift: 0,
      };
    }

    const totalWait = history.reduce((sum, point) => sum + point.waitMinutes, 0);
    const totalTrend = history.reduce((sum, point) => sum + point.trend, 0);
    const totalConfidence = history.reduce((sum, point) => sum + point.confidence, 0);
    const totalFps = history.reduce((sum, point) => sum + point.processingFps, 0);
    const customers = history.map((point) => point.totalCustomers);
    const queueShift = history[history.length - 1].totalCustomers - history[0].totalCustomers;

    return {
      avgWait: totalWait / history.length,
      peakCustomers: Math.max(...customers),
      minCustomers: Math.min(...customers),
      avgTrend: totalTrend / history.length,
      avgConfidence: totalConfidence / history.length,
      avgFps: totalFps / history.length,
      queueShift,
    };
  }, [history]);

  const activityNarrative = useMemo(() => {
    if (!reco || !metrics) {
      return "Collecting enough data to summarize activity patterns.";
    }

    const state = reco.forecast.queue_state;
    const trend = reco.forecast.trend_customers_per_min;
    const wait = metrics.aggregates.estimated_wait_time_min;

    if (state === "surging") {
      return `Demand is rising (${trend.toFixed(2)} customers/min) and current wait is ${wait.toFixed(1)} min. Prioritize high-urgency batch increases now.`;
    }

    if (state === "falling") {
      return `Demand is easing (${trend.toFixed(2)} customers/min) with ${wait.toFixed(1)} min wait. Reduce production to prevent waste while maintaining baseline readiness.`;
    }

    return `Queue is stable (${trend.toFixed(2)} customers/min) with ${wait.toFixed(1)} min wait. Keep recommended cycle sizes and monitor for short spikes.`;
  }, [metrics, reco]);

  const customersSparkline = useMemo(
    () => sparklinePath(history.map((point) => point.totalCustomers), 520, 130),
    [history],
  );

  const waitSparkline = useMemo(() => sparklinePath(history.map((point) => point.waitMinutes), 520, 130), [history]);

  const latestUpdated = useMemo(() => {
    if (!metrics?.timestamp) {
      return "Waiting for stream...";
    }
    return `Updated: ${new Date(metrics.timestamp).toLocaleString()}`;
  }, [metrics?.timestamp]);

  return (
    <main className="mx-auto grid w-[min(1280px,calc(100%-24px))] gap-4 py-4 md:w-[min(1280px,calc(100%-36px))] md:py-6">
      <section className="panel rounded-3xl p-5 md:p-6">
        <div className="mb-5 flex flex-col gap-3 md:mb-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">Live Analytics</h1>
            <p className="text-sm text-muted md:text-base">Rolling analysis of queue pressure, wait-time risk, and recommendation confidence.</p>
          </div>

          <div className="space-y-2 text-sm text-muted md:text-right">
            <div>{latestUpdated}</div>
            <div className="text-xs">Backend: {API_BASE}</div>
            <nav className="flex gap-2 md:justify-end">
              <Link href="/" className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                Live View
              </Link>
              <Link
                href="/analytics"
                className="rounded-full border border-slate-300 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
              >
                Analytics
              </Link>
            </nav>
          </div>
        </div>

        {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Queue State</p>
            <p className="mt-2 display text-2xl font-semibold capitalize text-graphite">{reco?.forecast.queue_state ?? "unknown"}</p>
            <p className="text-sm text-muted">Trend {reco?.forecast.trend_customers_per_min?.toFixed(2) ?? "0.00"} cust/min</p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Average Wait</p>
            <p className="mt-2 display text-2xl font-semibold text-amber-700">{summary.avgWait.toFixed(1)} min</p>
            <p className="text-sm text-muted">Current {metrics?.aggregates.estimated_wait_time_min?.toFixed(1) ?? "0.0"} min</p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Peak Customer Load</p>
            <p className="mt-2 display text-2xl font-semibold text-cyan-700">{summary.peakCustomers.toFixed(1)}</p>
            <p className="text-sm text-muted">Low {summary.minCustomers.toFixed(1)} / Shift {summary.queueShift.toFixed(1)}</p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Model Quality</p>
            <p className="mt-2 display text-2xl font-semibold gradient-text">{Math.round(summary.avgConfidence * 100)}%</p>
            <p className="text-sm text-muted">Avg {summary.avgFps.toFixed(1)} FPS</p>
          </article>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Customer Load Timeline</h2>
          <p className="mt-1 text-sm text-muted">Recent total customer estimates from computer-vision tracking.</p>
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
            <svg viewBox="0 0 520 130" className="h-40 w-full" role="img" aria-label="Total customers trend">
              <path d={customersSparkline} fill="none" stroke="#0f766e" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>
        </article>

        <article className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Estimated Wait Timeline</h2>
          <p className="mt-1 text-sm text-muted">How queue dynamics are translating into service delay risk.</p>
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
            <svg viewBox="0 0 520 130" className="h-40 w-full" role="img" aria-label="Estimated wait trend">
              <path d={waitSparkline} fill="none" stroke="#d97706" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <article className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">What Is Happening Right Now</h2>
          <p className="mt-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700">{activityNarrative}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <article className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Projected Customers</p>
              <p className="mt-2 display text-2xl font-semibold text-graphite">
                {reco?.forecast.projected_customers?.toFixed(1) ?? "0.0"}
              </p>
              <p className="text-sm text-muted">Horizon {reco?.forecast.horizon_min ?? 0} min</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Protected Revenue</p>
              <p className="mt-2 display text-2xl font-semibold text-emerald-700">
                {formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}
              </p>
              <p className="text-sm text-muted">Directional estimate</p>
            </article>
          </div>
        </article>

        <aside className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Recommendation Activity</h2>
          <div className="mt-4 grid gap-3">
            {(reco?.recommendations ?? []).map((item) => (
              <article key={item.item} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="display text-base font-semibold text-graphite">{item.label}</h3>
                  <span className="text-xs font-bold uppercase tracking-[0.08em] text-muted">{item.urgency}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {item.recommended_batches} batch(es) ({item.recommended_units} units)
                </p>
                <p className="mt-1 text-xs text-muted">{item.reason}</p>
              </article>
            ))}

            {reco?.recommendations.length ? null : (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-muted">Waiting for recommendations...</div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
