import type {
  AnalyticsHistoryResponse,
  BusinessProfile,
  CameraId,
  DemoReadiness,
  Metrics,
  RecommendationFeedbackAction,
  RecommendationFeedbackSubmissionResponse,
  RecommendationFeedbackSummary,
  RecommendationResponse,
  StreamSourceResponse,
  StreamSourcesResponse,
} from "@/app/lib/types";

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

export async function fetchStreamSources(): Promise<StreamSourcesResponse> {
  const response = await fetch(`${API_BASE}/api/stream-sources`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Could not load stream sources.");
  }

  return (await response.json()) as StreamSourcesResponse;
}

export async function updateStreamSourceForCamera(cameraId: CameraId, source: string): Promise<StreamSourceResponse> {
  const response = await fetch(`${API_BASE}/api/stream-sources/${cameraId}`, {
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
      // Keep default detail.
    }
    throw new Error(detail);
  }

  return (await response.json()) as StreamSourceResponse;
}

export async function resetStreamSourceForCamera(cameraId: CameraId): Promise<StreamSourceResponse> {
  const response = await fetch(`${API_BASE}/api/stream-sources/${cameraId}/reset`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Unable to reset stream source.");
  }

  return (await response.json()) as StreamSourceResponse;
}

export async function fetchBusinessProfile(): Promise<BusinessProfile> {
  const response = await fetch(`${API_BASE}/api/business-profile`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Could not load business profile.");
  }

  return (await response.json()) as BusinessProfile;
}

export async function updateBusinessProfile(profile: BusinessProfile): Promise<BusinessProfile> {
  const response = await fetch(`${API_BASE}/api/business-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });

  if (!response.ok) {
    let detail = "Unable to save business profile.";
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) {
        detail = payload.detail;
      }
    } catch {
      // Keep default detail.
    }
    throw new Error(detail);
  }

  return (await response.json()) as BusinessProfile;
}

export async function resetBusinessProfile(): Promise<BusinessProfile> {
  const response = await fetch(`${API_BASE}/api/business-profile/reset`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Unable to load sample business profile.");
  }

  return (await response.json()) as BusinessProfile;
}

export async function fetchDemoReadiness(): Promise<DemoReadiness> {
  const response = await fetch(`${API_BASE}/api/demo-readiness`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Could not load demo readiness.");
  }

  return (await response.json()) as DemoReadiness;
}

export async function fetchAnalyticsHistory(params?: {
  minutes?: number;
  limit?: number;
  bucket_sec?: number;
}): Promise<AnalyticsHistoryResponse> {
  const searchParams = new URLSearchParams();
  if (params?.minutes !== undefined) {
    searchParams.set("minutes", String(params.minutes));
  }
  if (params?.limit !== undefined) {
    searchParams.set("limit", String(params.limit));
  }
  if (params?.bucket_sec !== undefined) {
    searchParams.set("bucket_sec", String(params.bucket_sec));
  }

  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const response = await fetch(`${API_BASE}/api/analytics/history${suffix}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not load analytics history.");
  }
  return (await response.json()) as AnalyticsHistoryResponse;
}

export async function submitRecommendationFeedback(payload: {
  item: string;
  action: RecommendationFeedbackAction;
  override_units?: number;
  note?: string;
}): Promise<RecommendationFeedbackSubmissionResponse> {
  const response = await fetch(`${API_BASE}/api/recommendation-feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = "Unable to submit recommendation feedback.";
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) {
        detail = body.detail;
      }
    } catch {
      // Keep default detail.
    }
    throw new Error(detail);
  }

  return (await response.json()) as RecommendationFeedbackSubmissionResponse;
}

export async function fetchRecommendationFeedbackSummary(params?: {
  minutes?: number;
  limit?: number;
}): Promise<RecommendationFeedbackSummary> {
  const searchParams = new URLSearchParams();
  if (params?.minutes !== undefined) {
    searchParams.set("minutes", String(params.minutes));
  }
  if (params?.limit !== undefined) {
    searchParams.set("limit", String(params.limit));
  }

  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const response = await fetch(`${API_BASE}/api/recommendation-feedback/summary${suffix}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not load recommendation feedback summary.");
  }
  return (await response.json()) as RecommendationFeedbackSummary;
}
