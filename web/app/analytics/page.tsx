"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { API_BASE, fetchAnalyticsHistory, fetchDashboardData } from "@/app/lib/api";
import type { AnalyticsHistoryPoint, Metrics, RecommendationResponse } from "@/app/lib/types";

type AnalyticsPoint = {
  id: number;
  timestamp: string;
  streamStatus: string;
  totalCustomers: number;
  waitMinutes: number;
  trend: number;
  confidence: number;
  processingFps: number;
  queueState: string;
};

const MAX_HISTORY_POINTS = 1800;
const DEFAULT_HISTORY_WINDOW_MIN = 240;
const CHART_WIDTH = 560;
const CHART_HEIGHT = 200;
const CHART_MARGIN_LEFT = 56;
const CHART_MARGIN_RIGHT = 16;
const CHART_MARGIN_TOP = 18;
const CHART_MARGIN_BOTTOM = 52;
const CUSTOMER_SMOOTHING_ALPHA = 0.24;
const WAIT_SMOOTHING_ALPHA = 0.2;

const analyticsPageCache: {
  metrics: Metrics | null;
  reco: RecommendationResponse | null;
  history: AnalyticsPoint[];
  lastPointId: number;
} = {
  metrics: null,
  reco: null,
  history: [],
  lastPointId: 0,
};

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function mapHistoryPoint(point: AnalyticsHistoryPoint): AnalyticsPoint {
  return {
    id: point.id,
    timestamp: point.timestamp,
    streamStatus: point.stream_status,
    totalCustomers: point.total_customers,
    waitMinutes: point.wait_minutes,
    trend: point.trend,
    confidence: point.confidence,
    processingFps: point.processing_fps,
    queueState: point.queue_state,
  };
}

type ChartScaleTick = {
  y: number;
  label: string;
};

type ChartTimeTick = {
  x: number;
  label: string;
};

type ChartScale = {
  yMin: number;
  yMax: number;
  yTicks: ChartScaleTick[];
  xTicks: ChartTimeTick[];
};

type ChartPoint = {
  x: number;
  y: number;
};

function _plotWidth(): number {
  return CHART_WIDTH - CHART_MARGIN_LEFT - CHART_MARGIN_RIGHT;
}

function _plotHeight(): number {
  return CHART_HEIGHT - CHART_MARGIN_TOP - CHART_MARGIN_BOTTOM;
}

function _formatTimeTick(timestamp: string): string {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return "--:--";
  }
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function _buildChartScale(
  values: number[],
  timestamps: string[],
  formatYValue: (value: number) => string,
): ChartScale {
  const hasValues = values.length > 0;
  const maxValue = hasValues ? Math.max(...values) : 1;
  const yMin = 0;
  const yMax = Math.max(1, maxValue * 1.08);
  const range = Math.max(1e-6, yMax - yMin);

  const yTicks: ChartScaleTick[] = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    const value = yMax - ratio * range;
    return {
      y: CHART_MARGIN_TOP + ratio * _plotHeight(),
      label: formatYValue(value),
    };
  });

  if (!timestamps.length) {
    return {
      yMin,
      yMax,
      yTicks,
      xTicks: [
        { x: CHART_MARGIN_LEFT, label: "Start" },
        { x: CHART_MARGIN_LEFT + _plotWidth(), label: "Now" },
      ],
    };
  }

  const rawIndices = [0, timestamps.length - 1];
  const uniqueIndices = Array.from(new Set(rawIndices));
  const xTicks: ChartTimeTick[] = uniqueIndices.map((index) => ({
    x:
      timestamps.length === 1
        ? CHART_MARGIN_LEFT + _plotWidth() / 2
        : CHART_MARGIN_LEFT + (index / (timestamps.length - 1)) * _plotWidth(),
    label: _formatTimeTick(timestamps[index]),
  }));

  return { yMin, yMax, yTicks, xTicks };
}

