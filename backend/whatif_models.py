"""Read-only alternatives to a saved, completed plan."""
from typing import Literal

from pydantic import Field, StrictStr, model_validator

from .models import DTO


class WhatIfRequest(DTO):
    excluded_campaign_ids: list[StrictStr] = Field(max_length=10)

    @model_validator(mode="after")
    def unique(self):
        if len(set(self.excluded_campaign_ids)) != len(self.excluded_campaign_ids):
            raise ValueError("Campaign identifiers must be unique")
        if any(not item or len(item) > 200 for item in self.excluded_campaign_ids):
            raise ValueError("Campaign identifier must contain 1–200 characters")
        return self


class WhatIfTotals(DTO):
    gross_gain: float
    net_gain: float
    communication_cost: float = Field(ge=0)
    total_contacts: int = Field(ge=0)
    unique_customers: int = Field(ge=0)
    remaining_budget: float = Field(ge=0)
    remaining_contacts: int = Field(ge=0)


class WhatIfCampaign(DTO):
    id: str
    audience_count: int = Field(ge=0)
    communication_cost: float = Field(ge=0)


class WhatIfResult(DTO):
    run_id: str
    label: Literal["local_simulation"] = "local_simulation"
    excluded_campaign_ids: list[str]
    retained_campaign_ids: list[str]
    original: WhatIfTotals
    alternative: WhatIfTotals
    net_gain_difference: float
    campaigns: list[WhatIfCampaign]
    valid_final_plan: bool
    explanation: str
