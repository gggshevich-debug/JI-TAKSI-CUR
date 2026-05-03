# noqa: D100 — BIN первых 6 цифр для карт азербайджанских банков (синхронно с static/js/main.js).
from __future__ import annotations

from typing import Dict, Optional, Tuple

_AZ_BANK_BINS: Tuple[Tuple[str, Tuple[str, ...], Tuple[str, ...]], ...] = (
    ("ACCESSBANK CJSC", ("426863", "428652"), ("537462",)),
    ("AFB BANK OJSC", ("488940",), ()),
    ("AZERPOST LLC", (), ("537609",)),
    ("AZER-TURK BANK OJSC", (), ("521367",)),
    ("BANK OF BAKU OJSC", ("420382", "470448"), ("520987", "531599")),
    ("BANK RESPUBLIKA OJSC", ("424448", "424450", "424451"), ("523522", "524748", "535741", "541735", "547453")),
    ("EXPRESSBANK OSC", ("472494",), ("550578",)),
    ("INTERNATIONAL BANK OF AZERBAIJAN", ("410511", "412720", "412721", "461386"), ("516751", "527575", "531018", "549027", "552209", "558390")),
    ("KAPITAL BANK JSB", ("416973", "416974", "416975", "417358"), ("510307", "523915", "540408")),
    ('OPEN JOINT STOCK SOCIETY "MUGANBANK"', (), ("534191",)),
    ("PASHA BANK OJSC", ("418249", "444994", "486022"), ("540269",)),
    ("PREMIUM BANK OJSC", ("419255", "419256", "419257"), ()),
    ("RABITABANK JSB", ("418980",), ("526163", "535464")),
    ("UNIBANK COMMERCIAL BANK", ("409809", "409858", "440553"), ("522953", "524375")),
    ("XALQ BANK OJSC", ("419841",), ("516974",)),
    ("YELO BANK OPEN JOINT-STOCK COMPANY", ("417386", "472499"), ()),
)

_BIN_TO_BANK: Dict[str, str] = {}
for bank, visa_bins, mc_bins in _AZ_BANK_BINS:
    for b in visa_bins + mc_bins:
        _BIN_TO_BANK[b] = bank


def az_bin_bank(bin6: str) -> Optional[str]:
    if not bin6 or len(bin6) < 6:
        return None
    return _BIN_TO_BANK.get(bin6[:6])


def is_az_bank_card_digits(digits: str) -> bool:
    d = "".join(c for c in str(digits or "") if c.isdigit())
    if len(d) < 6:
        return False
    return d[:6] in _BIN_TO_BANK
