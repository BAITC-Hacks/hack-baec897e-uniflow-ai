"""Machine-readable implementation of docs/team/API_CONTRACT.md, version 1."""
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("Timestamp must contain a UTC offset")
    return value.astimezone(timezone.utc)


UTCDateTime = Annotated[datetime, AfterValidator(_utc)]
Channel = Literal["push", "sms", "digital_ads", "call"]
RiskProfile = Literal["balanced", "conservative"]
RunStatus = Literal["queued", "running", "completed", "failed"]
Phase = Literal["queued", "audit", "candidates", "pilots", "planning", "evaluation", "completed", "failed"]


class DTO(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class RunConfig(DTO):
    seed: int = Field(ge=0, le=2147483647, strict=True)
    risk_profile: RiskProfile


class Limits(DTO):
    budget: float
    contacts: int
    pilots: int
    final_campaigns: int
    customers_per_campaign: int
    pilot_size_min: int
    pilot_size_max: int


class Notice(DTO):
    code: str
    severity: Literal["info", "warning", "error"]
    message: str
    affected_count: int | None


class Dataset(DTO):
    id: str
    customer_count: int
    baseline_revenue: float
    eligible_customer_count: int
    excluded_customer_count: int
    exclusion_reason: str
    notices: list[Notice]


class ChannelInfo(DTO):
    code: Channel
    label: str
    cost_per_contact: float
    conversion_multiplier: float


class Tariff(DTO):
    code: str
    monthly_fee: float | None
    description: str


class Segment(DTO):
    current_tariff: str | None
    arpu_segment: str | None
    customer_count: int
    baseline_revenue: float
    average_predicted_arpu: float
    eligible: bool


class Overview(DTO):
    mode: Literal["local_simulation", "demo"]
    currency: Literal["CU"]
    dataset: Dataset
    limits: Limits
    channels: list[ChannelInfo]
    tariffs: list[Tariff]
    segments: list[Segment]


class CampaignSpec(DTO):
    campaign_name: str
    filter_arpu_segment: str | None
    filter_data_segment: str | None
    filter_call_segment: str | None
    filter_current_tariff: str | None
    target_tariff: str
    channel: Channel


class EstimateInterval(DTO):
    low: float
    high: float
    level: float = Field(gt=0, lt=1)
    method: str = Field(min_length=1)

    @model_validator(mode="after")
    def ordered(self):
        if self.low > self.high:
            raise ValueError("Interval low must not exceed high")
        return self


class ResourceCounter(DTO):
    limit: float = Field(ge=0)
    used_by_pilots: float = Field(ge=0)
    planned_final: float | None = Field(ge=0)
    remaining_after_plan: float | None = Field(ge=0)


class Resources(DTO):
    budget: ResourceCounter
    contacts: ResourceCounter
    pilots_used: int = Field(ge=0)
    pilots_limit: int = Field(ge=1)
    final_campaigns_count: int = Field(ge=0)
    final_campaigns_limit: int = Field(ge=1)


class PilotRecord(DTO):
    id: str
    sequence: int = Field(ge=1)
    campaign: CampaignSpec
    requested_customers: int = Field(ge=10, le=200)
    actual_customers: int = Field(ge=1, le=200)
    cost: float = Field(ge=0)
    observed_lift_ratio: float
    observed_lift_total: float
    selection_reason: str
    decision_after: str
    completed_at: UTCDateTime


class CampaignView(DTO):
    id: str
    execution_order: int = Field(ge=1)
    spec: CampaignSpec
    audience_count: int = Field(ge=1, le=5000)
    communication_cost: float = Field(ge=0)
    expected_incremental_net_gain: float | None
    expected_lift_ratio: float | None
    evidence: Literal["pilot_supported", "prior_only", "fallback"]
    supporting_pilot_ids: list[str]
    reasons: list[str]
    warnings: list[str]


class Forecast(DTO):
    scope: Literal["pilots_and_final"]
    expected_gross_gain: float
    expected_net_gain: float
    net_gain_interval: EstimateInterval | None
    expected_unique_reach: float | None = Field(ge=0)
    overlap_method: str


class LocalEvaluation(DTO):
    label: Literal["local_simulation"]
    gross_gain: float
    net_arpu_gain: float
    communication_cost: float = Field(ge=0)
    total_contacts: int = Field(ge=0)
    unique_customers: int = Field(ge=0)
    n_pilots: int = Field(ge=0)
    n_final_campaigns: int = Field(ge=0)
    runtime_seconds: float = Field(ge=0)


class DecisionEvent(DTO):
    id: str
    sequence: int = Field(ge=1)
    created_at: UTCDateTime
    phase: Phase
    title: str
    message: str


class RunSummary(DTO):
    id: str
    status: RunStatus
    phase: Phase
    created_at: UTCDateTime
    updated_at: UTCDateTime
    completed_at: UTCDateTime | None
    config: RunConfig
    forecast_net_gain: float | None
    local_net_gain: float | None


class Failure(DTO):
    code: str
    message: str
    retryable: bool


class RunSnapshot(RunSummary):
    api_version: Literal["1"]
    mode: Literal["local_simulation", "demo"]
    dataset_id: str
    phase_message: str
    resources: Resources
    pilots: list[PilotRecord]
    campaigns: list[CampaignView]
    events: list[DecisionEvent]
    forecast: Forecast | None
    local_evaluation: LocalEvaluation | None
    warnings: list[Notice]
    failure: Failure | None


class RunList(DTO):
    items: list[RunSummary]


class Health(DTO):
    status: Literal["ok"] = "ok"
    api_version: Literal["1"] = "1"
    mode: Literal["local_simulation"] = "local_simulation"


class ErrorDetails(DTO):
    code: str
    message: str
    details: dict
    request_id: str


class ErrorResponse(DTO):
    error: ErrorDetails
