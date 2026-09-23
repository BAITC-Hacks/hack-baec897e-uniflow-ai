export type Channel = 'push' | 'sms' | 'digital_ads' | 'call'
export type RiskProfile = 'balanced' | 'conservative'
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed'
export type Phase = 'queued' | 'audit' | 'candidates' | 'pilots' | 'planning' | 'evaluation' | 'completed' | 'failed'
export type Mode = 'local_simulation' | 'demo'

export interface RunConfig { seed: number; risk_profile: RiskProfile }
export interface Limits { budget: number; contacts: number; pilots: number; final_campaigns: number; customers_per_campaign: number; pilot_size_min: number; pilot_size_max: number }
export interface Notice { code: string; severity: 'info' | 'warning' | 'error'; message: string; affected_count: number | null }
export interface Overview {
  mode: Mode; currency: 'CU'
  dataset: { id: string; customer_count: number; baseline_revenue: number; eligible_customer_count: number; excluded_customer_count: number; exclusion_reason: string; notices: Notice[] }
  limits: Limits
  channels: Array<{ code: Channel; label: string; cost_per_contact: number; conversion_multiplier: number }>
  tariffs: Array<{ code: string; monthly_fee: number | null; description: string }>
  segments: Array<{ current_tariff: string | null; arpu_segment: string | null; customer_count: number; baseline_revenue: number; average_predicted_arpu: number; eligible: boolean }>
}
export interface CampaignSpec {
  campaign_name: string
  filter_arpu_segment: string | null
  filter_data_segment: string | null
  filter_call_segment: string | null
  filter_current_tariff: string | null
  target_tariff: string
  channel: Channel
}
export interface EstimateInterval { low: number; high: number; level: number; method: string }
export interface ResourceCounter { limit: number; used_by_pilots: number; planned_final: number | null; remaining_after_plan: number | null }
export interface Resources { budget: ResourceCounter; contacts: ResourceCounter; pilots_used: number; pilots_limit: number; final_campaigns_count: number; final_campaigns_limit: number }
export interface PilotRecord {
  id: string; sequence: number; campaign: CampaignSpec; requested_customers: number; actual_customers: number; cost: number
  observed_lift_ratio: number; observed_lift_total: number; selection_reason: string; decision_after: string; completed_at: string
}
export interface CampaignView {
  id: string; execution_order: number; spec: CampaignSpec; audience_count: number; communication_cost: number
  expected_incremental_net_gain: number | null; expected_lift_ratio: number | null
  evidence: 'pilot_supported' | 'prior_only' | 'fallback'; supporting_pilot_ids: string[]; reasons: string[]; warnings: string[]
}
export interface Forecast {
  scope: 'pilots_and_final'; expected_gross_gain: number; expected_net_gain: number; net_gain_interval: EstimateInterval | null
  expected_unique_reach: number | null; overlap_method: string
}
export interface LocalEvaluation {
  label: 'local_simulation'; gross_gain: number; net_arpu_gain: number; communication_cost: number; total_contacts: number
  unique_customers: number; n_pilots: number; n_final_campaigns: number; runtime_seconds: number
}
export interface DecisionEvent { id: string; sequence: number; created_at: string; phase: Phase; title: string; message: string }
export interface RunSummary {
  id: string; status: RunStatus; phase: Phase; created_at: string; updated_at: string; completed_at: string | null
  config: RunConfig; forecast_net_gain: number | null; local_net_gain: number | null
}
export interface RunSnapshot extends RunSummary {
  api_version: '1'; mode: Mode; dataset_id: string; phase_message: string; resources: Resources; pilots: PilotRecord[]
  campaigns: CampaignView[]; events: DecisionEvent[]; forecast: Forecast | null; local_evaluation: LocalEvaluation | null
  warnings: Notice[]; failure: { code: string; message: string; retryable: boolean } | null
}
export interface ApiErrorBody { error: { code: string; message: string; details: Record<string, unknown>; request_id: string } }
