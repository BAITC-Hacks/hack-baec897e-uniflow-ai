"""Build the checked-in demo aggregate from the public synthetic CSV files."""

import csv
import hashlib
import json
from collections import defaultdict
from pathlib import Path


root = Path(__file__).resolve().parents[2]
source = root / "participant_package"
profile_path = source / "customer_profile.csv"
groups = defaultdict(lambda: [0, 0.0])
customer_count = 0
baseline = 0.0
eligible_count = 0

with profile_path.open(encoding="utf-8-sig", newline="") as handle:
    for row in csv.DictReader(handle):
        tariff = row["current_tariff"] or None
        segment = row["arpu_segment"] or None
        predicted = float(row["predicted_arpu"])
        groups[(tariff, segment)][0] += 1
        groups[(tariff, segment)][1] += predicted
        customer_count += 1
        baseline += predicted
        eligible_count += tariff is not None and segment is not None

with (source / "tariff_dictionary.csv").open(encoding="utf-8-sig", newline="") as handle:
    tariffs = [
        {
            "code": row["tariff_plan_code"],
            "monthly_fee": float(row["price_tariff"]) if row["price_tariff"] else None,
            "description": row["description"],
        }
        for row in csv.DictReader(handle)
    ]

excluded = customer_count - eligible_count
overview = {
    "mode": "demo",
    "currency": "CU",
    "dataset": {
        "id": hashlib.sha256(profile_path.read_bytes()).hexdigest()[:16],
        "customer_count": customer_count,
        "baseline_revenue": round(baseline, 2),
        "eligible_customer_count": eligible_count,
        "excluded_customer_count": excluded,
        "exclusion_reason": "Для адресного подбора нужны текущий тариф и ARPU-сегмент.",
        "notices": [
            {
                "code": "MISSING_SEGMENT_OR_TARIFF",
                "severity": "warning",
                "message": "Записи без текущего тарифа или ARPU-сегмента показаны отдельно и исключены из адресного подбора.",
                "affected_count": excluded,
            }
        ],
    },
    "limits": {
        "budget": 100000,
        "contacts": 15000,
        "pilots": 20,
        "final_campaigns": 10,
        "customers_per_campaign": 5000,
        "pilot_size_min": 10,
        "pilot_size_max": 200,
    },
    "channels": [
        {"code": "push", "label": "Push", "cost_per_contact": 0, "conversion_multiplier": 0.5},
        {"code": "sms", "label": "SMS", "cost_per_contact": 4, "conversion_multiplier": 0.65},
        {"code": "digital_ads", "label": "Digital ads", "cost_per_contact": 22, "conversion_multiplier": 0.85},
        {"code": "call", "label": "Звонок", "cost_per_contact": 160, "conversion_multiplier": 1.2},
    ],
    "tariffs": tariffs,
    "segments": [
        {
            "current_tariff": tariff,
            "arpu_segment": segment,
            "customer_count": count,
            "baseline_revenue": round(revenue, 2),
            "average_predicted_arpu": round(revenue / count, 2),
            "eligible": tariff is not None and segment is not None,
        }
        for (tariff, segment), (count, revenue) in sorted(groups.items(), key=lambda item: (item[0][0] or "", item[0][1] or ""))
    ],
}

out = Path(__file__).resolve().parents[1] / "src" / "mocks" / "overview.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(overview, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(out)
