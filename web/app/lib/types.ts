export type CameraId = "drive_thru" | "in_store";

export type CameraMetrics = {
  timestamp: string;
  stream_source?: string;
  stream_status?: "ok" | "error" | "initializing" | string;
  stream_error?: string | null;
  drive_thru: { car_count: number; est_passengers: number };
  in_store: { person_count: number };
  aggregates: {
    total_customers: number;
    avg_service_time_sec: number;
    estimated_wait_time_min: number;
  };
  inference_device: string;
  performance?: { processing_fps: number };
};

export type Metrics = {
  timestamp: string;
  stream_source?: string;
  stream_status?: "ok" | "error" | "initializing" | "degraded" | string;
  stream_error?: string | null;
  drive_thru: { car_count: number; est_passengers: number };
  in_store: { person_count: number };
  aggregates: {
    total_customers: number;
    avg_service_time_sec: number;
    estimated_wait_time_min: number;
  };
  inference_device: string;
  performance?: { processing_fps: number };
  cameras?: Record<CameraId, CameraMetrics>;
};

export type RecommendationItem = {
  item: string;
  label: string;
  recommended_batches: number;
  recommended_units: number;
  baseline_batches: number;
  baseline_units: number;
  max_unit_size?: number;
  delta_batches: number;
  urgency: "high" | "medium" | "low";
  reason: string;
};

export type RecommendationResponse = {
  timestamp: string;
  business?: {
    name: string;
    type: string;
    location: string;
    service_model: string;
  };
  forecast: {
    horizon_min: number;
    queue_state: string;
    trend_customers_per_min: number;
    current_customers: number;
    projected_customers: number;
    confidence: number;
  };
  recommendations: RecommendationItem[];
  impact: {
    estimated_wait_reduction_min: number;
    estimated_waste_avoided_units: number;
    estimated_cost_saved_usd: number;
    estimated_revenue_protected_usd: number;
    current_wait_time_min: number;
  };
  assumptions: {
    drop_cadence_min: number;
    avg_ticket_usd: number;
    notes: string[];
  };
};

export type StreamSourceResponse = {
  camera_id?: CameraId;
  source: string;
  default_source: string;
};

export type StreamSourcesResponse = {
  sources: Record<CameraId, StreamSourceResponse>;
};

export type MenuItemProfile = {
  key?: string;
  label: string;
  units_per_order: number;
  batch_size: number;
  max_unit_size: number;
  baseline_drop_units: number;
  unit_cost_usd: number;
};

export type BusinessProfile = {
  business_name: string;
  business_type: string;
  location: string;
  service_model: string;
  drop_cadence_min: number;
  avg_ticket_usd: number;
  menu_items: MenuItemProfile[];
};

export type DemoReadinessCheckStatus = "pass" | "warn" | "fail";

export type DemoReadinessCheck = {
  id: string;
  label: string;
  status: DemoReadinessCheckStatus;
  detail: string;
  points: number;
};

export type DemoReadiness = {
  timestamp: string;
  score: number;
  status: "ready" | "degraded" | "blocked" | string;
  blockers: string[];
  summary: {
    stream_status: "ok" | "degraded" | "error" | "initializing" | string;
    data_age_sec: number;
    processing_fps: number;
    camera_statuses: Record<CameraId, string>;
    business_name: string;
    menu_item_count: number;
  };
  checks: DemoReadinessCheck[];
};

export type AnalyticsHistoryPoint = {
  id: number;
  timestamp: string;
  stream_status: string;
  total_customers: number;
  wait_minutes: number;
  trend: number;
  confidence: number;
  processing_fps: number;
  queue_state: string;
  projected_customers: number;
  revenue_protected_usd: number;
  wait_reduction_min: number;
};

export type AnalyticsHistoryResponse = {
  timestamp: string;
  window_minutes: number;
  bucket_sec: number;
  count: number;
  points: AnalyticsHistoryPoint[];
};
