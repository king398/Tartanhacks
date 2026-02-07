"use client";

import { useEffect, useMemo, useState } from "react";

import {
  API_BASE,
  fetchDashboardData,
  fetchStreamSources,
  resetStreamSourceForCamera,
  updateStreamSourceForCamera,
} from "@/app/lib/api";
import type {
  CameraId,
  Metrics,
  RecommendationResponse,
} from "@/app/lib/types";

const cameraIds: CameraId[] = ["drive_thru", "in_store"];

const cameraLabels: Record<CameraId, string> = {
  drive_thru: "Drive-Thru Camera",
  in_store: "In-Store Camera",
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
  const [error, setError] = useState<string | null>(null);

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
        const message = err instanceof Error ? err.message : "Unknown error while loading dashboard data.";
        setError(message);
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), 1500);

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, []);

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
    <main className="mx-auto grid w-[min(1280px,calc(100%-24px))] gap-3 py-3 md:w-[min(1280px,calc(100%-36px))] md:py-4">
      <section className="panel animate-floatIn rounded-3xl p-4 md:p-5">
        <div className="mb-3 flex flex-col gap-2 md:mb-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1.5">
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">Queue Command Center</h1>
            <p className="text-sm text-muted md:text-base">
              Real-time computer vision intelligence with dynamic production recommendations.
            </p>
            <p className="text-sm text-slate-700">
              Active business: <span className="display font-semibold text-graphite">{activeBusinessName}</span>
            </p>
          </div>

          <div className="space-y-1 text-sm text-muted md:text-right">
            <div>
              <span className="mr-2 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-sky-500" />
              <span className="display font-semibold text-sky-900">Dual Camera Ops Feed</span>
            </div>
          </div>
        </div>

        {error ? <div className="mb-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

        <section className="mb-3 rounded-2xl border accent-card p-3">
          <div className="mb-2">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Camera Stream Sources</p>
          </div>

          <div className="grid gap-2.5 lg:grid-cols-2">
            {cameraIds.map((cameraId) => {
              const busy = sourceBusyByCamera[cameraId];
              const cameraMetrics = metrics?.cameras?.[cameraId];
              const activeSource = cameraMetrics?.stream_source ?? streamSources[cameraId] ?? "";

              return (
                <article key={cameraId} className="rounded-2xl border accent-card p-3">
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
                      className="accent-input w-full rounded-xl border border-slate-300 px-3 py-1.5 text-sm text-slate-800 focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void applySource(cameraId)}
                        className="accent-button rounded-xl px-4 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? "Applying..." : "Apply"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !defaultSources[cameraId]}
                        onClick={() => void restoreDefaultSource(cameraId)}
                        className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-1.5 text-sm font-semibold text-sky-800 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Default
                      </button>
                    </div>
                  </div>

                  <p className="mt-1.5 text-xs text-muted">Active source: {activeSource || "loading..."}</p>
                  {sourceStatus[cameraId] ? <p className="mt-1 text-xs text-emerald-700">{sourceStatus[cameraId]}</p> : null}
                  {sourceFormError[cameraId] ? <p className="mt-1 text-xs text-red-600">{sourceFormError[cameraId]}</p> : null}
                </article>
              );
            })}
          </div>
        </section>

        {metrics?.stream_status && metrics.stream_status !== "ok" ? (
          <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            One or more streams are unavailable. {metrics.stream_error ?? "Check source URL, credentials, and network reachability."}
          </div>
        ) : null}

        <section className="grid gap-3 lg:grid-cols-2">
          {cameraIds.map((cameraId) => {
            const cameraMetrics = metrics?.cameras?.[cameraId];
            const cars = cameraMetrics?.drive_thru.car_count ?? 0;
            const passengers = cameraMetrics?.drive_thru.est_passengers ?? 0;
            const people = cameraMetrics?.in_store.person_count ?? 0;

            return (
              <article key={cameraId} className="soft-hover overflow-hidden rounded-2xl border border-sky-300/50 bg-[#0d2741]">
                <div className="flex items-center justify-between border-b border-sky-700/60 px-3 py-2 text-xs text-sky-100">
                  <span className="font-semibold tracking-[0.08em] uppercase">{cameraLabels[cameraId]}</span>
                  <span>Status: {cameraMetrics?.stream_status ?? "initializing"}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={feedUrlByCamera[cameraId]} alt={`${cameraLabels[cameraId]} live stream`} className="block aspect-video w-full object-cover" />
                <div className="grid grid-cols-2 gap-2 border-t border-sky-700/60 px-3 py-2 text-xs text-sky-100">
                  <span>Cars: {cars}</span>
                  <span>Passengers: {passengers.toFixed(1)}</span>
                  <span>People: {people}</span>
                  <span>FPS: {cameraMetrics?.performance?.processing_fps?.toFixed(1) ?? "0.0"}</span>
                </div>
              </article>
            );
          })}
        </section>

        <section className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Drive-Thru Cars</p>
            <p className="mt-2 display text-2xl font-semibold text-sky-700">{metrics?.drive_thru.car_count ?? 0}</p>
          </article>
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">In-Store People</p>
            <p className="mt-2 display text-2xl font-semibold text-emerald-700">{metrics?.in_store.person_count ?? 0}</p>
          </article>
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Est. Wait Time</p>
            <p className="mt-2 display text-2xl font-semibold text-amber-700">{metrics?.aggregates.estimated_wait_time_min?.toFixed(1) ?? "0.0"} min</p>
          </article>
        </section>
      </section>

      <section className="grid gap-3">
        <aside className="panel rounded-3xl p-4 md:p-5">
          <h2 className="display text-xl font-semibold text-graphite">Impact Snapshot</h2>
          <p className="mt-1 text-sm text-muted">Directional estimates versus a static drop schedule.</p>

          <div className="mt-3 grid gap-2.5">
            <article className="soft-hover accent-card rounded-2xl border p-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Waste Avoided</p>
              <p className="mt-2 display text-2xl font-semibold text-emerald-700">{reco?.impact.estimated_waste_avoided_units?.toFixed(1) ?? "0.0"} units</p>
            </article>
            <article className="soft-hover accent-card rounded-2xl border p-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Cost Savings</p>
              <p className="mt-2 display text-2xl font-semibold text-sky-700">{formatMoney(reco?.impact.estimated_cost_saved_usd ?? 0)}</p>
            </article>
            <article className="soft-hover accent-card rounded-2xl border p-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Revenue Protected</p>
              <p className="mt-2 display text-2xl font-semibold gradient-text">{formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}</p>
            </article>
            <article className="soft-hover accent-card rounded-2xl border p-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Expected Wait Reduction</p>
              <p className="mt-2 display text-2xl font-semibold text-amber-700">{reco?.impact.estimated_wait_reduction_min?.toFixed(1) ?? "0.0"} min</p>
            </article>
          </div>

          <div className="mt-3 rounded-2xl border accent-card p-3 text-sm text-muted">
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
