import os
from pathlib import Path

from dotenv import load_dotenv

# На случай импорта без server.py (скрипты): подхватить корневой .env
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

_DEFAULT_ROUTE = "http://127.0.0.1:9000/route/v1/driving"
_DEFAULT_TABLE = "http://127.0.0.1:9000/table/v1/driving"

PRICE_PER_KM_DEFAULT: float = float(os.getenv("PRICE_PER_KM_DEFAULT", "0.45"))
OSRM_CONFIG: dict = {
    "route_url": os.getenv("OSRM_ROUTE_URL", _DEFAULT_ROUTE).rstrip("/"),
    "table_url": os.getenv("OSRM_TABLE_URL", _DEFAULT_TABLE).rstrip("/"),
}