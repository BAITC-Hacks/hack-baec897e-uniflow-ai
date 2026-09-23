"""Public filter grammar, cached ID-ordered audiences, and homogeneous hypotheses."""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np
import pandas as pd

SPEC_FIELDS = ("campaign_name", "filter_arpu_segment", "filter_data_segment",
               "filter_call_segment", "filter_current_tariff", "target_tariff", "channel")
FILTER_VALUES = {"arpu_segment": {"LOW", "MID", "HIGH"},
                 "data_segment": {"NON_USER", "LITE", "HEAVY"},
                 "call_segment": {"LOW", "MEDIUM", "HIGH"}}


def filter_audience(profile: pd.DataFrame, campaign: dict) -> pd.DataFrame:
    """Only legal public filters, ordered exactly as the organizer executes them."""
    mask = np.ones(len(profile), dtype=bool)
    for column in FILTER_VALUES:
        value = campaign.get("filter_" + column)
        if value is not None and not pd.isna(value):
            mask &= profile[column].eq(value).fillna(False).to_numpy(dtype=bool)
    sources = campaign.get("filter_current_tariff")
    if sources is not None and not pd.isna(sources):
        mask &= profile["current_tariff"].isin([x.strip() for x in str(sources).split(";") if x.strip()]).to_numpy()
    return profile.loc[mask].sort_values("ID_NUMBER")


@dataclass
class Audience:
    group: tuple[str, str]
    indices: np.ndarray
    data: str | None = None
    call: str | None = None


@dataclass
class Candidate:
    audience: Audience
    target: str
    channel: str
    mean: float
    variance: float
    pilot_ids: list[str]

    def spec(self, name: str) -> dict:
        return dict(zip(SPEC_FIELDS, [name, self.audience.group[1], self.audience.data,
                                     self.audience.call, self.audience.group[0], self.target, self.channel]))


class CandidateSpace:
    def __init__(self, profile: pd.DataFrame, tariffs: pd.DataFrame, channels: dict):
        self.profile = profile.sort_values("ID_NUMBER").reset_index(drop=True).copy()
        if self.profile["ID_NUMBER"].isna().any() or self.profile["ID_NUMBER"].duplicated().any():
            raise ValueError("Customer IDs must be present and unique")
        raw_baseline = pd.to_numeric(self.profile["predicted_arpu"], errors="coerce").to_numpy(dtype=float)
        if not np.isfinite(raw_baseline).all() or (raw_baseline < 0).any():
            raise ValueError("Public predicted_arpu must be finite and nonnegative")
        self.baseline = raw_baseline
        self.tariffs = sorted(tariffs["tariff_plan_code"].dropna().astype(str).unique())
        self.channels = {str(k): dict(v) for k, v in channels.items()}
        self.groups = {}
        self.slices = {}
        eligible = self.profile["current_tariff"].isin(self.tariffs) & self.profile["arpu_segment"].isin(FILTER_VALUES["arpu_segment"])
        self.excluded = int((~eligible).sum())
        self.optional_missing = {col: int(self.profile.loc[eligible, col].isna().sum())
                                 for col in ("data_segment", "call_segment")}
        self.optional_missing_customers = int(self.profile.loc[eligible, ["data_segment", "call_segment"]]
                                             .isna().any(axis=1).sum())
        for key, frame in self.profile.loc[eligible].groupby(["current_tariff", "arpu_segment"], sort=True, observed=True):
            group = (str(key[0]), str(key[1]))
            whole = Audience(group, frame.index.to_numpy(dtype=int))
            self.groups[group] = whole
            variants = [whole]
            for data in sorted(FILTER_VALUES["data_segment"]):
                idx = frame.index[frame["data_segment"].eq(data)].to_numpy(dtype=int)
                if len(idx):
                    variants.append(Audience(group, idx, data=data))
            for call in sorted(FILTER_VALUES["call_segment"]):
                idx = frame.index[frame["call_segment"].eq(call)].to_numpy(dtype=int)
                if len(idx):
                    variants.append(Audience(group, idx, call=call))
            for data in sorted(FILTER_VALUES["data_segment"]):
                for call in sorted(FILTER_VALUES["call_segment"]):
                    idx = frame.index[frame["data_segment"].eq(data) & frame["call_segment"].eq(call)].to_numpy(dtype=int)
                    if len(idx):
                        variants.append(Audience(group, idx, data, call))
            self.slices[group] = variants
        self.hypotheses = [(group, target) for group in self.groups for target in self.tariffs if target != group[0]]

    def candidates(self, posterior, allowed_channels=None, fallback=False) -> list[Candidate]:
        result = []
        channels = sorted(set(allowed_channels or self.channels) & set(self.channels))
        if not channels:
            return []
        ranking_channel = max((c for c in channels if posterior.normalized(c)),
                              key=lambda c: float(self.channels[c]["conversion_multiplier"]),
                              default=channels[0])
        for group, whole in self.groups.items():
            targets = [target for target in self.tariffs if target != group[0]]
            ranking = sorted(targets, key=lambda target: (-posterior.get(group, target, ranking_channel)[0], target))
            targets = ranking[:3]
            # Preserve every observed hypothesis even if a noisy answer initially ranked it down.
            targets += [t for t in ranking[3:] if any(posterior.get(group, t, c)[2] for c in channels)]
            audiences = self.slices[group] if fallback or len(whole.indices) > 3500 else [whole]
            for target in targets:
                for channel in channels:
                    mean, variance, evidence = posterior.get(group, target, channel)
                    if not posterior.normalized(channel) and not evidence:
                        continue
                    for audience in audiences:
                        result.append(Candidate(audience, target, channel, mean, variance, evidence))
        return result