function sparklinePath(values: number[], { yMin, yMax }: { yMin: number; yMax: number }): string {
  if (values.length === 0) {
    return "";
  }

  const range = Math.max(1e-6, yMax - yMin);
  const plotWidth = _plotWidth();
  const plotHeight = _plotHeight();

  return values
    .map((value, index) => {
      const x =
        values.length === 1
          ? CHART_MARGIN_LEFT + plotWidth / 2
          : CHART_MARGIN_LEFT + (index / (values.length - 1)) * plotWidth;
      const y = CHART_MARGIN_TOP + (1 - (value - yMin) / range) * plotHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function sparklineEndpoint(values: number[], { yMin, yMax }: { yMin: number; yMax: number }): ChartPoint | null {
  if (values.length === 0) {
    return null;
  }
  const range = Math.max(1e-6, yMax - yMin);
  const plotWidth = _plotWidth();
  const plotHeight = _plotHeight();
  const index = values.length - 1;
  const x =
    values.length === 1
      ? CHART_MARGIN_LEFT + plotWidth / 2
      : CHART_MARGIN_LEFT + (index / (values.length - 1)) * plotWidth;
  const y = CHART_MARGIN_TOP + (1 - (values[index] - yMin) / range) * plotHeight;
  return { x, y };
}

function smoothSeriesEma(values: number[], alpha: number): number[] {
  if (values.length <= 2) {
    return values;
  }

  const safeAlpha = Math.max(0.01, Math.min(0.99, alpha));
  const smoothed: number[] = [values[0]];

  for (let index = 1; index < values.length; index += 1) {
    const previous = smoothed[index - 1];
    const nextValue = safeAlpha * values[index] + (1 - safeAlpha) * previous;
    smoothed.push(nextValue);
  }

  return smoothed;
}

export default function AnalyticsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(() => analyticsPageCache.metrics);
  const [reco, setReco] = useState<RecommendationResponse | null>(() => analyticsPageCache.reco);
  const [history, setHistory] = useState<AnalyticsPoint[]>(() => analyticsPageCache.history);
  const [error, setError] = useState<string | null>(null);
  const lastPointIdRef = useRef<number>(analyticsPageCache.lastPointId);

  useEffect(() => {
    let alive = true;

    const loadInitial = async () => {
      try {
        const [[metricsData, recoData], historyPayload] = await Promise.all([
          fetchDashboardData(),
          fetchAnalyticsHistory({
            minutes: DEFAULT_HISTORY_WINDOW_MIN,
            limit: MAX_HISTORY_POINTS,
            bucket_sec: 1,
          }),
        ]);
        if (!alive) {
          return;
        }

        const points = historyPayload.points.map(mapHistoryPoint).slice(-MAX_HISTORY_POINTS);
        const latestPointId = points[points.length - 1]?.id ?? lastPointIdRef.current;

        setMetrics(metricsData);
        setReco(recoData);
        setHistory(points);
        setError(null);

        analyticsPageCache.metrics = metricsData;
        analyticsPageCache.reco = recoData;
        analyticsPageCache.history = points;
        analyticsPageCache.lastPointId = latestPointId;
        lastPointIdRef.current = latestPointId;
      } catch (err) {
        if (!alive) {
          return;
        }
        setError(err instanceof Error ? err.message : "Unknown analytics loading error.");
      }
    };

    if (!analyticsPageCache.history.length) {
      void loadInitial();
      return () => {
        alive = false;
      };
    }

    setMetrics(analyticsPageCache.metrics);
    setReco(analyticsPageCache.reco);
    setHistory(analyticsPageCache.history);
    void loadInitial();

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
        analyticsPageCache.metrics = metricsData;
        analyticsPageCache.reco = recoData;
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

  useEffect(() => {
    const streamUrl = `${API_BASE}/api/analytics/live?last_id=${encodeURIComponent(String(lastPointIdRef.current))}`;
    const eventSource = new EventSource(streamUrl);

    const onAnalyticsEvent = (event: MessageEvent<string>) => {
      try {
        const point = mapHistoryPoint(JSON.parse(event.data) as AnalyticsHistoryPoint);
        if (point.id <= lastPointIdRef.current) {
          return;
        }

        lastPointIdRef.current = point.id;
        analyticsPageCache.lastPointId = point.id;

        setHistory((prev) => {
          const deduped = prev.filter((existing) => existing.id !== point.id);
          const next = [...deduped, point].slice(-MAX_HISTORY_POINTS);
          analyticsPageCache.history = next;
          return next;
        });
      } catch {
        // Ignore malformed streaming payloads and keep stream alive.
      }
    };

    eventSource.addEventListener("analytics", onAnalyticsEvent as EventListener);
    return () => {
      eventSource.removeEventListener("analytics", onAnalyticsEvent as EventListener);
      eventSource.close();
    };
  }, []);

  const usableHistory = useMemo(() => {
    const okPoints = history.filter((point) => point.streamStatus === "ok");
    return okPoints.length ? okPoints : history;
  }, [history]);

  const summary = useMemo(() => {
    if (!usableHistory.length) {
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

    const totalWait = usableHistory.reduce((sum, point) => sum + point.waitMinutes, 0);
    const totalTrend = usableHistory.reduce((sum, point) => sum + point.trend, 0);
    const totalConfidence = usableHistory.reduce((sum, point) => sum + point.confidence, 0);
    const totalFps = usableHistory.reduce((sum, point) => sum + point.processingFps, 0);
    const customers = usableHistory.map((point) => point.totalCustomers);
    const queueShift = usableHistory[usableHistory.length - 1].totalCustomers - usableHistory[0].totalCustomers;

    return {
      avgWait: totalWait / usableHistory.length,
      peakCustomers: Math.max(...customers),
      minCustomers: Math.min(...customers),
      avgTrend: totalTrend / usableHistory.length,
      avgConfidence: totalConfidence / usableHistory.length,
      avgFps: totalFps / usableHistory.length,
      queueShift,
    };
  }, [usableHistory]);

  const activityNarrative = useMemo(() => {
    if (!reco || !metrics) {
      return "Collecting enough data to summarize activity patterns.";
    }

    const state = reco.forecast.queue_state;
    const trend = reco.forecast.trend_customers_per_min;
    const wait = metrics.aggregates.estimated_wait_time_min;

    if (state === "surging") {
      return `Demand is rising (${trend.toFixed(2)} customers/min) and current wait is ${wait.toFixed(1)} min. Prioritize recommended unit increases now.`;
    }

    if (state === "falling") {
      return `Demand is easing (${trend.toFixed(2)} customers/min) with ${wait.toFixed(1)} min wait. Reduce production to prevent waste while maintaining baseline readiness.`;
    }

    return `Queue is stable (${trend.toFixed(2)} customers/min) with ${wait.toFixed(1)} min wait. Keep recommended cycle sizes and monitor for short spikes.`;
  }, [metrics, reco]);

  const customerValues = useMemo(() => usableHistory.map((point) => point.totalCustomers), [usableHistory]);
  const customerTimestamps = useMemo(() => usableHistory.map((point) => point.timestamp), [usableHistory]);
  const waitValues = useMemo(() => usableHistory.map((point) => point.waitMinutes), [usableHistory]);
  const waitTimestamps = useMemo(() => usableHistory.map((point) => point.timestamp), [usableHistory]);
  const smoothedCustomerValues = useMemo(
    () => smoothSeriesEma(customerValues, CUSTOMER_SMOOTHING_ALPHA),
    [customerValues],
  );
  const smoothedWaitValues = useMemo(
    () => smoothSeriesEma(waitValues, WAIT_SMOOTHING_ALPHA),
    [waitValues],
  );

  const customerScale = useMemo(
    () =>
      _buildChartScale([...customerValues, ...smoothedCustomerValues], customerTimestamps, (value) => {
        if (value >= 10) {
          return value.toFixed(0);
        }
        return value.toFixed(1);
      }),
    [customerTimestamps, customerValues, smoothedCustomerValues],
  );

  const waitScale = useMemo(
    () => _buildChartScale([...waitValues, ...smoothedWaitValues], waitTimestamps, (value) => value.toFixed(1)),
    [smoothedWaitValues, waitTimestamps, waitValues],
  );

  const customersSparkline = useMemo(
    () => sparklinePath(smoothedCustomerValues, { yMin: customerScale.yMin, yMax: customerScale.yMax }),
    [customerScale.yMax, customerScale.yMin, smoothedCustomerValues],
  );
  const customerEndpoint = useMemo(
    () => sparklineEndpoint(smoothedCustomerValues, { yMin: customerScale.yMin, yMax: customerScale.yMax }),
    [customerScale.yMax, customerScale.yMin, smoothedCustomerValues],
  );

  const waitSparkline = useMemo(
    () => sparklinePath(smoothedWaitValues, { yMin: waitScale.yMin, yMax: waitScale.yMax }),
    [smoothedWaitValues, waitScale.yMax, waitScale.yMin],
  );
  const waitEndpoint = useMemo(
    () => sparklineEndpoint(smoothedWaitValues, { yMin: waitScale.yMin, yMax: waitScale.yMax }),
    [smoothedWaitValues, waitScale.yMax, waitScale.yMin],
  );

  return (
    <main className="mx-auto grid w-[min(1280px,calc(100%-24px))] gap-3 py-3 md:w-[min(1280px,calc(100%-36px))] md:py-4">
      <section className="panel rounded-3xl p-4 md:p-5">
        <div className="mb-3">
          <div>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">Live Analytics</h1>
            <p className="text-sm text-muted md:text-base">Rolling analysis of queue pressure, wait-time risk, and recommendation confidence.</p>
          </div>
        </div>

        {error ? <div className="mb-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
        {metrics?.stream_status && metrics.stream_status !== "ok" ? (
          <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            One or more streams are unavailable. {metrics.stream_error ?? "Check source URL, credentials, and network reachability."}
          </div>
        ) : null}

        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Queue State</p>
            <p className="mt-2 display text-2xl font-semibold capitalize text-sky-900">{reco?.forecast.queue_state ?? "unknown"}</p>
            <p className="text-sm text-muted">Trend {reco?.forecast.trend_customers_per_min?.toFixed(2) ?? "0.00"} cust/min</p>
          </article>
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Average Wait</p>
            <p className="mt-2 display text-2xl font-semibold text-amber-700">{summary.avgWait.toFixed(1)} min</p>
            <p className="text-sm text-muted">Current {metrics?.aggregates.estimated_wait_time_min?.toFixed(1) ?? "0.0"} min</p>
          </article>
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Peak Customer Load</p>
            <p className="mt-2 display text-2xl font-semibold text-sky-700">{summary.peakCustomers.toFixed(1)}</p>
            <p className="text-sm text-muted">Low {summary.minCustomers.toFixed(1)} / Shift {summary.queueShift.toFixed(1)}</p>
          </article>
          <article className="soft-hover accent-card rounded-2xl border p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Model Quality</p>
            <p className="mt-2 display text-2xl font-semibold gradient-text">{Math.round(summary.avgConfidence * 100)}%</p>
            <p className="text-sm text-muted">Avg {summary.avgFps.toFixed(1)} FPS</p>
          </article>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <article className="panel rounded-3xl p-4 md:p-5">
          <h2 className="display text-xl font-semibold text-graphite">Customer Load Timeline</h2>
          <p className="mt-1 text-sm text-muted">Recent total customer estimates from computer-vision tracking (EMA smoothed).</p>
          <div className="mt-3 rounded-2xl border accent-card p-3">
            <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="h-44 w-full" role="img" aria-label="Total customers trend with labeled axes">
              {customerScale.yTicks.map((tick, index) => (
                <g key={`customers-y-${index}`}>
                  <line
                    x1={CHART_MARGIN_LEFT}
                    y1={tick.y}
                    x2={CHART_WIDTH - CHART_MARGIN_RIGHT}
                    y2={tick.y}
                    stroke={index === customerScale.yTicks.length - 1 ? "#93c5fd" : "#dbeafe"}
                    strokeWidth="1"
                  />
                  <text x={CHART_MARGIN_LEFT - 8} y={tick.y + 4} textAnchor="end" fill="#64748b" fontSize="10" fontWeight="600">
                    {tick.label}
                  </text>
                </g>
              ))}
              {customerScale.xTicks.map((tick, index) => (
                <g key={`customers-x-${index}`}>
                  <line
                    x1={tick.x}
                    y1={CHART_HEIGHT - CHART_MARGIN_BOTTOM}
                    x2={tick.x}
                    y2={CHART_HEIGHT - CHART_MARGIN_BOTTOM + 5}
                    stroke="#93c5fd"
                    strokeWidth="1"
                  />
                  <text
                    x={tick.x}
                    y={CHART_HEIGHT - CHART_MARGIN_BOTTOM + 18}
                    textAnchor={index === 0 ? "start" : index === customerScale.xTicks.length - 1 ? "end" : "middle"}
                    fill="#64748b"
                    fontSize="10"
                    fontWeight="600"
                  >
                    {tick.label}
                  </text>
                </g>
              ))}
              <path d={customersSparkline} fill="none" stroke="#0284c7" strokeWidth="3.5" strokeLinecap="round" />
              {customerEndpoint ? <circle cx={customerEndpoint.x} cy={customerEndpoint.y} r="4.8" fill="#0284c7" stroke="#ffffff" strokeWidth="2" /> : null}
              <text x={CHART_MARGIN_LEFT} y={CHART_MARGIN_TOP - 3} fill="#64748b" fontSize="11" fontWeight="600">
                Customers (Y)
              </text>
              <text x={CHART_WIDTH / 2} y={CHART_HEIGHT - 8} textAnchor="middle" fill="#64748b" fontSize="11" fontWeight="600">
                Time (older to newer) (X)
              </text>
            </svg>
          </div>
        </article>

        <article className="panel rounded-3xl p-4 md:p-5">
          <h2 className="display text-xl font-semibold text-graphite">Estimated Wait Timeline</h2>
          <p className="mt-1 text-sm text-muted">How queue dynamics are translating into service delay risk (EMA smoothed).</p>
          <div className="mt-3 rounded-2xl border accent-card p-3">
            <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="h-44 w-full" role="img" aria-label="Estimated wait trend with labeled axes">
              {waitScale.yTicks.map((tick, index) => (
                <g key={`wait-y-${index}`}>
                  <line
                    x1={CHART_MARGIN_LEFT}
                    y1={tick.y}
                    x2={CHART_WIDTH - CHART_MARGIN_RIGHT}
                    y2={tick.y}
                    stroke={index === waitScale.yTicks.length - 1 ? "#93c5fd" : "#dbeafe"}
                    strokeWidth="1"
                  />
                  <text x={CHART_MARGIN_LEFT - 8} y={tick.y + 4} textAnchor="end" fill="#64748b" fontSize="10" fontWeight="600">
                    {tick.label}
                  </text>
                </g>
              ))}
              {waitScale.xTicks.map((tick, index) => (
                <g key={`wait-x-${index}`}>
                  <line
                    x1={tick.x}
                    y1={CHART_HEIGHT - CHART_MARGIN_BOTTOM}
                    x2={tick.x}
                    y2={CHART_HEIGHT - CHART_MARGIN_BOTTOM + 5}
                    stroke="#93c5fd"
                    strokeWidth="1"
                  />
                  <text
                    x={tick.x}
                    y={CHART_HEIGHT - CHART_MARGIN_BOTTOM + 18}
                    textAnchor={index === 0 ? "start" : index === waitScale.xTicks.length - 1 ? "end" : "middle"}
                    fill="#64748b"
                    fontSize="10"
                    fontWeight="600"
                  >
                    {tick.label}
                  </text>
                </g>
              ))}
              <path d={waitSparkline} fill="none" stroke="#2563eb" strokeWidth="3.5" strokeLinecap="round" />
              {waitEndpoint ? <circle cx={waitEndpoint.x} cy={waitEndpoint.y} r="4.8" fill="#2563eb" stroke="#ffffff" strokeWidth="2" /> : null}
              <text x={CHART_MARGIN_LEFT} y={CHART_MARGIN_TOP - 3} fill="#64748b" fontSize="11" fontWeight="600">
                Wait Minutes (Y)
              </text>
              <text x={CHART_WIDTH / 2} y={CHART_HEIGHT - 8} textAnchor="middle" fill="#64748b" fontSize="11" fontWeight="600">
                Time (older to newer) (X)
              </text>
            </svg>
          </div>
        </article>
      </section>

      <section className="grid gap-3">
        <article className="panel rounded-3xl p-4 md:p-5">
          <h2 className="display text-xl font-semibold text-graphite">What Is Happening Right Now</h2>
          <p className="mt-2.5 rounded-2xl border accent-card p-3 text-sm text-slate-700">{activityNarrative}</p>

          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            <article className="accent-card rounded-2xl border p-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Projected Customers</p>
              <p className="mt-2 display text-2xl font-semibold text-graphite">
                {reco?.forecast.projected_customers?.toFixed(1) ?? "0.0"}
              </p>
              <p className="text-sm text-muted">Horizon {reco?.forecast.horizon_min ?? 0} min</p>
            </article>
            <article className="accent-card rounded-2xl border p-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Protected Revenue</p>
              <p className="mt-2 display text-2xl font-semibold text-emerald-700">
                {formatMoney(reco?.impact.estimated_revenue_protected_usd ?? 0)}
              </p>
              <p className="text-sm text-muted">Directional estimate</p>
            </article>
          </div>
        </article>
      </section>
    </main>
  );
}
