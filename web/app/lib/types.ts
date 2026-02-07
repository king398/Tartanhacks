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
  unit_label?: string;
  recommended_units: number;
  baseline_units: number;
  max_unit_size?: number;
  delta_units: number;
  ready_inventory_units?: number;
  fryer_inventory_units?: number;
  forecast_window_demand_units?: number;
  projected_inventory_gap_units?: number;
  projected_inventory_gap_ratio?: number;
  decision_locked?: boolean;
  next_decision_in_sec?: number;
  feedback_multiplier?: number;
  feedback_events?: number;
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
    decision_interval_sec?: number;
    cook_time_sec?: number;
    avg_ticket_usd: number;
    urgency_thresholds?: {
      medium_shortfall_ratio?: number;
      high_shortfall_ratio?: number;
    };
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
  unit_label: string;
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

export type RecommendationFeedbackAction = "accept" | "override" | "ignore";

export type RecommendationFeedbackEvent = {
  id: number;
  timestamp: string;
  item_key: string;
  item_label: string;
  action: RecommendationFeedbackAction;
  note: string | null;
  recommended_units: number;
  chosen_units: number;
  baseline_units: number;
  max_unit_size: number;
  unit_cost_usd: number;
  units_per_order: number;
  forecast_horizon_min: number;
  projected_customers: number;
  queue_state: string;
  avg_ticket_usd: number;
  expected_cost_saved_usd: number;
  expected_waste_avoided_units: number;
  outcome_status: "pending" | "evaluated" | "insufficient_data" | string;
  evaluated_at: string | null;
  actual_customers: number | null;
  forecast_error_customers: number | null;
  realized_waste_delta_units: number | null;
  realized_cost_delta_usd: number | null;
  realized_revenue_delta_usd: number | null;
};

export type RecommendationFeedbackSubmissionResponse = {
  timestamp: string;
  feedback: RecommendationFeedbackEvent;
  adaptation: {
    item: string;
    action: RecommendationFeedbackAction | string;
    multiplier_before: number;
    multiplier_after: number;
    feedback_events: number;
  };
};

export type RecommendationFeedbackSummary = {
  timestamp: string;
  window_minutes: number;
  count: number;
  adoption: {
    accepted: number;
    overridden: number;
    ignored: number;
    adopted: number;
    adoption_rate: number;
  };
  outcomes: {
    evaluated: number;
    pending: number;
    insufficient_data: number;
    expected_cost_saved_usd: number;
    realized_cost_delta_usd: number;
    expected_waste_avoided_units: number;
    realized_waste_delta_units: number;
    realized_revenue_delta_usd: number;
    realized_vs_expected_ratio: number;
  };
  prediction_impact: {
    forecast_mae_customers: number;
    forecast_bias_customers: number;
    direction: string;
  };
  events: RecommendationFeedbackEvent[];
  model_adaptation?: {
    timestamp: string;
    total_feedback_events: number;
    avg_multiplier: number;
    items: Array<{
      item: string;
      label: string;
      multiplier: number;
      feedback_events: number;
    }>;
  };
};
