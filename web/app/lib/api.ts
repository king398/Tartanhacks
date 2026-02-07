import type { Metrics, RecommendationResponse, StreamSourceResponse } from "@/app/lib/types";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export async function fetchDashboardData(): Promise<[Metrics, RecommendationResponse]> {
  const [metricsRes, recoRes] = await Promise.all([
    fetch(`${API_BASE}/api/metrics`, { cache: "no-store" }),
    fetch(`${API_BASE}/api/recommendations`, { cache: "no-store" }),
  ]);

  if (!metricsRes.ok || !recoRes.ok) {
    throw new Error("Backend endpoints are unavailable.");
  }

  return (await Promise.all([metricsRes.json(), recoRes.json()])) as [Metrics, RecommendationResponse];
}

export async function fetchStreamSource(): Promise<StreamSourceResponse> {
  const response = await fetch(`${API_BASE}/api/stream-source`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not load the current stream source.");
  }
  return (await response.json()) as StreamSourceResponse;
}

export async function updateStreamSource(source: string): Promise<StreamSourceResponse> {
  const response = await fetch(`${API_BASE}/api/stream-source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });

  if (!response.ok) {
    let detail = "Unable to update stream source.";
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) {
        detail = payload.detail;
      }
    } catch {
      // Keep default error message.
    }
    throw new Error(detail);
  }

  return (await response.json()) as StreamSourceResponse;
}

export async function resetStreamSource(): Promise<StreamSourceResponse> {
  const response = await fetch(`${API_BASE}/api/stream-source/reset`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Unable to reset stream source.");
  }

  return (await response.json()) as StreamSourceResponse;
}
