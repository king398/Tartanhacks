export type Metrics = {
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

export type RecommendationItem = {
  item: string;
  label: string;
  recommended_batches: number;
  recommended_units: number;
  baseline_batches: number;
  baseline_units: number;
  delta_batches: number;
  urgency: "high" | "medium" | "low";
  reason: string;
};

export type RecommendationResponse = {
  timestamp: string;
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
  source: string;
  default_source: string;
};
