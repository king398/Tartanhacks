"use client";

import { useEffect, useMemo, useState } from "react";

import {
  API_BASE,
  fetchDashboardData,
  fetchDemoReadiness,
  fetchStreamSources,
  resetStreamSourceForCamera,
  updateStreamSourceForCamera,
} from "@/app/lib/api";
import type {
  CameraId,
  DemoReadiness,
  DemoReadinessCheckStatus,
  Metrics,
  RecommendationItem,
  RecommendationResponse,
} from "@/app/lib/types";

const cameraIds: CameraId[] = ["drive_thru", "in_store"];

const cameraLabels: Record<CameraId, string> = {
  drive_thru: "Drive-Thru Camera",
  in_store: "In-Store Camera",
};

const urgencyBadge: Record<RecommendationItem["urgency"], string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-300",
  low: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

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

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function emptyCameraMap<T>(value: T): Record<CameraId, T> {
  return {
    drive_thru: value,
    in_store: value,
  };
}

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reco, setReco] = useState<RecommendationResponse | null>(null);
  const [readiness, setReadiness] = useState<DemoReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  const [streamSources, setStreamSources] = useState<Record<CameraId, string>>(emptyCameraMap(""));
  const [defaultSources, setDefaultSources] = useState<Record<CameraId, string>>(emptyCameraMap(""));
  const [sourceDrafts, setSourceDrafts] = useState<Record<CameraId, string>>(emptyCameraMap(""));
  const [sourceBusyByCamera, setSourceBusyByCamera] = useState<Record<CameraId, boolean>>(emptyCameraMap(false));
  const [sourceFormError, setSourceFormError] = useState<Record<CameraId, string | null>>(emptyCameraMap<string | null>(null));
  const [sourceStatus, setSourceStatus] = useState<Record<CameraId, string | null>>(emptyCameraMap<string | null>(null));

  useEffect(() => {
    let alive = true;

    const loadSources = async () => {
      try {
        const payload = await fetchStreamSources();
        if (!alive) {
          return;
        }

        const nextSources = emptyCameraMap("");
        const nextDefaults = emptyCameraMap("");

        for (const cameraId of cameraIds) {
          nextSources[cameraId] = payload.sources[cameraId]?.source ?? "";
          nextDefaults[cameraId] = payload.sources[cameraId]?.default_source ?? "";
        }

        setStreamSources(nextSources);
        setDefaultSources(nextDefaults);
        setSourceDrafts(nextSources);
      } catch (err) {
        if (!alive) {
          return;
        }
        const message = err instanceof Error ? err.message : "Could not load stream sources.";
        setSourceFormError(emptyCameraMap(message));
      }
    };

    void loadSources();

    return () => {
      alive = false;
    };
  }, []);

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
        setReadinessError(null);
      } catch (err) {
        if (!alive) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error while loading dashboard data.";
        setError(message);
        setReadinessError(message);
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

  const readinessClassName = readiness ? readinessBadge[readiness.status] ?? readinessBadge.blocked : readinessBadge.blocked;
  const highUrgencyCount = useMemo(
    () => (reco?.recommendations ?? []).filter((item) => item.urgency === "high").length,
    [reco?.recommendations],
  );

  const updateSourceDraft = (cameraId: CameraId, nextValue: string) => {
    setSourceDrafts((prev) => ({ ...prev, [cameraId]: nextValue }));
  };

  const applySource = async (cameraId: CameraId) => {
    const nextSource = sourceDrafts[cameraId].trim();

    if (!nextSource) {
      setSourceFormError((prev) => ({ ...prev, [cameraId]: "Please enter a stream URL or file path." }));
      return;
    }

    setSourceBusyByCamera((prev) => ({ ...prev, [cameraId]: true }));
    setSourceFormError((prev) => ({ ...prev, [cameraId]: null }));
    setSourceStatus((prev) => ({ ...prev, [cameraId]: null }));

    try {
      const updated = await updateStreamSourceForCamera(cameraId, nextSource);
      setStreamSources((prev) => ({ ...prev, [cameraId]: updated.source }));
      setDefaultSources((prev) => ({ ...prev, [cameraId]: updated.default_source }));
      setSourceDrafts((prev) => ({ ...prev, [cameraId]: updated.source }));
      setSourceStatus((prev) => ({
        ...prev,
        [cameraId]: `${cameraLabels[cameraId]} source updated.`,
      }));
    } catch (err) {
      setSourceFormError((prev) => ({
        ...prev,
        [cameraId]: err instanceof Error ? err.message : "Unable to update stream source.",
      }));
    } finally {
      setSourceBusyByCamera((prev) => ({ ...prev, [cameraId]: false }));
    }
  };

  const restoreDefaultSource = async (cameraId: CameraId) => {
    setSourceBusyByCamera((prev) => ({ ...prev, [cameraId]: true }));
    setSourceFormError((prev) => ({ ...prev, [cameraId]: null }));
    setSourceStatus((prev) => ({ ...prev, [cameraId]: null }));

    try {
      const updated = await resetStreamSourceForCamera(cameraId);
      setStreamSources((prev) => ({ ...prev, [cameraId]: updated.source }));
      setDefaultSources((prev) => ({ ...prev, [cameraId]: updated.default_source }));
      setSourceDrafts((prev) => ({ ...prev, [cameraId]: updated.source }));
      setSourceStatus((prev) => ({ ...prev, [cameraId]: `${cameraLabels[cameraId]} default source restored.` }));
    } catch (err) {
      setSourceFormError((prev) => ({
        ...prev,
        [cameraId]: err instanceof Error ? err.message : "Unable to reset stream source.",
      }));
    } finally {
      setSourceBusyByCamera((prev) => ({ ...prev, [cameraId]: false }));
    }
  };

  const activeBusinessName = reco?.business?.name ?? "Sample business";

  const feedUrlByCamera = useMemo(() => {
    const entries = cameraIds.map((cameraId) => {
      const sourceLabel = metrics?.cameras?.[cameraId]?.stream_source ?? streamSources[cameraId];
      const versionToken = sourceLabel ? encodeURIComponent(sourceLabel) : "default";
      return [cameraId, `${API_BASE}/video/feed/${cameraId}?source=${versionToken}`] as const;
    });

    return Object.fromEntries(entries) as Record<CameraId, string>;
  }, [metrics?.cameras, streamSources]);

  return (
    <main className="mx-auto grid w-[min(1280px,calc(100%-24px))] gap-4 py-4 md:w-[min(1280px,calc(100%-36px))] md:py-6">
      <section className="panel animate-floatIn rounded-3xl p-5 md:p-6">
        <div className="mb-5 flex flex-col gap-3 md:mb-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <div className="gradient-chip inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] text-white">
              Neo-Minimal Gradient
            </div>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">Queue Command Center</h1>
            <p className="text-sm text-muted md:text-base">
              Real-time computer vision intelligence with dynamic production recommendations.
            </p>
            <p className="text-sm text-slate-700">
              Active business: <span className="display font-semibold text-graphite">{activeBusinessName}</span>
            </p>
          </div>

          <div className="space-y-2 text-sm text-muted md:text-right">
            <div>
              <span className="mr-2 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
              <span className="display font-semibold text-graphite">Dual Camera Ops Feed</span>
            </div>
            <div>{timestampLabel}</div>
            <div className="text-xs">Backend: {API_BASE}</div>
          </div>
        </div>

        {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
        {readinessError && !error ? (
          <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{readinessError}</div>
        ) : null}

        <section className="mb-4 grid gap-3 xl:grid-cols-[1.5fr_1fr]">
          <article className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Judge Snapshot</p>
            <h2 className="mt-2 display text-xl font-semibold text-graphite">What This System Is Proving Live</h2>
            <p className="mt-1 text-sm text-slate-700">
              We combine dual-camera queue perception with demand forecasting to produce operational decisions that reduce wait time and prevent
              overproduction.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Queue State</p>
                <p className="display text-lg font-semibold capitalize text-graphite">{reco?.forecast.queue_state ?? "unknown"}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Projected Demand</p>
                <p className="display text-lg font-semibold text-cyan-700">{reco?.forecast.projected_customers?.toFixed(1) ?? "0.0"} cust</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">High-Urgency Items</p>
                <p className="display text-lg font-semibold text-amber-700">{highUrgencyCount}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Protected Revenue</p>
                <p className="display text-lg font-semibold text-emerald-700">{formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}</p>
              </div>
            </div>
          </article>

          <aside className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Demo Readiness</p>
                <h2 className="mt-2 display text-xl font-semibold text-graphite">
                  {readiness?.score ?? 0}
                  <span className="ml-1 text-sm font-medium text-muted">/100</span>
                </h2>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.08em] ${readinessClassName}`}>
                {readiness?.status ?? "blocked"}
              </span>
            </div>
            <div className="mt-3 grid gap-2">
              {(readiness?.checks ?? []).slice(0, 3).map((check) => (
                <div key={check.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-700">{check.label}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${checkStatusBadge[check.status]}`}>
                      {check.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{check.detail}</p>
                </div>
              ))}
              {readiness?.checks?.length ? null : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-muted">Waiting for readiness checks...</div>
              )}
            </div>
          </aside>
        </section>

        <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Camera Stream Sources</p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {cameraIds.map((cameraId) => {
              const busy = sourceBusyByCamera[cameraId];
              const cameraMetrics = metrics?.cameras?.[cameraId];
              const activeSource = cameraMetrics?.stream_source ?? streamSources[cameraId] ?? "";

              return (
                <article key={cameraId} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="display text-sm font-semibold text-graphite">{cameraLabels[cameraId]}</p>
                    <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                      {cameraMetrics?.stream_status ?? "initializing"}
                    </span>
                  </div>

                  <div className="flex flex-col gap-2 lg:flex-row">
                    <input
                      value={sourceDrafts[cameraId]}
                      onChange={(event) => updateSourceDraft(cameraId, event.target.value)}
                      placeholder="rtsp://camera-url/live, http://stream-url, /path/video.mp4, or 0"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void applySource(cameraId)}
                        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? "Applying..." : "Apply"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !defaultSources[cameraId]}
                        onClick={() => void restoreDefaultSource(cameraId)}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Default
                      </button>
                    </div>
                  </div>

                  <p className="mt-2 text-xs text-muted">Active source: {activeSource || "loading..."}</p>
                  {sourceStatus[cameraId] ? <p className="mt-1 text-xs text-emerald-700">{sourceStatus[cameraId]}</p> : null}
                  {sourceFormError[cameraId] ? <p className="mt-1 text-xs text-red-600">{sourceFormError[cameraId]}</p> : null}
                </article>
              );
            })}
          </div>
        </section>

        {metrics?.stream_status && metrics.stream_status !== "ok" ? (
          <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            One or more streams are unavailable. {metrics.stream_error ?? "Check source URL, credentials, and network reachability."}
          </div>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-2">
          {cameraIds.map((cameraId) => {
            const cameraMetrics = metrics?.cameras?.[cameraId];
            const cars = cameraMetrics?.drive_thru.car_count ?? 0;
            const passengers = cameraMetrics?.drive_thru.est_passengers ?? 0;
            const people = cameraMetrics?.in_store.person_count ?? 0;

            return (
              <article key={cameraId} className="soft-hover overflow-hidden rounded-2xl border border-slate-200 bg-slate-900">
                <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2 text-xs text-slate-200">
                  <span className="font-semibold tracking-[0.08em] uppercase">{cameraLabels[cameraId]}</span>
                  <span>Status: {cameraMetrics?.stream_status ?? "initializing"}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={feedUrlByCamera[cameraId]} alt={`${cameraLabels[cameraId]} live stream`} className="block aspect-video w-full object-cover" />
                <div className="grid grid-cols-2 gap-2 border-t border-slate-700 px-3 py-2 text-xs text-slate-200">
                  <span>Cars: {cars}</span>
                  <span>Passengers: {passengers.toFixed(1)}</span>
                  <span>People: {people}</span>
                  <span>FPS: {cameraMetrics?.performance?.processing_fps?.toFixed(1) ?? "0.0"}</span>
                </div>
              </article>
            );
          })}
        </section>

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
            <p className="mt-2 display text-2xl font-semibold text-amber-700">{metrics?.aggregates.estimated_wait_time_min?.toFixed(1) ?? "0.0"} min</p>
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
            <h2 className="display text-xl font-semibold text-graphite">Dynamic Drop Plan</h2>
            <p className="text-sm text-muted">Per next cook cycle</p>
          </div>

          <div className="grid gap-3">
            {(reco?.recommendations ?? []).map((item) => (
              <article key={item.item} className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="display text-lg font-semibold text-graphite">{item.label}</h3>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.08em] ${urgencyBadge[item.urgency]}`}>
                    {item.urgency}
                  </span>
                </div>

                <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-3">
                  <p>
                    Recommended Drop: <span className="display font-semibold">{item.recommended_units} units</span>
                  </p>
                  <p>
                    Baseline Drop: <span className="display font-semibold">{item.baseline_units} units</span>
                  </p>
                  <p>
                    Delta:{" "}
                    <span className="display font-semibold">
                      {item.delta_units > 0 ? `+${item.delta_units}` : item.delta_units} units
                    </span>
                  </p>
                </div>

                <p className="mt-2 text-sm text-muted">{item.reason}</p>
              </article>
            ))}

            {reco?.recommendations.length ? null : (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-muted">Waiting for recommendations...</div>
            )}
          </div>
        </div>

        <aside className="panel rounded-3xl p-5 md:p-6">
          <h2 className="display text-xl font-semibold text-graphite">Impact Snapshot</h2>
          <p className="mt-1 text-sm text-muted">Directional estimates versus a static drop schedule.</p>

          <div className="mt-4 grid gap-3">
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Waste Avoided</p>
              <p className="mt-2 display text-2xl font-semibold text-emerald-700">{reco?.impact.estimated_waste_avoided_units?.toFixed(1) ?? "0.0"} units</p>
            </article>
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Cost Savings</p>
              <p className="mt-2 display text-2xl font-semibold text-cyan-700">{formatMoney(reco?.impact.estimated_cost_saved_usd ?? 0)}</p>
            </article>
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Revenue Protected</p>
              <p className="mt-2 display text-2xl font-semibold gradient-text">{formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}</p>
            </article>
            <article className="soft-hover rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Expected Wait Reduction</p>
              <p className="mt-2 display text-2xl font-semibold text-amber-700">{reco?.impact.estimated_wait_reduction_min?.toFixed(1) ?? "0.0"} min</p>
            </article>
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-muted">
            <p>
              Trend: <span className="display font-semibold text-graphite">{reco?.forecast.trend_customers_per_min?.toFixed(2) ?? "0.00"}</span> customers/min
            </p>
            <p>
              Avg ticket: <span className="display font-semibold text-graphite">{formatMoney(reco?.assumptions.avg_ticket_usd ?? 0)}</span>
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
