"""API data from audited input files and public competition constants."""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache

import pandas as pd

from .audit import PACKAGE_ROOT, build_audit, json_safe


@lru_cache(maxsize=1)
def _overview():
    # Organizer modules have top-level imports; adapter bootstrap is kept outside core.
    from .evaluation import bootstrap_package
    bootstrap_package()
    from environment import MAX_PILOTS, MIN_PILOT_CUSTOMERS, MAX_PILOT_CUSTOMERS
    from scoring_core import CHANNELS, TOTAL_BUDGET, MAX_TOTAL_CONTACTS, MAX_CAMPAIGNS, MAX_CUSTOMERS_PER_CAMPAIGN

    audit = build_audit()
    tariffs = pd.read_csv(PACKAGE_ROOT / "data" / "dict_tariff.csv")
    descriptions = pd.read_csv(PACKAGE_ROOT / "tariff_dictionary.csv").set_index("tariff_plan_code").description.to_dict()
    labels = {"push": "Push", "sms": "SMS", "digital_ads": "Цифровая реклама", "call": "Звонок"}
    result = {
        "mode": "local_simulation", "currency": "CU",
        "dataset": {"id": audit["dataset_id"], **{key: audit[key] for key in (
            "customer_count", "baseline_revenue", "eligible_customer_count", "excluded_customer_count",
            "exclusion_reason", "notices")}},
        "limits": {"budget": TOTAL_BUDGET, "contacts": MAX_TOTAL_CONTACTS, "pilots": MAX_PILOTS,
                   "final_campaigns": MAX_CAMPAIGNS, "customers_per_campaign": MAX_CUSTOMERS_PER_CAMPAIGN,
                   "pilot_size_min": MIN_PILOT_CUSTOMERS, "pilot_size_max": MAX_PILOT_CUSTOMERS},
        "channels": [{"code": code, "label": labels.get(code, code), **parameters}
                     for code, parameters in CHANNELS.items()],
        "tariffs": [{"code": row.tariff_plan_code, "monthly_fee": row.price_tariff,
                     "description": descriptions.get(row.tariff_plan_code, "")}
                    for row in tariffs.itertuples(index=False)],
        "segments": audit["segments"],
    }
    return json_safe(result)


def build_overview():
    """One immutable input dataset per server process; return an independent DTO."""
    return deepcopy(_overview())
