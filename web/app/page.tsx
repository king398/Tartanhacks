"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { API_BASE, fetchDashboardData, fetchStreamSource, resetStreamSource, updateStreamSource } from "@/app/lib/api";
import type { Metrics, RecommendationItem, RecommendationResponse } from "@/app/lib/types";

const urgencyBadge: Record<RecommendationItem["urgency"], string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reco, setReco] = useState<RecommendationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [streamSource, setStreamSource] = useState<string>("");
  const [defaultSource, setDefaultSource] = useState<string>("");
  const [sourceDraft, setSourceDraft] = useState<string>("");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceFormError, setSourceFormError] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const loadSource = async () => {
      try {
        const data = await fetchStreamSource();
        if (!alive) {
          return;
        }
        setStreamSource(data.source);
        setDefaultSource(data.default_source);
        setSourceDraft(data.source);
      } catch (err) {
        if (!alive) {
          return;
        }
        setSourceFormError(err instanceof Error ? err.message : "Could not load stream source.");
      }
    };

    void loadSource();

    return () => {
      alive = false;
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
      } catch (err) {
        if (!alive) {
          return;
        }
        setError(err instanceof Error ? err.message : "Unknown error while loading dashboard data.");
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), 1500);

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, []);

  const timestampLabel = useMemo(() => {
    if (!metrics?.timestamp) {
      return "Waiting for stream...";
    }
    return `Updated: ${new Date(metrics.timestamp).toLocaleString()}`;
  }, [metrics?.timestamp]);

  const currentSourceLabel = metrics?.stream_source ?? streamSource;

  const feedUrl = useMemo(() => {
    const versionToken = currentSourceLabel ? encodeURIComponent(currentSourceLabel) : "default";
    return `${API_BASE}/video/feed?source=${versionToken}`;
  }, [currentSourceLabel]);

  const applySource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextSource = sourceDraft.trim();

    if (!nextSource) {
      setSourceFormError("Please enter a stream URL or file path.");
      return;
    }

    setSourceBusy(true);
    setSourceFormError(null);
    setSourceStatus(null);

    try {
      const updated = await updateStreamSource(nextSource);
      setStreamSource(updated.source);
      setDefaultSource(updated.default_source);
      setSourceDraft(updated.source);
      setSourceStatus("Stream source updated. Video and analytics will switch automatically.");
    } catch (err) {
      setSourceFormError(err instanceof Error ? err.message : "Unable to update stream source.");
    } finally {
      setSourceBusy(false);
    }
  };

  const restoreDefaultSource = async () => {
    setSourceBusy(true);
    setSourceFormError(null);
    setSourceStatus(null);

    try {
      const updated = await resetStreamSource();
      setStreamSource(updated.source);
      setDefaultSource(updated.default_source);
      setSourceDraft(updated.source);
      setSourceStatus("Default stream restored.");
    } catch (err) {
      setSourceFormError(err instanceof Error ? err.message : "Unable to reset stream source.");
    } finally {
      setSourceBusy(false);
    }
  };

  return (
    <main className="mx-auto grid w-[min(1280px,calc(100%-24px))] gap-4 py-4 md:w-[min(1280px,calc(100%-36px))] md:py-6">
      <section className="panel animate-floatIn rounded-3xl p-5 md:p-6">
        <div className="mb-5 flex flex-col gap-3 md:mb-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <div className="gradient-chip inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] text-white">
              Neo-Minimal Gradient
            </div>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">
              Queue Command Center
            </h1>
            <p className="text-sm text-muted md:text-base">
              Real-time computer vision intelligence with dynamic production recommendations.
            </p>
          </div>

          <div className="space-y-2 text-sm text-muted md:text-right">
            <div>
              <span className="mr-2 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
              <span className="display font-semibold text-graphite">Live Ops Feed</span>
            </div>
            <div>{timestampLabel}</div>
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

        {error ? (
          <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        ) : null}

        <form onSubmit={applySource} className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <label className="flex-1 text-sm text-slate-700">
              <span className="mb-1 block text-xs font-bold uppercase tracking-[0.12em] text-muted">Custom Stream Source</span>
              <input
                value={sourceDraft}
                onChange={(event) => setSourceDraft(event.target.value)}
                placeholder="rtsp://camera-url/live, http://stream-url, or /path/video.mp4"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={sourceBusy}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sourceBusy ? "Applying..." : "Apply Source"}
              </button>
              <button
                type="button"
                disabled={sourceBusy || !defaultSource}
                onClick={() => void restoreDefaultSource()}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Use Default
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">Active source: {currentSourceLabel || "loading..."}</p>
          {sourceStatus ? <p className="mt-2 text-xs text-emerald-700">{sourceStatus}</p> : null}
          {sourceFormError ? <p className="mt-2 text-xs text-red-600">{sourceFormError}</p> : null}
        </form>

        <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
          <div className="soft-hover overflow-hidden rounded-2xl border border-slate-200 bg-slate-900">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={feedUrl} alt="Live queue stream" className="block aspect-video w-full object-cover" />
          </div>

          <div className="grid gap-3">
            <div className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Queue Forecast</p>
              <p className="mt-2 display text-3xl font-semibold text-graphite">
                {reco?.forecast.projected_customers?.toFixed(1) ?? "0.0"}
              </p>
              <p className="text-sm text-muted">Projected customers in {reco?.forecast.horizon_min ?? 0} minutes</p>
              <p className="mt-2 text-sm text-slate-600">
                State: <span className="display font-semibold capitalize">{reco?.forecast.queue_state ?? "unknown"}</span>
              </p>
            </div>

            <div className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Decision Confidence</p>
              <p className="mt-2 display text-3xl font-semibold gradient-text">
                {reco ? `${Math.round(reco.forecast.confidence * 100)}%` : "0%"}
              </p>
              <p className="text-sm text-muted">Based on trend stability and processing throughput.</p>
            </div>
          </div>
        </div>

        <section className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Drive-Thru Cars</p>
            <p className="mt-2 display text-2xl font-semibold text-cyan-700">{metrics?.drive_thru.car_count ?? 0}</p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">In-Store People</p>
            <p className="mt-2 display text-2xl font-semibold text-emerald-700">{metrics?.in_store.person_count ?? 0}</p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Est. Wait Time</p>
            <p className="mt-2 display text-2xl font-semibold text-amber-700">
              {metrics?.aggregates.estimated_wait_time_min?.toFixed(1) ?? "0.0"} min
            </p>
          </article>
          <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Inference</p>
            <p className="mt-2 display text-2xl font-semibold text-graphite">{metrics?.inference_device ?? "-"}</p>
            <p className="text-sm text-muted">{metrics?.performance?.processing_fps?.toFixed(1) ?? "0.0"} FPS</p>
          </article>
        </section>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="panel rounded-3xl p-5 md:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="display text-xl font-semibold text-graphite">Dynamic Batch Plan</h2>
            <p className="text-sm text-muted">Per next cook cycle</p>
          </div>

          <div className="grid gap-3">
            {(reco?.recommendations ?? []).map((item) => (
              <article key={item.item} className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="display text-lg font-semibold text-graphite">{item.label}</h3>
                  <span
                    className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.08em] ${urgencyBadge[item.urgency]}`}
                  >
                    {item.urgency}
                  </span>
                </div>

                <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-3">
                  <p>
                    Recommend: <span className="display font-semibold">{item.recommended_batches} batch(es)</span>
                  </p>
                  <p>
                    Units: <span className="display font-semibold">{item.recommended_units}</span>
                  </p>
                  <p>
                    Baseline: <span className="display font-semibold">{item.baseline_batches} batch(es)</span>
                  </p>
                </div>

                <p className="mt-2 text-sm text-muted">{item.reason}</p>
              </article>
            ))}

            {reco?.recommendations.length ? null : (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-muted">
                Waiting for recommendations...
              </div>
            )}
          </div>
        </div>

        <aside className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Impact Snapshot</h2>
          <p className="mt-1 text-sm text-muted">Directional estimates versus a static drop schedule.</p>

          <div className="mt-4 grid gap-3">
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Waste Avoided</p>
              <p className="mt-2 display text-2xl font-semibold text-emerald-700">
                {reco?.impact.estimated_waste_avoided_units?.toFixed(1) ?? "0.0"} units
              </p>
            </article>
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Cost Savings</p>
              <p className="mt-2 display text-2xl font-semibold text-cyan-700">
                {formatMoney(reco?.impact.estimated_cost_saved_usd ?? 0)}
              </p>
            </article>
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Revenue Protected</p>
              <p className="mt-2 display text-2xl font-semibold gradient-text">
                {formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}
              </p>
            </article>
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Expected Wait Reduction</p>
              <p className="mt-2 display text-2xl font-semibold text-amber-700">
                {reco?.impact.estimated_wait_reduction_min?.toFixed(1) ?? "0.0"} min
              </p>
            </article>
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-muted">
            <p>
              Trend:{" "}
              <span className="display font-semibold text-graphite">
                {reco?.forecast.trend_customers_per_min?.toFixed(2) ?? "0.00"}
              </span>{" "}
              customers/min
            </p>
            <p>
              Drop cadence:{" "}
              <span className="display font-semibold text-graphite">{reco?.assumptions.drop_cadence_min ?? 0} min</span>
            </p>
            <p>
              Avg ticket:{" "}
              <span className="display font-semibold text-graphite">{formatMoney(reco?.assumptions.avg_ticket_usd ?? 0)}</span>
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
