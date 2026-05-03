import decimal
import asyncpg
import asyncio
import json
import math
import logging
import os
import re
import time
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime, timezone

from tools.config import PRICE_PER_KM_DEFAULT
from tools import pricing_engine

LOG_FILE = "temp/base_log.log"
LOG_LOCK = asyncio.Lock()  # Для асинхронного потокобезопасного логирования

# Настройка логирования
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def log(message_type: str, message: str):
    timestamp = datetime.now().strftime("%d.%m.%Y %H:%M:%S")
    async with LOG_LOCK:
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(f"{message_type} {timestamp} - {message}\n")
        except Exception as e:
            logger.error(f"Ошибка записи в лог: {e}")


# Тексты шагов заявки на вывод (по умолчанию; переопределяются в app_settings).
WITHDRAWAL_TIMELINE_DEFAULTS: Dict[str, str] = {
    "pending": "Sorğunuz növbəyə əlavə olunub",
    "processing": "Sorğunuz emal olunur",
    "completed": "Pul uğurla çıxarıldı",
    "rejected": "Zəhmət olmasa, detalları yoxlayın və yenidən cəhd edin.",
}

# История в профиле: лимит строк (без него возможен OOM на длинной истории).
PROFILE_TRIP_HISTORY_LIMIT = 100

RATING_REASON_ALLOWED = {
    "client": {
        "pos": frozenset(
            {
                "polite_driver",
                "clean_interior",
                "careful_driving",
                "arrived_on_time",
                "good_navigation",
                "clean_car",
                "arrived_fast",
            }
        ),
        "neg": frozenset(
            {
                "late",
                "rude_behavior",
                "dangerous_driving",
                "driver_no_show",
                "driver_no_answer",
                "wrong_pickup_by_driver",
            }
        ),
    },
    "driver": {
        "pos": frozenset(
            {
                "polite_client",
                "quick_exit",
                "was_reachable",
                "good_behavior",
                "on_time_out",
            }
        ),
        "neg": frozenset(
            {
                "client_no_show",
                "rude_client",
                "long_wait",
                "client_no_answer",
                "cancel_after_arrival",
                "wrong_pickup_by_client",
                "no_show",
            }
        ),
    },
}


def _pack_trip_rating_comment(
    rater_type: str,
    stars_f: float,
    reasons: Optional[list],
    legacy_comment: Optional[str],
) -> Optional[str]:
    if reasons is not None:
        if rater_type not in RATING_REASON_ALLOWED:
            return json.dumps({"v": 1, "tags": []}, ensure_ascii=False)
        pole = "pos" if stars_f >= 4.0 else "neg"
        allowed = RATING_REASON_ALLOWED[rater_type][pole]
        out: List[str] = []
        for r in reasons[:12]:
            if isinstance(r, str) and re.match(r"^[a-z_]{1,40}$", r) and r in allowed:
                out.append(r)
        return json.dumps({"v": 1, "tags": out}, ensure_ascii=False)
    if legacy_comment:
        t = legacy_comment.strip()
        return t[:2000] if t else None
    return json.dumps({"v": 1, "tags": []}, ensure_ascii=False)


class Database:
    """
    Асинхронный класс для работы с базой данных taxi_mvp.
    CRUD-операции для клиентов, водителей, поездок, тарифов и транзакций.
    Поддержка расчета ближайших водителей и автоматического обновления баланса.
    """

    def __init__(
        self,
        dbname: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
        host: Optional[str] = None,
        port: Optional[int] = None,
    ):
        self.dbname = dbname or os.getenv("POSTGRES_DB", "taxi_mvp")
        self.user = user or os.getenv("POSTGRES_USER", "mac")
        self.password = password or os.getenv("POSTGRES_PASSWORD", "PostgreSQL")
        self.host = host or os.getenv("POSTGRES_HOST", "localhost")
        self.port = port if port is not None else int(os.getenv("POSTGRES_PORT", "5432"))
        self.pool = None
        self._pricing_cache: Optional[Dict[str, float]] = None
        self._pricing_model_cache: Optional[Dict[str, Any]] = None
        self._dispatch_settings_cache: Optional[Dict[str, int]] = None
        # (ts, avg_sec, n) — статистика принятий для рынка и диспетчеризации
        self._accept_stats_cache: Optional[Tuple[float, float, int]] = None
        # (ts, reference ₼/км)
        self._reference_pkm_cache: Optional[Tuple[float, float]] = None

    async def connect(self):
        """Создание пула подключений и создание БД/таблиц если не существуют"""
        try:
            # Сначала подключаемся к базе данных postgres для создания нужной БД
            admin_conn = await asyncpg.connect(
                database='postgres',
                user=self.user,
                password=self.password,
                host=self.host,
                port=self.port
            )
            
            # Проверяем существование базы данных
            db_exists = await admin_conn.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = $1", self.dbname
            )
            
            if not db_exists:
                await admin_conn.execute(f'CREATE DATABASE {self.dbname}')
                await log("[*]", f"База данных {self.dbname} создана")
            
            await admin_conn.close()
            
            # Теперь подключаемся к нашей базе данных
            self.pool = await asyncpg.create_pool(
                database=self.dbname,
                user=self.user,
                password=self.password,
                host=self.host,
                port=self.port,
                min_size=5,
                max_size=20
            )
            
            # Создаем таблицы
            await self._create_tables()
            await log("[*]", "Пул подключений к базе данных создан успешно")
            
        except Exception as e:
            await log("[#]", f"Ошибка создания пула подключений: {e}")
            raise

    async def _create_tables(self):
        """Создание всех необходимых таблиц"""
        async with self.pool.acquire() as conn:
            try:
                # Таблица клиентов
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS clients (
                        client_id                                           SERIAL PRIMARY KEY,
                        name                                                VARCHAR(100) NOT NULL,
                        surname                                             VARCHAR(100) NOT NULL,
                        phone                                               VARCHAR(20) UNIQUE NOT NULL,
                        email                                               VARCHAR(100),
                        password                                            VARCHAR(255) NOT NULL,
                        last_lat                                            DECIMAL(10, 8),
                        last_lon                                            DECIMAL(11, 8),
                        rating                                              DECIMAL(3, 2) DEFAULT 4.9,
                        balance                                             DECIMAL(10, 2) DEFAULT 0.00,
                        created_at                                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at                                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                ''')
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS photo TEXT"
                )
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS anonymous_profile BOOLEAN DEFAULT FALSE NOT NULL"
                )
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE"
                )
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS admin_disabled BOOLEAN DEFAULT FALSE"
                )
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP"
                )
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS device_screen VARCHAR(32)"
                )
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS device_platform VARCHAR(16)"
                )
                await conn.execute(
                    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS device_lang VARCHAR(32)"
                )

                # Таблица водителей
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS drivers (
                        driver_id                                           SERIAL PRIMARY KEY,
                        name                                                VARCHAR(100) NOT NULL,
                        surname                                             VARCHAR(100) NOT NULL,
                        phone                                               VARCHAR(20) UNIQUE NOT NULL,
                        email                                               VARCHAR(100),
                        password                                            VARCHAR(255) NOT NULL,
                        last_lat                                            DECIMAL(10, 8),
                        last_lon                                            DECIMAL(11, 8),
                        car_name                                            VARCHAR(100),
                        car_category                                        VARCHAR(50),
                        car_year                                            INTEGER,
                        car_number                                          VARCHAR(20),
                        car_tech_passport                                   VARCHAR(100),
                        driver_license                                      VARCHAR(100),
                        car_front_photo                                     TEXT,
                        driver_license_photo                                TEXT,
                        car_tech_photo                                      TEXT,
                        rating_coefficient                                  DECIMAL(5,2) DEFAULT 1.00,
                        face_photo                                          TEXT,
                        verification                                        TEXT DEFAULT 'pending',
                        price_per_km                                        DECIMAL(8, 2) DEFAULT 50.00,
                        status                                              VARCHAR(20) DEFAULT 'offline',
                        rating                                              DECIMAL(3, 2) DEFAULT 4.9,
                        balance                                             DECIMAL(10, 2) DEFAULT 0.00,
                        created_at                                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at                                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                ''')
                
                # Таблица поездок
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS trips (
                        trip_id                                             SERIAL PRIMARY KEY,
                        client_id                                           INTEGER REFERENCES clients(client_id),
                        driver_id                                           INTEGER REFERENCES drivers(driver_id),
                        start_address                                       VARCHAR(255),
                        start_lat                                           DECIMAL(10, 8) NOT NULL,
                        start_lon                                           DECIMAL(11, 8) NOT NULL,
                        end_lat                                             DECIMAL(10, 8),
                        end_lon                                             DECIMAL(11, 8),
                        end_address                                         VARCHAR(255),
                        distance_km                                         DECIMAL(8, 2),
                        requested_at                                        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        accepted_at                                         TIMESTAMP,
                        started_at                                          TIMESTAMP,
                        completed_at                                        TIMESTAMP,
                        cancelled_at                                        TIMESTAMP,
                        price                                               DECIMAL(10, 2) DEFAULT 0.00,
                        client_name                                         VARCHAR(200),
                        client_rating                                       DECIMAL(3, 2),
                        driving_time                                        VARCHAR(50),
                        status                                              VARCHAR(20) DEFAULT 'pending',
                        state                                               VARCHAR(20) DEFAULT 'pending_confirm',
                        created_at                                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                ''')
                
                # Таблица тарифов
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS fares (
                        fare_id                                             SERIAL PRIMARY KEY,
                        car_category                                        VARCHAR(50) UNIQUE NOT NULL,
                        price_per_km                                        DECIMAL(8, 2) NOT NULL,
                        created_at                                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                ''')
                
                # Таблица транзакций
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS transactions (
                        transaction_id                                      SERIAL PRIMARY KEY,
                        user_type                                           VARCHAR(10) NOT NULL,
                        user_id                                             INTEGER NOT NULL,
                        amount                                              DECIMAL(10, 2) NOT NULL,
                        type                                                VARCHAR(20) NOT NULL,
                        description                                         TEXT,
                        created                                             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                ''')

                # Таблица отказов
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS refusals (
                        refusal_id                                          SERIAL PRIMARY KEY,
                        trip_id                                             INTEGER NOT NULL,
                        initiator_type                                      VARCHAR(20) NOT NULL CHECK (initiator_type IN ('client', 'driver', 'system')),
                        initiator_id                                        INTEGER NOT NULL,
                        reason_type                                         VARCHAR(50) NOT NULL,
                        reason_text                                         TEXT NOT NULL,
                        cancel_stage                                        VARCHAR(30),
                        driver_lat                                          DECIMAL(10, 8),
                        driver_lon                                          DECIMAL(10, 8),
                        client_lat                                          DECIMAL(10, 8),
                        client_lon                                          DECIMAL(10, 8),
                        penalty_applied                                     BOOLEAN DEFAULT FALSE,
                        penalty_amount                                      DECIMAL(10, 2) DEFAULT 0.00,
                        penalty_rating                                      DECIMAL(3,2) DEFAULT 0,
                        created_at                                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE
                    )
                ''')
                
                # Миграции поездок: версия для resync, список водителей для оффера (matchmaking)
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS revision INTEGER DEFAULT 1"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS offer_driver_ids INTEGER[]"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS dispatch_wave INTEGER DEFAULT 0"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS dispatch_radius_km DOUBLE PRECISION DEFAULT 3"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMP"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS dispatch_seen_driver_ids INTEGER[] DEFAULT '{}'::integer[]"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS dispatch_quality_tier INTEGER DEFAULT 1"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS dispatch_solo_driver_id INTEGER"
                )
                await conn.execute(
                    """
                    ALTER TABLE trips ADD COLUMN IF NOT EXISTS client_dispatch_boost_mult
                    DOUBLE PRECISION DEFAULT 1.0
                    """
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_duration_minutes INTEGER"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS post_trip_driver_stars DOUBLE PRECISION"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS post_trip_client_stars DOUBLE PRECISION"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS post_trip_driver_comment TEXT"
                )
                await conn.execute(
                    "ALTER TABLE trips ADD COLUMN IF NOT EXISTS post_trip_client_comment TEXT"
                )
                # Триггер trg_trips_leg_state ссылается на колонку state — без DROP ALTER TYPE запрещён.
                await conn.execute(
                    "DROP TRIGGER IF EXISTS trg_trips_leg_state ON trips"
                )
                await conn.execute(
                    "ALTER TABLE trips ALTER COLUMN state TYPE VARCHAR(32)"
                )
                await conn.execute(
                    """
                    UPDATE trips SET state = 'driver_arrived' WHERE state = 'waiting'
                    """
                )
                await conn.execute(
                    "UPDATE trips SET state = 'in_progress' WHERE state = 'progress'"
                )
                await conn.execute(
                    "UPDATE trips SET state = 'at_destination' WHERE state = 'arrived'"
                )
                await conn.execute("UPDATE trips SET state = 'finished' WHERE state = 'done'")
                await conn.execute(
                    """
                    UPDATE trips SET state = 'en_route'
                    WHERE status = 'accepted' AND driver_id IS NOT NULL
                      AND state = 'pending_confirm'
                    """
                )

                await conn.execute(
                    """
                    CREATE OR REPLACE FUNCTION trips_valid_leg_transition(o text, n text)
                    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
                    SELECT
                      o IS NOT DISTINCT FROM n
                      OR (o = 'pending_confirm' AND n = 'en_route')
                      OR (o = 'en_route' AND n IN ('pending_confirm','driver_arrived','cancel_client','cancel_driver'))
                      OR (o = 'driver_arrived' AND n IN ('onboard','cancel_client','cancel_driver'))
                      OR (o = 'onboard' AND n IN ('in_progress','cancel_client','cancel_driver'))
                      OR (o = 'in_progress' AND n IN ('at_destination','paused','cancel_client','cancel_driver'))
                      OR (o = 'paused' AND n IN ('in_progress','cancel_client','cancel_driver'))
                      OR (o = 'at_destination' AND n IN ('finished','cancel_client','cancel_driver'))
                      OR (o IN ('finished','cancel_client','cancel_driver') AND n = o);
                    $$;
                    """
                )
                await conn.execute(
                    """
                    CREATE OR REPLACE FUNCTION trips_enforce_leg_state()
                    RETURNS trigger AS $$
                    BEGIN
                      IF TG_OP = 'UPDATE' AND NEW.state IS DISTINCT FROM OLD.state THEN
                        IF NOT trips_valid_leg_transition(OLD.state, NEW.state) THEN
                          RAISE EXCEPTION 'invalid trip leg state % -> % (trip_id=%)',
                            OLD.state, NEW.state, OLD.trip_id;
                        END IF;
                      END IF;
                      RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                    """
                )
                await conn.execute("DROP TRIGGER IF EXISTS trg_trips_leg_state ON trips")
                await conn.execute(
                    """
                    CREATE TRIGGER trg_trips_leg_state
                    BEFORE UPDATE OF state ON trips
                    FOR EACH ROW EXECUTE PROCEDURE trips_enforce_leg_state()
                    """
                )

                await conn.execute(
                    """
                    CREATE OR REPLACE FUNCTION trips_enforce_status_no_rollback()
                    RETURNS trigger AS $$
                    BEGIN
                      IF TG_OP <> 'UPDATE' OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
                        RETURN NEW;
                      END IF;
                      IF OLD.status IN ('completed','cancelled') THEN
                        RAISE EXCEPTION 'trip %: status terminal %', OLD.trip_id, OLD.status;
                      END IF;
                      IF OLD.status = 'busy' AND NEW.status IN ('pending','offered','accepted') THEN
                        RAISE EXCEPTION 'trip %: invalid status rollback busy -> %', OLD.trip_id, NEW.status;
                      END IF;
                      IF OLD.status = 'accepted' AND NEW.status IN ('pending','offered') THEN
                        IF NEW.driver_id IS NOT NULL THEN
                          RAISE EXCEPTION 'trip %: invalid status rollback accepted -> % (driver_id must be null)', OLD.trip_id, NEW.status;
                        END IF;
                      END IF;
                      IF OLD.status = 'offered' AND NEW.status = 'pending' THEN
                        RAISE EXCEPTION 'trip %: invalid status rollback offered -> pending', OLD.trip_id;
                      END IF;
                      RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                    """
                )
                await conn.execute("DROP TRIGGER IF EXISTS trg_trips_status_guard ON trips")
                await conn.execute(
                    """
                    CREATE TRIGGER trg_trips_status_guard
                    BEFORE UPDATE OF status ON trips
                    FOR EACH ROW EXECUTE PROCEDURE trips_enforce_status_no_rollback()
                    """
                )

                await conn.execute(
                    "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS acceptance_rate REAL DEFAULT 0.75"
                )
                await conn.execute(
                    "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS admin_disabled BOOLEAN DEFAULT FALSE"
                )
                await conn.execute(
                    "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE"
                )
                await conn.execute(
                    "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP"
                )
                await conn.execute(
                    "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS device_screen VARCHAR(32)"
                )
                await conn.execute(
                    "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS device_platform VARCHAR(16)"
                )
                await conn.execute(
                    "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS device_lang VARCHAR(32)"
                )

                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS trip_state_changes (
                        id SERIAL PRIMARY KEY,
                        trip_id INTEGER NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
                        from_state VARCHAR(32),
                        to_state VARCHAR(32),
                        ok BOOLEAN NOT NULL DEFAULT true,
                        latency_ms DOUBLE PRECISION,
                        source VARCHAR(64),
                        actor_user_id INTEGER,
                        error_message TEXT,
                        debug JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_tsc_trip ON trip_state_changes(trip_id)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_tsc_created ON trip_state_changes(created_at DESC)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_trips_driver_state ON trips(driver_id, state) WHERE driver_id IS NOT NULL"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_trips_client_state ON trips(client_id, state)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips(created_at DESC)"
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_trips_active_offered
                    ON trips(trip_id)
                    WHERE status = 'offered' AND driver_id IS NULL
                    """
                )

                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_settings (
                        key VARCHAR(64) PRIMARY KEY,
                        value TEXT NOT NULL,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('price_per_km', $1)
                    ON CONFLICT (key) DO NOTHING
                    """,
                    str(PRICE_PER_KM_DEFAULT),
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('trip_base_fee', '0')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('dispatch_wave_timeout_sec', '12')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('dispatch_wave_size', '4')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                _def_tiers = json.dumps(
                    [
                        {"up_to": 5, "rate": 0.5},
                        {"up_to": 20, "rate": 0.45},
                        {"up_to": 50, "rate": 0.4},
                        {"up_to": 100, "rate": 0.35},
                        {"up_to": None, "rate": 0.32},
                    ],
                    ensure_ascii=False,
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_km_tiers_json', $1)
                    ON CONFLICT (key) DO NOTHING
                    """,
                    _def_tiers,
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_per_minute_azn', '0.04')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_min_price_azn', '1')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_long_trip_floor_per_km', '0.34')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_long_trip_km_threshold', '100')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_long_trip_post_cap_mult', '1.05')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_long_trip_max_wave_mult', '1.08')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_quote_nearby_driver_km', '1')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_market_ref_high_mult', '1.1')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('pricing_market_ref_low_mult', '0.88')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES ('dispatch_priority_dist_weight', '0.18')
                    ON CONFLICT (key) DO NOTHING
                    """
                )
                for _st, _txt in WITHDRAWAL_TIMELINE_DEFAULTS.items():
                    await conn.execute(
                        """
                        INSERT INTO app_settings (key, value) VALUES ($1, $2)
                        ON CONFLICT (key) DO NOTHING
                        """,
                        f"withdrawal_timeline_{_st}",
                        _txt,
                    )

                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS push_subscriptions (
                        subscription_id     SERIAL PRIMARY KEY,
                        user_type             VARCHAR(20) NOT NULL
                            CHECK (user_type IN ('client', 'driver')),
                        user_id               INTEGER NOT NULL,
                        endpoint              TEXT NOT NULL UNIQUE,
                        p256dh                TEXT NOT NULL,
                        auth                  TEXT NOT NULL,
                        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_push_sub_user "
                    "ON push_subscriptions(user_type, user_id)"
                )

                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS push_notification_templates (
                        event_key       VARCHAR(64) PRIMARY KEY,
                        title_template  TEXT NOT NULL,
                        body_template   TEXT NOT NULL,
                        subtitle_template TEXT NOT NULL DEFAULT '',
                        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                await conn.execute(
                    "ALTER TABLE push_notification_templates "
                    "ADD COLUMN IF NOT EXISTS subtitle_template TEXT NOT NULL DEFAULT ''"
                )
                await conn.execute(
                    """
                    INSERT INTO push_notification_templates (event_key, title_template, body_template, subtitle_template)
                    VALUES
                    (
                        'driver_new_trip_offer',
                        'Новый заказ',
                        'Поездка №{trip_id}. Примерная стоимость {price} ₼. Откройте приложение, чтобы откликнуться.',
                        ''
                    ),
                    (
                        'client_driver_found',
                        'Водитель найден',
                        '{driver_label} назначен на поездку №{trip_id}. Откройте экран поездки.',
                        ''
                    ),
                    (
                        'client_trip_confirmed',
                        'Поездка подтверждена',
                        'Поездка №{trip_id} началась. Водитель: {taxi_name}. Стоимость около {price} ₼.',
                        ''
                    ),
                    (
                        'driver_trip_confirmed',
                        'Клиент подтвердил поездку',
                        'Поездка №{trip_id} подтверждена. Можно выезжать к точке подачи.',
                        ''
                    ),
                    (
                        'driver_withdraw_submitted',
                        'Запрос на вывод',
                        'Сумма {amount} ₼. Заявка №{withdrawal_id} принята, статус: в обработке.',
                        ''
                    ),
                    (
                        'driver_withdraw_processing',
                        'Вывод средств',
                        'Заявка №{withdrawal_id}: обрабатывается. Сумма {amount} ₼.',
                        ''
                    ),
                    (
                        'driver_withdraw_completed',
                        'Вывод выполнен',
                        'Заявка №{withdrawal_id} завершена. Сумма {amount} ₼ переведена на карту *{card_last4}.',
                        ''
                    ),
                    (
                        'driver_withdraw_rejected',
                        'Вывод отклонён',
                        'Заявка №{withdrawal_id}. Сумма {amount} ₼ возвращена на баланс. Причина: {reason}',
                        ''
                    ),
                    (
                        'driver_trip_cancelled',
                        'Поездка отменена',
                        'Поездка №{trip_id} отменена клиентом.',
                        ''
                    ),
                    (
                        'client_trip_cancelled',
                        'Поездка отменена',
                        'Поездка №{trip_id} отменена водителем.',
                        ''
                    ),
                    (
                        'client_trip_finished',
                        'Поездка завершена',
                        'Поездка №{trip_id} завершена. Сумма: {price} ₼. Спасибо, что выбрали JI Taxi.',
                        ''
                    ),
                    (
                        'driver_trip_finished',
                        'Поездка завершена',
                        'Поездка №{trip_id} завершена. Сумма: {price} ₼.',
                        ''
                    )
                    ON CONFLICT (event_key) DO NOTHING
                    """
                )

                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS driver_withdrawal_requests (
                        id                  SERIAL PRIMARY KEY,
                        driver_id           INTEGER NOT NULL REFERENCES drivers(driver_id),
                        amount              NUMERIC(12, 2) NOT NULL
                            CHECK (amount > 0),
                        status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
                        card_bin6           VARCHAR(6) NOT NULL,
                        card_last4          VARCHAR(4) NOT NULL,
                        timeline            JSONB NOT NULL DEFAULT '[]'::jsonb,
                        balance_refunded    BOOLEAN NOT NULL DEFAULT FALSE,
                        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_withdraw_driver "
                    "ON driver_withdrawal_requests(driver_id, id DESC)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_withdraw_status "
                    "ON driver_withdrawal_requests(status, id DESC)"
                )

                await log("[*]", "Таблицы созданы/проверены успешно")
                
            except Exception as e:
                await log("[!]", f"Ошибка создания таблиц: {e}")
                raise

    async def close(self):
        """Закрытие пула подключений"""
        if self.pool:
            await self.pool.close()
            await log("[*]", "Пул подключений закрыт")

    

    # ---------------------
    # ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    # ---------------------
    async def _execute(self, query: str, params: tuple = (), fetchone: bool = False, 
                      fetchall: bool = False) -> Optional[List[Dict]]:
        """Асинхронное выполнение запроса"""
        if not self.pool:
            await self.connect()
        
        async with self.pool.acquire() as conn:
            try:
                if fetchone:
                    result = await conn.fetchrow(query, *params)
                    return dict(result) if result else None
                elif fetchall:
                    results = await conn.fetch(query, *params)
                    return [dict(row) for row in results] if results else []
                else:
                    await conn.execute(query, *params)
                    return None
            except asyncpg.IntegrityConstraintViolationError as e:
                await log("[!]", f"Ошибка целостности данных: {e}")
                raise
            except Exception as e:
                await log("[!]", f"Ошибка выполнения запроса: {e}")
                raise

    async def _execute_update(self, table: str, id_field: str, record_id: int, **kwargs):
        """Асинхронное обновление записи"""
        if not kwargs:
            return
        
        set_clause = ", ".join([f"{k} = ${i+1}" for i, k in enumerate(kwargs.keys())])
        params = list(kwargs.values()) + [record_id]
        query = f"UPDATE {table} SET {set_clause} WHERE {id_field} = ${len(params)}"
        
        await self._execute(query, tuple(params))
        await log("[*]", f"Обновление записи {table} id={record_id} с данными {kwargs}")
        if table == "trips" and id_field == "trip_id":
            await self._execute(
                "UPDATE trips SET revision = COALESCE(revision, 1) + 1 WHERE trip_id = $1",
                (record_id,),
            )

    async def _execute_delete(self, table: str, id_field: str, record_id: int):
        """Асинхронное удаление записи"""
        await self._execute(f"DELETE FROM {table} WHERE {id_field} = $1", (record_id,))
        await log("[-]", f"Удалена запись {table} id={record_id}")

    async def _execute_get(self, table: str, id_field: str, record_id: int) -> Optional[Dict]:
        """Асинхронное получение записи"""
        return await self._execute(f"SELECT * FROM {table} WHERE {id_field} = $1", 
                                 (record_id,), fetchone=True)
    
    async def _execute_get_all(self, table: str, search_field: Optional[str] = None, 
        search_value: Optional[Any] = None) -> list[Dict]:
        """
        Асинхронное получение всех записей из таблицы.
        Можно указать search_field и search_value для фильтрации.
        
        Пример:
            await self._execute_get_all("trips", "status", "pending")
        """
        if search_field and search_value is not None:
            query = f"SELECT * FROM {table} WHERE {search_field} = $1"
            params = (search_value,)
        else:
            query = f"SELECT * FROM {table}"
            params = ()
        return await self._execute(query, params, fetchall=True)

    @staticmethod
    def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        R = 6371  # km
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        d_phi = math.radians(lat2 - lat1)
        d_lambda = math.radians(lon2 - lon1)
        a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    # ---------------------
    # КЛИЕНТЫ / ЛОГИН
    # ---------------------
    async def add_client(self, name: str, surname: str, phone: str, password: str, 
                        last_lat: float, last_lon: float, email: str = None) -> Optional[int]:
        try:
            result = await self._execute(
                """
                INSERT INTO clients(name, surname, phone, email, password, last_lat, last_lon, rating)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING client_id
                """,
                (name, surname, phone, email, password, last_lat, last_lon, 4.9), fetchone=True)
            
            if result:
                await log("[+]", f"Новый клиент: {name} {surname} телефон={phone}")
                return result["client_id"]
            
            return None
        
        except asyncpg.UniqueViolationError:
            await log("[!]", f"Телефон {phone} уже существует")
            return None
        
        except Exception as e:
            await log("[!]", f"Ошибка при добавлении клиента: {e}")
            return None
        
    async def get_client_by_phone(self, phone: str) -> Optional[Dict]:
        """
        Получить клиента по телефону
        """
        try:
            # Сначала ищем в clients
            client = await self._execute(
                "SELECT *, 'client' AS role FROM clients WHERE phone=$1",
                (phone,),
                fetchone=True
            )
            if client:
                return self._convert_decimals_to_floats(client)

            # Если не найден в clients, ищем в drivers
            driver = await self._execute(
                "SELECT *, 'driver' AS role FROM drivers WHERE phone=$1",
                (phone,),
                fetchone=True
            )
            if driver:
                return self._convert_decimals_to_floats(driver)
            
            return None  # вернёт словарь с данными клиента или None
        except Exception as e:
            await log("[!]", f"Ошибка при получении клиента по телефону {phone}: {e}")
            return None

    async def verify_client_credentials(self, phone: str, password: str) -> Optional[Dict]:
        """
        Проверка правильности пароля клиента
        """
        client = await self.get_client_by_phone(phone)
        if not client:
            return None

        # если используешь plain text пароли (не безопасно)
        if client["password"] == password:
            return client

        # если пароли хешированы, тут нужно делать проверку через bcrypt/argon2
        # пример:
        # import bcrypt
        # if bcrypt.checkpw(password.encode(), client["password"].encode()):
        #     return client

        return None

    async def update_client(self, client_id: int, **kwargs):
        await self._execute_update("clients", "client_id", client_id, **kwargs)

    async def delete_client(self, client_id: int):
        await self._execute_delete("clients", "client_id", client_id)

    async def get_client(self, client_id: int) -> Optional[Dict]:
        client = await self._execute_get("clients", "client_id", client_id)
        if client:
            return self._convert_decimals_to_floats(client)
        return None

    # ---------------------
    # ВОДИТЕЛИ
    # ---------------------
    async def add_driver(self, name: str, surname: str, 
        phone: str, password: str, 
        car_year: int, car_number: str, 
        tech_passport: str, driver_license: str,
        car_photo: str, driver_license_photo: str, 
        tech_passport_photo: str, face_photo: str,
        verification: str = "pending", last_lat: float = None,
        last_lon: float = None, email: str = None,
        car_name: str = "Unknown", car_category: str = "Econom", 
        price_per_km: float = PRICE_PER_KM_DEFAULT,
        status: str = "offline") -> Optional[int]:
        
        """
        Docstring для add_driver
        
        :param self: Описание
        :param name: Описание
        :type name: str
        :param surname: Описание
        :type surname: str
        :param phone: Описание
        :type phone: str
        :param password: Описание
        :type password: str
        :param car_year: Описание
        :type car_year: int
        :param car_number: Описание
        :type car_number: str
        :param tech_passport: Описание
        :type tech_passport: str
        :param driver_license: Описание
        :type driver_license: str
        :param car_photo: Описание
        :type car_photo: str
        :param driver_license_photo: Описание
        :type driver_license_photo: str
        :param tech_passport_photo: Описание
        :type tech_passport_photo: str
        :param face_photo: Описание
        :type face_photo: str
        :param verification: pending | verified | refused
        :type verification: str
        :param last_lat: Описание
        :type last_lat: float
        :param last_lon: Описание
        :type last_lon: float
        :param email: Описание
        :type email: str
        :param car_name: Описание
        :type car_name: str
        :param car_category: Описание
        :type car_category: str
        :param price_per_km: Описание
        :type price_per_km: float
        :param status: Описание
        :type status: str
        :return: Описание
        :rtype: int | None
        """

        try:
            result = await self._execute(
                """
                INSERT INTO drivers(
                    name, surname, phone, email, password, 
                    car_year, car_number, car_tech_passport, driver_license,
                    car_front_photo, driver_license_photo, car_tech_photo, face_photo, verification,
                    last_lat, last_lon, car_name, car_category, price_per_km, status
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                RETURNING driver_id
                """,
                (
                    name, surname, phone, email, password,
                    car_year, car_number, tech_passport, driver_license,
                    car_photo, driver_license_photo, tech_passport_photo, face_photo, verification,
                    last_lat, last_lon, car_name, car_category, price_per_km, status
                ), fetchone=True)
            
            if result:
                await log("[+]", f"Новый водитель: {name} {surname} телефон={phone}")
                return result["driver_id"]
            return None
        except Exception as e:
            await log("[!]", f"Не удалось добавить водителя {name} {surname}: {e}")
            return None    

    async def update_driver(self, driver_id: int, **kwargs):
        await self._execute_update("drivers", "driver_id", driver_id, **kwargs)

    async def delete_driver(self, driver_id: int):
        await self._execute_delete("drivers", "driver_id", driver_id)

    async def get_driver(self, driver_id: int) -> Optional[Dict]:
        driver = await self._execute_get("drivers", "driver_id", driver_id)
        if driver: 
            return self._convert_decimals_to_floats(driver)
        return None

    # ---------------------
    # ПОИСК БЛИЖАЙШИХ ВОДИТЕЛЕЙ
    # ---------------------
    async def find_nearby_drivers(self, last_lat: float, last_lon: float, radius_km: float = 5.0) -> List[Dict]:
        try:
            drivers = await self._execute(
                """
                SELECT * FROM drivers
                WHERE status = 'available'
                  AND last_lat IS NOT NULL
                  AND last_lon IS NOT NULL
                  AND LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = 'verified'
                """,
                fetchall=True)
            
            nearby = []
            for driver in drivers:
                if driver.get("is_banned") or driver.get("admin_disabled"):
                    continue
                driver_lat = float(driver["last_lat"]) if driver["last_lat"] is not None else None
                driver_lon = float(driver["last_lon"]) if driver["last_lon"] is not None else None
                
                if driver_lat is not None and driver_lon is not None:
                    distance = self._haversine(last_lat, last_lon, driver_lat, driver_lon)
                    if distance <= radius_km:
                        driver_dict = dict(driver)
                        driver_dict["distance_km"] = round(distance, 2)
                        nearby.append(self._convert_decimals_to_floats(driver_dict))
                    
            nearby.sort(key=lambda x: x["distance_km"])
            return nearby
        except Exception as e:
            await log("[!]", f"Ошибка поиска ближайших водителей: {e}")
            return []

    # ---------------------
    # ОТКАЗЫ
    # ---------------------

    async def add_refusal(
        self,
        trip_id: int,
        initiator_type: str,
        initiator_id: int,
        reason_type: str,
        reason_text: str,
        cancel_stage: str = None,
        driver_lat: float = None,
        driver_lon: float = None,
        client_lat: float = None,
        client_lon: float = None,
        penalty_applied: bool = False,
        penalty_amount: float = 0.0,
        penalty_rating: float = 0.0
    ) -> Optional[int]:
        """
        Добавление записи об отмене поездки.
        """

        try:
            result = await self._execute(
                """
                INSERT INTO refusals(
                    trip_id,
                    initiator_type,
                    initiator_id,
                    reason_type,
                    reason_text,
                    cancel_stage,
                    driver_lat,
                    driver_lon,
                    client_lat,
                    client_lon,
                    penalty_applied,
                    penalty_amount,
                    penalty_rating
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                RETURNING refusal_id
                """,
                (
                    trip_id,
                    initiator_type,
                    initiator_id,
                    reason_type,
                    reason_text,
                    cancel_stage,
                    driver_lat,
                    driver_lon,
                    client_lat,
                    client_lon,
                    penalty_applied,
                    penalty_amount,
                    penalty_rating
                ),
                fetchone=True
            )

            if result:
                await log("[+]", f"Добавлен отказ по поездке id={trip_id}")
                return result["refusal_id"]

            return None

        except Exception as e:
            await log("[!]", f"Ошибка добавления отказа trip_id={trip_id}: {e}")
            return None


    async def cancel_trip_with_refusal(
        self,
        trip_id: int,
        initiator_type: str,
        initiator_id: int,
        reason_type: str,
        reason_text: str,
        cancel_stage: str = None,
        driver_lat: float = None,
        driver_lon: float = None,
        client_lat: float = None,
        client_lon: float = None,
        penalty_amount: float = 0.0,
        penalty_rating: float = 0.0
    ) -> bool:
        """
        Полная логика отмены поездки:
        - обновление статуса trips
        - запись в refusals
        - применение штрафа
        - создание транзакции
        """

        if not self.pool:
            await self.connect()

        try:
            async with self.pool.acquire() as conn:
                async with conn.transaction():

                    # 1️⃣ Проверяем поездку
                    trip = await conn.fetchrow(
                        "SELECT * FROM trips WHERE trip_id=$1",
                        trip_id
                    )

                    if not trip:
                        await log("[!]", f"Отмена: поездка {trip_id} не найдена")
                        return False

                    if trip["status"] in ("completed", "cancelled"):
                        await log("[!]", f"Отмена: поездка {trip_id} уже завершена")
                        return False

                    # 2️⃣ Обновляем статус поездки
                    await conn.execute(
                        """
                        UPDATE trips
                        SET status='cancelled',
                            cancelled_at=$1
                        WHERE trip_id=$2
                        """,
                        datetime.now(),
                        trip_id
                    )

                    penalty_applied = penalty_amount > 0

                    # 3️⃣ Записываем отказ
                    refusal = await conn.fetchrow(
                        """
                        INSERT INTO refusals(
                            trip_id,
                            initiator_type,
                            initiator_id,
                            reason_type,
                            reason_text,
                            cancel_stage,
                            driver_lat,
                            driver_lon,
                            client_lat,
                            client_lon,
                            penalty_applied,
                            penalty_amount,
                            penalty_rating
                        )
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                        RETURNING refusal_id
                        """,
                        trip_id,
                        initiator_type,
                        initiator_id,
                        reason_type,
                        reason_text,
                        cancel_stage,
                        driver_lat,
                        driver_lon,
                        client_lat,
                        client_lon,
                        penalty_applied,
                        penalty_amount,
                        penalty_rating
                    )

                    # 4️⃣ Применяем штраф
                    if penalty_applied:

                        if initiator_type == "client":
                            await conn.execute(
                                "UPDATE clients SET balance = balance - $1 WHERE client_id=$2",
                                penalty_amount,
                                initiator_id
                            )

                        elif initiator_type == "driver":
                            await conn.execute(
                                "UPDATE drivers SET balance = balance - $1 WHERE driver_id=$2",
                                penalty_amount,
                                initiator_id
                            )

                        # создаём транзакцию
                        await conn.execute(
                            """
                            INSERT INTO transactions(user_type, user_id, amount, type, description)
                            VALUES ($1,$2,$3,$4,$5)
                            """,
                            initiator_type,
                            initiator_id,
                            -penalty_amount,
                            "penalty",
                            f"Штраф за отмену поездки #{trip_id}"
                        )

                    try:
                        dr_assigned = trip.get("driver_id")
                        if dr_assigned is not None:
                            drid = int(dr_assigned)
                            if initiator_type == "driver" and int(initiator_id) == drid:
                                await conn.execute(
                                    """
                                    UPDATE drivers SET rating_coefficient = GREATEST(1.0, LEAST(2.0,
                                        COALESCE(rating_coefficient, 1.0)::double precision - 0.06))
                                    WHERE driver_id = $1
                                    """,
                                    drid,
                                )
                            elif initiator_type == "client":
                                await conn.execute(
                                    """
                                    UPDATE drivers SET rating_coefficient = GREATEST(1.0, LEAST(2.0,
                                        COALESCE(rating_coefficient, 1.0)::double precision + 0.01))
                                    WHERE driver_id = $1
                                    """,
                                    drid,
                                )
                    except (TypeError, ValueError):
                        pass

                    await log("[*]", f"Поездка {trip_id} отменена. Refusal id={refusal['refusal_id']}")
                    return True

        except Exception as e:
            await log("[!]", f"Ошибка cancel_trip_with_refusal trip_id={trip_id}: {e}")
            return False

    async def get_refusal(self, refusal_id: int) -> Optional[Dict]:
        refusal = await self._execute_get("refusals", "refusal_id", refusal_id)
        if refusal:
            return self._convert_decimals_to_floats(refusal)
        return None


    async def get_refusals_by_trip(self, trip_id: int) -> List[Dict]:
        refusals = await self._execute(
            "SELECT * FROM refusals WHERE trip_id=$1 ORDER BY created_at DESC",
            (trip_id,),
            fetchall=True
        )

        return self._convert_decimals_to_floats(refusals) if refusals else []


    async def get_refusals_by_initiator(
        self,
        initiator_type: str,
        initiator_id: int
    ) -> List[Dict]:

        refusals = await self._execute(
            """
            SELECT * FROM refusals
            WHERE initiator_type=$1 AND initiator_id=$2
            ORDER BY created_at DESC
            """,
            (initiator_type, initiator_id),
            fetchall=True
        )

        return self._convert_decimals_to_floats(refusals) if refusals else []


    async def delete_refusal(self, refusal_id: int):
        await self._execute_delete("refusals", "refusal_id", refusal_id)

    def invalidate_pricing_cache(self) -> None:
        self._pricing_cache = None
        self._pricing_model_cache = None
        self._accept_stats_cache = None
        self._reference_pkm_cache = None

    def invalidate_dispatch_settings_cache(self) -> None:
        self._dispatch_settings_cache = None

    def invalidate_app_settings_caches(self) -> None:
        self.invalidate_pricing_cache()
        self.invalidate_dispatch_settings_cache()

    async def get_pricing_params(self) -> Dict[str, float]:
        if self._pricing_cache is not None:
            return self._pricing_cache
        m = await self.get_pricing_model()
        self._pricing_cache = {
            "price_per_km": float(m.get("legacy_price_per_km") or 0),
            "trip_base_fee": float(m.get("trip_base_fee") or 0),
        }
        return self._pricing_cache

    async def get_pricing_model(self) -> Dict[str, Any]:
        """Полная модель ценообразования (ступени км, минута, минимум, вес расстояния в dispatch)."""
        if self._pricing_model_cache is not None:
            return self._pricing_model_cache
        keys = (
            "price_per_km",
            "trip_base_fee",
            "pricing_km_tiers_json",
            "pricing_per_minute_azn",
            "pricing_min_price_azn",
            "pricing_long_trip_floor_per_km",
            "pricing_long_trip_km_threshold",
            "pricing_long_trip_post_cap_mult",
            "pricing_long_trip_max_wave_mult",
            "pricing_quote_nearby_driver_km",
            "pricing_market_ref_high_mult",
            "pricing_market_ref_low_mult",
            "pricing_market_ref_short_max_km",
            "pricing_market_ref_pkm_short",
            "dispatch_priority_dist_weight",
        )
        vals: Dict[str, str] = {}
        try:
            rows = await self._execute(
                "SELECT key, value FROM app_settings WHERE key = ANY($1::text[])",
                (list(keys),),
                fetchall=True,
            )
            for r in rows or []:
                vals[str(r.get("key") or "")] = (r.get("value") or "").strip()
        except Exception:
            rows = []

        def _f(key: str, default: float) -> float:
            try:
                return float(vals.get(key) or default)
            except (TypeError, ValueError):
                return default

        legacy = _f("price_per_km", float(PRICE_PER_KM_DEFAULT))
        base = max(0.0, _f("trip_base_fee", 0.0))
        tiers = pricing_engine.parse_km_tiers_json(vals.get("pricing_km_tiers_json"))
        per_min = max(0.0, _f("pricing_per_minute_azn", pricing_engine.DEFAULT_PER_MINUTE))
        min_price = max(0.0, _f("pricing_min_price_azn", pricing_engine.DEFAULT_MIN_PRICE))
        long_floor = max(0.0, _f("pricing_long_trip_floor_per_km", pricing_engine.DEFAULT_LONG_TRIP_LINEAR_CAP_PER_KM))
        long_km = max(0.0, _f("pricing_long_trip_km_threshold", pricing_engine.DEFAULT_LONG_TRIP_KM_THRESHOLD))
        long_post_cap = max(1.0, _f("pricing_long_trip_post_cap_mult", pricing_engine.DEFAULT_LONG_TRIP_POST_CAP_MULT))
        long_max_wave = max(
            1.0,
            min(2.0, _f("pricing_long_trip_max_wave_mult", pricing_engine.DEFAULT_LONG_TRIP_MAX_WAVE_MULT)),
        )
        quote_nearby_km = max(0.0, _f("pricing_quote_nearby_driver_km", pricing_engine.DEFAULT_NEARBY_DRIVER_KM))
        ref_hi = max(1.0, min(1.35, _f("pricing_market_ref_high_mult", pricing_engine.DEFAULT_MARKET_REF_HIGH_MULT)))
        ref_lo = max(0.5, min(1.0, _f("pricing_market_ref_low_mult", pricing_engine.DEFAULT_MARKET_REF_LOW_MULT)))
        ref_short_max_km = max(0.0, min(500.0, _f("pricing_market_ref_short_max_km", 0.0)))
        ref_pkm_short = max(0.0, min(2.5, _f("pricing_market_ref_pkm_short", 0.0)))
        dist_w = max(0.0, _f("dispatch_priority_dist_weight", pricing_engine.DEFAULT_DISPATCH_DIST_WEIGHT))

        self._pricing_model_cache = {
            "legacy_price_per_km": legacy,
            "trip_base_fee": base,
            "km_tiers": tiers,
            "per_minute": per_min,
            "min_price": min_price,
            "long_trip_floor_per_km": long_floor,
            "long_trip_km_threshold": long_km,
            "long_trip_post_cap_mult": long_post_cap,
            "long_trip_max_wave_mult": long_max_wave,
            "quote_nearby_driver_km": quote_nearby_km,
            "market_ref_high_mult": ref_hi,
            "market_ref_low_mult": ref_lo,
            "market_ref_short_max_km": ref_short_max_km,
            "market_ref_pkm_short": ref_pkm_short,
            "dispatch_dist_weight": dist_w,
            "pricing_km_tiers_json": vals.get("pricing_km_tiers_json") or pricing_engine.tiers_to_json(tiers),
        }
        return self._pricing_model_cache

    async def count_open_dispatch_trips(self) -> int:
        row = await self._execute(
            """
            SELECT COUNT(*)::int AS c FROM trips
            WHERE status IN ('pending', 'offered') AND driver_id IS NULL
            """,
            (),
            fetchone=True,
        )
        return int(row["c"]) if row else 0

    async def count_available_verified_drivers(self) -> int:
        row = await self._execute(
            """
            SELECT COUNT(*)::int AS c FROM drivers
            WHERE status = 'available'
              AND LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = 'verified'
              AND COALESCE(admin_disabled, FALSE) = FALSE
              AND COALESCE(is_banned, FALSE) = FALSE
            """,
            (),
            fetchone=True,
        )
        return max(1, int(row["c"] or 0)) if row else 1

    async def count_available_verified_drivers_raw(self) -> int:
        """Фактическое число свободных проверенных водителей (может быть 0)."""
        row = await self._execute(
            """
            SELECT COUNT(*)::int AS c FROM drivers
            WHERE status = 'available'
              AND LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = 'verified'
              AND COALESCE(admin_disabled, FALSE) = FALSE
              AND COALESCE(is_banned, FALSE) = FALSE
            """,
            (),
            fetchone=True,
        )
        return int(row["c"] or 0) if row else 0

    async def get_accept_time_stats_cached(self) -> Tuple[float, int]:
        """
        Среднее время (сек) от created_at до accepted_at и размер выборки за 72 ч.
        Если выборка мала — avg_sec = -1.0.
        """
        now = time.monotonic()
        if self._accept_stats_cache is not None:
            ts, avg_sec, n = self._accept_stats_cache
            if now - ts < 90.0:
                return float(avg_sec), int(n)
        row = await self._execute(
            """
            SELECT COUNT(*)::int AS n,
                   AVG(EXTRACT(EPOCH FROM (t.accepted_at - t.created_at)))::float AS avg_sec
            FROM trips t
            WHERE t.created_at > NOW() - INTERVAL '72 hours'
              AND t.accepted_at IS NOT NULL
              AND t.driver_id IS NOT NULL
              AND t.status IN ('accepted', 'busy', 'completed')
            """,
            (),
            fetchone=True,
        )
        if not row:
            self._accept_stats_cache = (now, -1.0, 0)
            return -1.0, 0
        n = int(row.get("n") or 0)
        avg_sec_raw = row.get("avg_sec")
        if n < 6 or avg_sec_raw is None:
            self._accept_stats_cache = (now, -1.0, n)
            return -1.0, n
        try:
            sec = float(avg_sec_raw)
        except (TypeError, ValueError):
            self._accept_stats_cache = (now, -1.0, n)
            return -1.0, n
        self._accept_stats_cache = (now, sec, n)
        return sec, n

    @staticmethod
    def _market_multiplier_from_accept_sec(avg_sec: float, n: int) -> float:
        """Медленное принятие → чуть дороже; быстрое → чуть дешевле."""
        if n < 6 or avg_sec < 0.0:
            return 1.0
        if avg_sec >= 300.0:
            m = 1.065
        elif avg_sec >= 180.0:
            m = 1.05
        elif avg_sec >= 120.0:
            m = 1.03
        elif avg_sec <= 22.0:
            m = 0.965
        elif avg_sec <= 40.0:
            m = 0.985
        else:
            m = 1.0
        return max(0.95, min(1.07, float(m)))

    async def compute_market_price_adjustment(self) -> float:
        avg_sec, n = await self.get_accept_time_stats_cached()
        return float(self._market_multiplier_from_accept_sec(avg_sec, n))

    async def compute_market_price_adjustment_cached(self) -> float:
        avg_sec, n = await self.get_accept_time_stats_cached()
        return float(self._market_multiplier_from_accept_sec(avg_sec, n))

    async def compute_reference_price_per_km(self) -> float:
        """
        Якорь рынка: средняя фактическая ₼/км по завершённым поездкам (14 дней).
        Регионы в схеме не заданы — глобально по сервису; при малых данных — price_per_km из настроек.
        """
        row = await self._execute(
            """
            SELECT COALESCE(AVG(t.price / NULLIF(t.distance_km, 0)), 0)::float AS ref,
                   COUNT(*)::int AS n
            FROM trips t
            WHERE t.status = 'completed'
              AND t.completed_at > NOW() - INTERVAL '14 days'
              AND t.distance_km > 0.5
              AND COALESCE(t.price, 0) > 0
            """,
            (),
            fetchone=True,
        )
        n = int(row["n"] or 0) if row else 0
        ref = float(row["ref"] or 0) if row else 0.0
        if n >= 5 and ref > 0:
            return max(0.12, min(2.5, ref))
        row2 = await self._execute(
            "SELECT value FROM app_settings WHERE key = 'price_per_km' LIMIT 1",
            (),
            fetchone=True,
        )
        try:
            leg = float((row2 or {}).get("value") or 0)
        except (TypeError, ValueError):
            leg = 0.0
        if leg > 0:
            return max(0.12, min(2.5, leg))
        return 0.38

    async def get_reference_price_per_km_cached(self) -> float:
        now = time.monotonic()
        if self._reference_pkm_cache is not None:
            ts, val = self._reference_pkm_cache
            if now - ts < 600.0:
                return float(val)
        v = await self.compute_reference_price_per_km()
        self._reference_pkm_cache = (now, float(v))
        return float(v)

    async def compute_demand_coefficient(self) -> float:
        o = await self.count_open_dispatch_trips()
        d = await self.count_available_verified_drivers()
        return pricing_engine.demand_coefficient_from_ratio(o, d)

    async def compute_trip_price_azn(
        self,
        distance_km: Optional[float],
        duration_minutes: Optional[float] = None,
        *,
        wave: int = 1,
        demand_coef: Optional[float] = None,
        nearest_driver_km: Optional[float] = None,
        dispatch_pressure_mult: Optional[float] = None,
        apply_auto_market: bool = True,
    ) -> float:
        m = await self.get_pricing_model()
        try:
            dk = float(distance_km or 0)
        except (TypeError, ValueError):
            dk = 0.0
        try:
            dm = float(duration_minutes or 0)
        except (TypeError, ValueError):
            dm = 0.0
        if demand_coef is None:
            demand_coef = await self.compute_demand_coefficient()
        long_km_th = float(m["long_trip_km_threshold"])
        if dispatch_pressure_mult is not None:
            pressure = float(dispatch_pressure_mult)
        elif dk > long_km_th:
            pressure = pricing_engine.long_trip_dispatch_pressure_mult(int(wave))
        else:
            pressure = 1.0

        market = await self.compute_market_price_adjustment_cached() if apply_auto_market else 1.0
        raw_d = await self.count_available_verified_drivers_raw()
        if raw_d <= 0:
            supply = 1.10
        elif raw_d == 1:
            supply = 1.05
        elif raw_d <= 3:
            supply = 1.025
        else:
            supply = 1.0

        _pcm_raw = m.get("long_trip_post_cap_mult")
        if _pcm_raw is None:
            post_cap_mult = float(pricing_engine.DEFAULT_LONG_TRIP_POST_CAP_MULT)
        else:
            post_cap_mult = max(1.0, float(_pcm_raw))

        short_max = float(m.get("market_ref_short_max_km") or 0.0)
        short_pkm = float(m.get("market_ref_pkm_short") or 0.0)
        is_short_pricing = short_max > 0.0 and short_pkm > 0.0 and dk <= short_max + 1e-9
        pm_metrics: Dict[str, Any] = {"wave_index": int(wave)}
        raw_after_mult: float
        anchor_used: Optional[float] = None
        ref_controller_applied = False

        if is_short_pricing:
            anchor_used = max(0.12, min(2.5, float(short_pkm)))
            base_before = pricing_engine.compute_short_anchor_base_before_multipliers(
                distance_km=dk,
                duration_minutes=dm,
                trip_base_fee=float(m["trip_base_fee"]),
                per_minute=float(m["per_minute"]),
                anchor_pkm_per_km=float(anchor_used),
            )
            pm_metrics["pricing_mode"] = "short_anchor"
            pm_metrics["distance_model"] = "linear_anchor_only"
            pm_metrics["anchor_pkm"] = float(anchor_used)
            raw_after_mult = pricing_engine.apply_wave_demand_market_to_base(
                base_before,
                distance_km=dk,
                min_price=float(m["min_price"]),
                long_trip_km=long_km_th,
                long_trip_floor_per_km=float(m["long_trip_floor_per_km"]),
                wave=int(wave),
                demand_coef=float(demand_coef),
                nearest_driver_km=nearest_driver_km,
                long_trip_post_cap_mult=post_cap_mult,
                long_trip_max_wave_mult=float(
                    m.get("long_trip_max_wave_mult") or pricing_engine.DEFAULT_LONG_TRIP_MAX_WAVE_MULT
                ),
                nearby_driver_km_threshold=float(
                    m.get("quote_nearby_driver_km") or pricing_engine.DEFAULT_NEARBY_DRIVER_KM
                ),
                market_adjust=float(market),
                supply_shortage_mult=float(supply),
                dispatch_pressure_mult=float(pressure),
                metrics_out=pm_metrics,
            )
            out = float(raw_after_mult)
        else:
            pm_metrics["pricing_mode"] = "tiers_plus_market_ref"
            pm_metrics["distance_model"] = "km_tiers_long_cap"
            raw_after_mult = pricing_engine.compute_final_trip_price(
                distance_km=dk,
                duration_minutes=dm,
                trip_base_fee=float(m["trip_base_fee"]),
                per_minute=float(m["per_minute"]),
                tiers=list(m["km_tiers"]),
                min_price=float(m["min_price"]),
                long_trip_km=long_km_th,
                long_trip_floor_per_km=float(m["long_trip_floor_per_km"]),
                wave=int(wave),
                demand_coef=float(demand_coef),
                nearest_driver_km=nearest_driver_km,
                long_trip_post_cap_mult=post_cap_mult,
                long_trip_max_wave_mult=float(
                    m.get("long_trip_max_wave_mult") or pricing_engine.DEFAULT_LONG_TRIP_MAX_WAVE_MULT
                ),
                nearby_driver_km_threshold=float(
                    m.get("quote_nearby_driver_km") or pricing_engine.DEFAULT_NEARBY_DRIVER_KM
                ),
                market_adjust=float(market),
                supply_shortage_mult=float(supply),
                dispatch_pressure_mult=float(pressure),
                metrics_out=pm_metrics,
            )
            ref_pkm = await self.get_reference_price_per_km_cached()
            anchor_used = float(ref_pkm)
            ref_hi = float(m.get("market_ref_high_mult") or pricing_engine.DEFAULT_MARKET_REF_HIGH_MULT)
            ref_lo = float(m.get("market_ref_low_mult") or pricing_engine.DEFAULT_MARKET_REF_LOW_MULT)
            long_floor = max(0.0, float(m.get("long_trip_floor_per_km") or 0.0))
            linear_long_max: Optional[float] = None
            if dk > long_km_th and long_floor > 0.0:
                linear_long_max = float(dk) * long_floor * float(post_cap_mult)
            out = pricing_engine.apply_reference_price_controller(
                float(raw_after_mult),
                distance_km=dk,
                reference_price_per_km=float(ref_pkm),
                min_price=float(m["min_price"]),
                low_mult=ref_lo,
                high_mult=ref_hi,
                linear_long_max=linear_long_max,
            )
            ref_controller_applied = True
            pm_metrics["reference_pkm_for_controller"] = float(ref_pkm)
            pm_metrics["ref_high_mult"] = ref_hi
            pm_metrics["ref_low_mult"] = ref_lo
            pm_metrics["linear_long_max"] = linear_long_max
            if linear_long_max is not None:
                out = min(float(out), float(linear_long_max))

        pm_metrics["base_before_reference_controller"] = round(float(raw_after_mult), 4)
        pm_metrics["base_after_controller"] = round(float(out), 4)
        pm_metrics["raw_after_multipliers"] = round(float(raw_after_mult), 4)
        pm_metrics["ref_controller_applied"] = ref_controller_applied
        if anchor_used is not None:
            pm_metrics["anchor_used"] = round(float(anchor_used), 6)
        logger.info(
            "[pricing] dk=%.4f mode=%s before_ref=%.4f after_ctrl=%.4f anchor_pkm=%s "
            "ref_ctrl=%s wave=%s demand=%s combo=%s nearby=%s long_route=%s",
            dk,
            pm_metrics.get("pricing_mode"),
            float(raw_after_mult),
            float(out),
            pm_metrics.get("anchor_used"),
            ref_controller_applied,
            pm_metrics.get("wave_mult"),
            pm_metrics.get("demand_mult"),
            pm_metrics.get("combo_mult"),
            pm_metrics.get("nearby_offer"),
            pm_metrics.get("is_long_route"),
        )

        return max(float(m["min_price"]), round(float(out), 2))

    async def trip_quote_amount(
        self,
        distance_km: Optional[float],
        *,
        duration_minutes: Optional[float] = None,
        wave: int = 1,
        demand_coef: Optional[float] = None,
        nearest_driver_km: Optional[float] = None,
        apply_auto_market: bool = True,
    ) -> float:
        return await self.compute_trip_price_azn(
            distance_km,
            duration_minutes,
            wave=wave,
            demand_coef=demand_coef,
            nearest_driver_km=nearest_driver_km,
            apply_auto_market=apply_auto_market,
        )

    async def update_trip_price_for_dispatch_wave(
        self,
        trip_id: int,
        wave: int,
        nearest_driver_km: Optional[float] = None,
        *,
        pricing_wave: Optional[int] = None,
        dispatch_quality_tier: Optional[int] = None,
        wait_since_first_sec: Optional[float] = None,
    ) -> Optional[float]:
        row = await self.get_trips(trip_id=trip_id)
        if not row:
            return None
        if row.get("driver_id"):
            return None
        try:
            dk = float(row.get("distance_km") or 0)
        except (TypeError, ValueError):
            dk = 0.0
        dm_raw = row.get("route_duration_minutes")
        try:
            dm = float(dm_raw) if dm_raw is not None else 0.0
        except (TypeError, ValueError):
            dm = 0.0
        pw = int(pricing_wave) if pricing_wave is not None else int(wave)
        price = await self.compute_trip_price_azn(
            dk, dm, wave=int(pw), demand_coef=None, nearest_driver_km=nearest_driver_km
        )
        sc = await self.get_dispatch_scoring_settings()
        qt = max(1, min(3, int(dispatch_quality_tier or 1)))
        t2 = max(0.0, float(sc.get("dispatch_tier2_price_surge", 0.03)))
        t3 = max(0.0, float(sc.get("dispatch_tier3_extra_price_surge", 0.02)))
        surge = 1.0
        if qt >= 3:
            surge = 1.0 + t2 + t3
        elif qt >= 2:
            surge = 1.0 + t2
        w = float(wait_since_first_sec) if wait_since_first_sec is not None else 0.0
        t15 = float(sc.get("dispatch_time_surge_at_15", 15.0))
        t30 = float(sc.get("dispatch_time_surge_at_30", 30.0))
        t45 = float(sc.get("dispatch_time_surge_at_45", 45.0))
        p15 = max(0.0, float(sc.get("dispatch_time_surge_pct_15", 0.015)))
        p30 = max(0.0, float(sc.get("dispatch_time_surge_pct_30", 0.015)))
        p45 = max(0.0, float(sc.get("dispatch_time_surge_pct_45", 0.015)))
        tcap = max(0.0, float(sc.get("dispatch_time_surge_total_cap", 0.075)))
        time_add = 0.0
        if w >= t15:
            time_add += p15
        if w >= t30:
            time_add += p30
        if w >= t45:
            time_add += p45
        time_add = min(tcap, time_add)
        surge = float(surge) * (1.0 + time_add)
        try:
            cm = float(row.get("client_dispatch_boost_mult") or 1.0)
        except (TypeError, ValueError):
            cm = 1.0
        if cm < 1.0:
            cm = 1.0
        surge *= cm
        price = float(price) * surge
        m = await self.get_pricing_model()
        floor = max(0.0, float(m.get("min_price") or 0.0))
        price = max(floor, round(float(price), 2))
        await self._execute(
            """
            UPDATE trips SET price = $2, revision = COALESCE(revision, 1) + 1
            WHERE trip_id = $1 AND driver_id IS NULL
              AND status IN ('pending', 'offered')
            """,
            (int(trip_id), float(price)),
        )
        return float(price)

    async def apply_client_dispatch_boost(self, trip_id: int, client_id: int) -> Optional[Dict[str, Any]]:
        """Одноразовый мягкий буст цены клиентом, пока заказ в поиске (pending/offered)."""
        sc = await self.get_dispatch_scoring_settings()
        mult = max(1.0, min(1.12, float(sc.get("dispatch_client_boost_price_mult", 1.04))))
        row = await self._execute(
            """
            UPDATE trips SET
                price = ROUND(price::numeric * $3::numeric, 2),
                client_dispatch_boost_mult = GREATEST(
                    COALESCE(client_dispatch_boost_mult, 1.0)::double precision,
                    $3::double precision
                ),
                revision = COALESCE(revision, 1) + 1
            WHERE trip_id = $1
              AND client_id = $2
              AND status IN ('pending', 'offered')
              AND driver_id IS NULL
              AND COALESCE(client_dispatch_boost_mult, 1.0) < 1.001
            RETURNING *
            """,
            (int(trip_id), int(client_id), float(mult)),
            fetchone=True,
        )
        return self._convert_decimals_to_floats(dict(row)) if row else None

    async def driver_remove_from_offer_wave(self, trip_id: int, driver_id: int) -> Optional[Dict[str, Any]]:
        """Водитель явно снимается с текущей волны (убрать из offer_driver_ids), заказ остаётся offered."""
        row = await self._execute(
            """
            UPDATE trips SET
                offer_driver_ids = array_remove(COALESCE(offer_driver_ids, ARRAY[]::INTEGER[]), $2::integer),
                revision = COALESCE(revision, 1) + 1
            WHERE trip_id = $1
              AND driver_id IS NULL
              AND status = 'offered'
              AND $2::integer = ANY(COALESCE(offer_driver_ids, ARRAY[]::INTEGER[]))
            RETURNING *
            """,
            (int(trip_id), int(driver_id)),
            fetchone=True,
        )
        return self._convert_decimals_to_floats(dict(row)) if row else None

    async def adjust_driver_dispatch_coefficient(self, driver_id: int, delta: float) -> None:
        if not driver_id or delta == 0:
            return
        await self._execute(
            """
            UPDATE drivers
            SET rating_coefficient = GREATEST(1.0, LEAST(2.0,
                COALESCE(rating_coefficient, 1.0)::double precision + $2::double precision
            ))
            WHERE driver_id = $1
            """,
            (int(driver_id), float(delta)),
        )

    async def record_driver_offer_accepted(self, driver_id: int) -> None:
        """
        После фактического принятия оффера: плавно поднимает acceptance_rate (EMA),
        чтобы поле отражало поведение, а не только ручное значение из админки.
        Формула: new = old * (1 - α) + 1.0 * α, α = 0.15, clamp [0.03, 0.99].
        """
        if not driver_id:
            return
        alpha = 0.15
        await self._execute(
            """
            UPDATE drivers SET
                acceptance_rate = GREATEST(0.03::double precision, LEAST(0.99::double precision,
                    COALESCE(acceptance_rate, 0.75)::double precision * (1.0::double precision - $2::double precision)
                    + $2::double precision * 1.0::double precision
                )),
                updated_at = CURRENT_TIMESTAMP
            WHERE driver_id = $1
            """,
            (int(driver_id), float(alpha)),
        )

    async def record_driver_offer_declined(self, driver_id: int) -> None:
        """Водитель отказался ждать клиента / от оффера: EMA к 0, α = 0.15."""
        if not driver_id:
            return
        alpha = 0.15
        await self._execute(
            """
            UPDATE drivers SET
                acceptance_rate = GREATEST(0.03::double precision, LEAST(0.99::double precision,
                    COALESCE(acceptance_rate, 0.75)::double precision * (1.0::double precision - $2::double precision)
                    + $2::double precision * 0.0::double precision
                )),
                updated_at = CURRENT_TIMESTAMP
            WHERE driver_id = $1
            """,
            (int(driver_id), float(alpha)),
        )

    async def driver_release_trip_awaiting_client(
        self, trip_id: int, driver_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Водитель принял заказ, но не хочет ждать подтверждения клиента:
        снимаем назначение, status=offered, снова диспетчеризация тем же trip_id.
        """
        tid = int(trip_id)
        did = int(driver_id)
        row = await self._execute(
            """
            UPDATE trips SET
                driver_id = NULL,
                status = 'offered',
                state = 'pending_confirm',
                offer_driver_ids = NULL,
                offer_expires_at = NULL,
                dispatch_wave = 0,
                dispatch_radius_km = 3,
                dispatch_quality_tier = 1,
                dispatch_solo_driver_id = NULL,
                dispatch_seen_driver_ids = array_remove(
                    COALESCE(dispatch_seen_driver_ids, ARRAY[]::integer[]), $3::integer
                ),
                accepted_at = NULL,
                revision = COALESCE(revision, 1) + 1
            WHERE trip_id = $1
              AND driver_id = $2
              AND status = 'accepted'
            RETURNING *
            """,
            (tid, did, did),
            fetchone=True,
        )
        if not row:
            return None
        await self.record_driver_offer_declined(did)
        try:
            await self.add_refusal(
                tid,
                "driver",
                did,
                "radio",
                "driver_release_awaiting_client",
                cancel_stage="accepted",
            )
        except Exception:
            pass
        return self._convert_decimals_to_floats(dict(row))

    async def ensure_default_pricing_app_settings(self) -> None:
        """Если в app_settings ещё нет ключей динамического тарифа — создать (старые БД)."""
        tiers = json.dumps(
            [
                {"up_to": 5, "rate": 0.5},
                {"up_to": 20, "rate": 0.45},
                {"up_to": 50, "rate": 0.4},
                {"up_to": 100, "rate": 0.35},
                {"up_to": None, "rate": 0.32},
            ],
            ensure_ascii=False,
        )
        defaults = (
            ("pricing_km_tiers_json", tiers),
            ("pricing_per_minute_azn", "0.04"),
            ("pricing_min_price_azn", "1"),
            ("pricing_long_trip_floor_per_km", "0.34"),
            ("pricing_long_trip_km_threshold", "100"),
            ("pricing_long_trip_post_cap_mult", "1.05"),
            ("pricing_long_trip_max_wave_mult", "1.08"),
            ("pricing_quote_nearby_driver_km", "1"),
            ("pricing_market_ref_high_mult", "1.1"),
            ("pricing_market_ref_low_mult", "0.88"),
            ("pricing_market_ref_short_max_km", "0"),
            ("pricing_market_ref_pkm_short", "0"),
            ("dispatch_priority_dist_weight", "0.18"),
            ("dispatch_min_offer_gap_sec", "12"),
            ("dispatch_wave1_share", "0.2"),
            ("dispatch_wave2_share", "0.3"),
            ("dispatch_tier2_price_surge", "0.03"),
            ("dispatch_tier3_extra_price_surge", "0.02"),
            ("dispatch_decline_penalty_per_streak", "0.085"),
            ("dispatch_react_fast_sec", "5"),
            ("dispatch_react_slow_sec", "15"),
            ("dispatch_react_fast_bonus", "0.042"),
            ("dispatch_react_slow_penalty", "0.055"),
            ("dispatch_far_km_threshold", "4"),
            ("dispatch_far_priority_bonus", "0.035"),
            ("dispatch_load_penalty_per_trip", "0.038"),
            ("dispatch_priority_rating_weight", "2.85"),
            ("dispatch_priority_accept_sq_weight", "2.35"),
            ("dispatch_idle_long_sec", "600"),
            ("dispatch_decline_penalty_scale", "0.085"),
            ("dispatch_time_surge_at_15", "15"),
            ("dispatch_time_surge_at_30", "30"),
            ("dispatch_time_surge_at_45", "45"),
            ("dispatch_time_surge_pct_15", "0.015"),
            ("dispatch_time_surge_pct_30", "0.015"),
            ("dispatch_time_surge_pct_45", "0.015"),
            ("dispatch_time_surge_total_cap", "0.075"),
            ("dispatch_solo_min_accept", "0.70"),
            ("dispatch_solo_min_rating", "4.0"),
            ("dispatch_near_good_km", "0.7"),
            ("dispatch_near_good_min_accept", "0.60"),
            ("dispatch_near_good_min_rating", "4.0"),
            ("dispatch_wave_max_pick_km", "2.5"),
            ("dispatch_trip_repeat_cooldown_sec", "45"),
            ("dispatch_distw_auto", "1"),
            ("dispatch_distw_density_low_n", "5"),
            ("dispatch_distw_density_high_n", "16"),
            ("dispatch_distw_sparse", "0.135"),
            ("dispatch_distw_dense", "0.22"),
            ("dispatch_score_dist_ref_km", "4"),
            ("dispatch_score_load_ref_trips", "8"),
            ("dispatch_idle_score_weight", "0.55"),
            ("dispatch_stability_bonus_max", "0.042"),
            ("dispatch_stability_var_threshold", "0.085"),
            ("dispatch_client_slow_hint_sec", "50"),
            ("dispatch_client_boost_pct", "0.04"),
            ("dispatch_client_boost_price_mult", "1.04"),
            ("dispatch_wave1_min_size", "2"),
        )
        for key, val in defaults:
            await self._execute(
                """
                INSERT INTO app_settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO NOTHING
                """,
                (key, val),
            )

    @staticmethod
    def _admin_safe_float(raw: Any, default: float) -> float:
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return float(default)
        if math.isnan(v) or math.isinf(v):
            return float(default)
        return v

    async def admin_get_project_settings(self) -> Dict[str, Any]:
        """Читает ключи напрямую из app_settings (без in-memory pricing model), чтобы админка = БД."""
        await self.ensure_default_pricing_app_settings()
        await self.ensure_default_withdrawal_timeline_messages()
        self.invalidate_pricing_cache()
        self.invalidate_dispatch_settings_cache()
        keys = (
            "price_per_km",
            "trip_base_fee",
            "dispatch_wave_timeout_sec",
            "dispatch_wave_size",
            "pricing_km_tiers_json",
            "pricing_per_minute_azn",
            "pricing_min_price_azn",
            "pricing_long_trip_floor_per_km",
            "pricing_long_trip_km_threshold",
            "pricing_long_trip_post_cap_mult",
            "pricing_long_trip_max_wave_mult",
            "pricing_quote_nearby_driver_km",
            "pricing_market_ref_high_mult",
            "pricing_market_ref_low_mult",
            "pricing_market_ref_short_max_km",
            "pricing_market_ref_pkm_short",
            "dispatch_priority_dist_weight",
            "dispatch_min_offer_gap_sec",
            "dispatch_wave1_share",
            "dispatch_wave2_share",
            "dispatch_tier2_price_surge",
            "dispatch_tier3_extra_price_surge",
            "dispatch_decline_penalty_per_streak",
            "dispatch_react_fast_sec",
            "dispatch_react_slow_sec",
            "dispatch_react_fast_bonus",
            "dispatch_react_slow_penalty",
            "dispatch_far_km_threshold",
            "dispatch_far_priority_bonus",
            "dispatch_load_penalty_per_trip",
            "dispatch_priority_rating_weight",
            "dispatch_priority_accept_sq_weight",
            "dispatch_idle_long_sec",
            "withdrawal_timeline_pending",
            "withdrawal_timeline_processing",
            "withdrawal_timeline_completed",
            "withdrawal_timeline_rejected",
        )
        rows = await self._execute(
            "SELECT key, value FROM app_settings WHERE key = ANY($1::text[])",
            (list(keys),),
            fetchall=True,
        )
        vals: Dict[str, str] = {
            str(r["key"]): (r.get("value") or "").strip() for r in (rows or [])
        }

        def _fv(key: str, default: float) -> float:
            return self._admin_safe_float(vals.get(key), default)

        def _iv(key: str, default: int) -> int:
            try:
                return int(float(vals.get(key) or default))
            except (TypeError, ValueError):
                return int(default)

        tiers_raw = (vals.get("pricing_km_tiers_json") or "").strip()
        tiers_parsed = pricing_engine.parse_km_tiers_json(tiers_raw if tiers_raw else None)
        tiers_json = tiers_raw if tiers_raw else pricing_engine.tiers_to_json(tiers_parsed)

        out = {
            "price_per_km": _fv("price_per_km", float(PRICE_PER_KM_DEFAULT)),
            "trip_base_fee": max(0.0, _fv("trip_base_fee", 0.0)),
            "dispatch_wave_timeout_sec": max(3, min(120, _iv("dispatch_wave_timeout_sec", 12))),
            "dispatch_wave_size": max(1, min(20, _iv("dispatch_wave_size", 4))),
            "pricing_km_tiers_json": str(tiers_json),
            "pricing_per_minute_azn": max(
                0.0, _fv("pricing_per_minute_azn", pricing_engine.DEFAULT_PER_MINUTE)
            ),
            "pricing_min_price_azn": max(
                0.0, _fv("pricing_min_price_azn", pricing_engine.DEFAULT_MIN_PRICE)
            ),
            "pricing_long_trip_floor_per_km": max(
                0.0,
                _fv(
                    "pricing_long_trip_floor_per_km",
                    pricing_engine.DEFAULT_LONG_TRIP_LINEAR_CAP_PER_KM,
                ),
            ),
            "pricing_long_trip_km_threshold": max(
                0.0,
                _fv(
                    "pricing_long_trip_km_threshold",
                    pricing_engine.DEFAULT_LONG_TRIP_KM_THRESHOLD,
                ),
            ),
            "pricing_long_trip_post_cap_mult": max(
                1.0,
                _fv(
                    "pricing_long_trip_post_cap_mult",
                    pricing_engine.DEFAULT_LONG_TRIP_POST_CAP_MULT,
                ),
            ),
            "pricing_long_trip_max_wave_mult": max(
                1.0,
                min(
                    2.0,
                    _fv(
                        "pricing_long_trip_max_wave_mult",
                        pricing_engine.DEFAULT_LONG_TRIP_MAX_WAVE_MULT,
                    ),
                ),
            ),
            "pricing_quote_nearby_driver_km": max(
                0.0,
                _fv(
                    "pricing_quote_nearby_driver_km",
                    pricing_engine.DEFAULT_NEARBY_DRIVER_KM,
                ),
            ),
            "pricing_market_ref_high_mult": max(
                1.0,
                min(
                    1.35,
                    _fv(
                        "pricing_market_ref_high_mult",
                        pricing_engine.DEFAULT_MARKET_REF_HIGH_MULT,
                    ),
                ),
            ),
            "pricing_market_ref_low_mult": max(
                0.5,
                min(
                    1.0,
                    _fv(
                        "pricing_market_ref_low_mult",
                        pricing_engine.DEFAULT_MARKET_REF_LOW_MULT,
                    ),
                ),
            ),
            "pricing_market_ref_short_max_km": max(
                0.0,
                min(500.0, _fv("pricing_market_ref_short_max_km", 0.0)),
            ),
            "pricing_market_ref_pkm_short": max(
                0.0,
                min(2.5, _fv("pricing_market_ref_pkm_short", 0.0)),
            ),
            "dispatch_priority_dist_weight": max(
                0.0,
                _fv(
                    "dispatch_priority_dist_weight",
                    pricing_engine.DEFAULT_DISPATCH_DIST_WEIGHT,
                ),
            ),
            "dispatch_min_offer_gap_sec": max(
                0.0, min(120.0, _fv("dispatch_min_offer_gap_sec", 12.0))
            ),
            "dispatch_wave1_share": max(0.05, min(0.55, _fv("dispatch_wave1_share", 0.2))),
            "dispatch_wave2_share": max(0.05, min(0.55, _fv("dispatch_wave2_share", 0.3))),
            "dispatch_tier2_price_surge": max(0.0, min(0.08, _fv("dispatch_tier2_price_surge", 0.03))),
            "dispatch_tier3_extra_price_surge": max(
                0.0, min(0.06, _fv("dispatch_tier3_extra_price_surge", 0.02))
            ),
            "dispatch_decline_penalty_per_streak": max(
                0.0, min(0.25, _fv("dispatch_decline_penalty_per_streak", 0.085))
            ),
            "dispatch_react_fast_sec": max(1.0, min(30.0, _fv("dispatch_react_fast_sec", 5.0))),
            "dispatch_react_slow_sec": max(2.0, min(120.0, _fv("dispatch_react_slow_sec", 15.0))),
            "dispatch_react_fast_bonus": max(0.0, min(0.15, _fv("dispatch_react_fast_bonus", 0.042))),
            "dispatch_react_slow_penalty": max(0.0, min(0.15, _fv("dispatch_react_slow_penalty", 0.055))),
            "dispatch_far_km_threshold": max(2.0, min(12.0, _fv("dispatch_far_km_threshold", 4.0))),
            "dispatch_far_priority_bonus": max(0.0, min(0.12, _fv("dispatch_far_priority_bonus", 0.035))),
            "dispatch_load_penalty_per_trip": max(
                0.01, min(0.09, _fv("dispatch_load_penalty_per_trip", 0.038))
            ),
            "dispatch_priority_rating_weight": max(
                1.0, min(4.0, _fv("dispatch_priority_rating_weight", 2.85))
            ),
            "dispatch_priority_accept_sq_weight": max(
                1.0, min(4.0, _fv("dispatch_priority_accept_sq_weight", 2.35))
            ),
            "dispatch_idle_long_sec": max(120.0, min(7200.0, _fv("dispatch_idle_long_sec", 600.0))),
            "withdrawal_timeline_pending": (
                vals.get("withdrawal_timeline_pending") or ""
            ).strip()
            or WITHDRAWAL_TIMELINE_DEFAULTS["pending"],
            "withdrawal_timeline_processing": (
                vals.get("withdrawal_timeline_processing") or ""
            ).strip()
            or WITHDRAWAL_TIMELINE_DEFAULTS["processing"],
            "withdrawal_timeline_completed": (
                vals.get("withdrawal_timeline_completed") or ""
            ).strip()
            or WITHDRAWAL_TIMELINE_DEFAULTS["completed"],
            "withdrawal_timeline_rejected": (
                vals.get("withdrawal_timeline_rejected") or ""
            ).strip()
            or WITHDRAWAL_TIMELINE_DEFAULTS["rejected"],
        }
        try:
            dsc = await self.get_dispatch_scoring_settings()
            out.update(dsc)
        except Exception:
            pass
        return out

    async def ensure_default_withdrawal_timeline_messages(self) -> None:
        for st, text in WITHDRAWAL_TIMELINE_DEFAULTS.items():
            key = f"withdrawal_timeline_{st}"
            await self._execute(
                """
                INSERT INTO app_settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO NOTHING
                """,
                (key, text),
            )

    async def get_withdrawal_timeline_comment(self, status: str) -> str:
        await self.ensure_default_withdrawal_timeline_messages()
        sk = (status or "").strip().lower()
        key = f"withdrawal_timeline_{sk}"
        row = await self._execute(
            "SELECT value FROM app_settings WHERE key = $1",
            (key,),
            fetchone=True,
        )
        if row and row.get("value") is not None:
            s = str(row["value"]).strip()
            if s:
                return s
        return WITHDRAWAL_TIMELINE_DEFAULTS.get(sk, "")

    async def admin_set_withdrawal_timeline_messages(
        self,
        *,
        pending: str,
        processing: str,
        completed: str,
        rejected: str,
    ) -> None:
        pairs = (
            ("withdrawal_timeline_pending", pending.strip()),
            ("withdrawal_timeline_processing", processing.strip()),
            ("withdrawal_timeline_completed", completed.strip()),
            ("withdrawal_timeline_rejected", rejected.strip()),
        )
        for key, val in pairs:
            await self._execute(
                """
                INSERT INTO app_settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (key, val),
            )
        self.invalidate_app_settings_caches()

    async def admin_set_project_settings(
        self,
        *,
        price_per_km: Optional[float] = None,
        trip_base_fee: Optional[float] = None,
        dispatch_wave_timeout_sec: Optional[int] = None,
        dispatch_wave_size: Optional[int] = None,
        pricing_km_tiers_json: Optional[str] = None,
        pricing_per_minute_azn: Optional[float] = None,
        pricing_min_price_azn: Optional[float] = None,
        pricing_long_trip_floor_per_km: Optional[float] = None,
        pricing_long_trip_km_threshold: Optional[float] = None,
        pricing_long_trip_post_cap_mult: Optional[float] = None,
        pricing_long_trip_max_wave_mult: Optional[float] = None,
        pricing_quote_nearby_driver_km: Optional[float] = None,
        pricing_market_ref_high_mult: Optional[float] = None,
        pricing_market_ref_low_mult: Optional[float] = None,
        pricing_market_ref_short_max_km: Optional[float] = None,
        pricing_market_ref_pkm_short: Optional[float] = None,
        dispatch_priority_dist_weight: Optional[float] = None,
        dispatch_min_offer_gap_sec: Optional[float] = None,
        dispatch_wave1_share: Optional[float] = None,
        dispatch_wave2_share: Optional[float] = None,
        dispatch_tier2_price_surge: Optional[float] = None,
        dispatch_tier3_extra_price_surge: Optional[float] = None,
        dispatch_decline_penalty_per_streak: Optional[float] = None,
        dispatch_react_fast_sec: Optional[float] = None,
        dispatch_react_slow_sec: Optional[float] = None,
        dispatch_react_fast_bonus: Optional[float] = None,
        dispatch_react_slow_penalty: Optional[float] = None,
        dispatch_far_km_threshold: Optional[float] = None,
        dispatch_far_priority_bonus: Optional[float] = None,
        dispatch_load_penalty_per_trip: Optional[float] = None,
        dispatch_priority_rating_weight: Optional[float] = None,
        dispatch_priority_accept_sq_weight: Optional[float] = None,
        dispatch_idle_long_sec: Optional[float] = None,
        dispatch_decline_penalty_scale: Optional[float] = None,
        dispatch_time_surge_at_15: Optional[float] = None,
        dispatch_time_surge_at_30: Optional[float] = None,
        dispatch_time_surge_at_45: Optional[float] = None,
        dispatch_time_surge_pct_15: Optional[float] = None,
        dispatch_time_surge_pct_30: Optional[float] = None,
        dispatch_time_surge_pct_45: Optional[float] = None,
        dispatch_time_surge_total_cap: Optional[float] = None,
        dispatch_solo_min_accept: Optional[float] = None,
        dispatch_solo_min_rating: Optional[float] = None,
        dispatch_near_good_km: Optional[float] = None,
        dispatch_near_good_min_accept: Optional[float] = None,
        dispatch_near_good_min_rating: Optional[float] = None,
        dispatch_wave_max_pick_km: Optional[float] = None,
        dispatch_trip_repeat_cooldown_sec: Optional[float] = None,
        dispatch_distw_auto: Optional[float] = None,
        dispatch_distw_density_low_n: Optional[float] = None,
        dispatch_distw_density_high_n: Optional[float] = None,
        dispatch_distw_sparse: Optional[float] = None,
        dispatch_distw_dense: Optional[float] = None,
        dispatch_score_dist_ref_km: Optional[float] = None,
        dispatch_score_load_ref_trips: Optional[float] = None,
        dispatch_idle_score_weight: Optional[float] = None,
        dispatch_stability_bonus_max: Optional[float] = None,
        dispatch_stability_var_threshold: Optional[float] = None,
        dispatch_client_slow_hint_sec: Optional[float] = None,
        dispatch_client_boost_pct: Optional[float] = None,
        dispatch_client_boost_price_mult: Optional[float] = None,
        dispatch_wave1_min_size: Optional[float] = None,
    ) -> None:
        if price_per_km is not None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('price_per_km', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(max(0.0, float(price_per_km))),),
            )
        if trip_base_fee is not None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('trip_base_fee', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(max(0.0, float(trip_base_fee))),),
            )
        if dispatch_wave_timeout_sec is not None:
            v = max(3, min(int(float(dispatch_wave_timeout_sec)), 120))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('dispatch_wave_timeout_sec', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if dispatch_wave_size is not None:
            w = max(1, min(int(float(dispatch_wave_size)), 20))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('dispatch_wave_size', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(w),),
            )
        if pricing_km_tiers_json is not None:
            raw = str(pricing_km_tiers_json).strip()
            pricing_engine.parse_km_tiers_json(raw)
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_km_tiers_json', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (raw,),
            )
        if pricing_per_minute_azn is not None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_per_minute_azn', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(max(0.0, float(pricing_per_minute_azn))),),
            )
        if pricing_min_price_azn is not None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_min_price_azn', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(max(0.0, float(pricing_min_price_azn))),),
            )
        if pricing_long_trip_floor_per_km is not None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_long_trip_floor_per_km', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(max(0.0, float(pricing_long_trip_floor_per_km))),),
            )
        if pricing_long_trip_km_threshold is not None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_long_trip_km_threshold', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(max(0.0, float(pricing_long_trip_km_threshold))),),
            )
        if pricing_long_trip_post_cap_mult is not None:
            v = max(1.0, float(pricing_long_trip_post_cap_mult))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_long_trip_post_cap_mult', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if pricing_long_trip_max_wave_mult is not None:
            v = max(1.0, min(2.0, float(pricing_long_trip_max_wave_mult)))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_long_trip_max_wave_mult', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if pricing_quote_nearby_driver_km is not None:
            v = max(0.0, float(pricing_quote_nearby_driver_km))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_quote_nearby_driver_km', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if pricing_market_ref_high_mult is not None:
            v = max(1.0, min(1.35, float(pricing_market_ref_high_mult)))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_market_ref_high_mult', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if pricing_market_ref_low_mult is not None:
            v = max(0.5, min(1.0, float(pricing_market_ref_low_mult)))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_market_ref_low_mult', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if pricing_market_ref_short_max_km is not None:
            v = max(0.0, min(500.0, float(pricing_market_ref_short_max_km)))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_market_ref_short_max_km', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if pricing_market_ref_pkm_short is not None:
            v = max(0.0, min(2.5, float(pricing_market_ref_pkm_short)))
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('pricing_market_ref_pkm_short', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(v),),
            )
        if dispatch_priority_dist_weight is not None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES ('dispatch_priority_dist_weight', $1)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(max(0.0, min(0.35, float(dispatch_priority_dist_weight)))),),
            )

        async def _ups_f(key: str, val: float) -> None:
            await self._execute(
                """
                INSERT INTO app_settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (key, str(val)),
            )

        if dispatch_min_offer_gap_sec is not None:
            await _ups_f(
                "dispatch_min_offer_gap_sec",
                max(0.0, min(120.0, float(dispatch_min_offer_gap_sec))),
            )
        if dispatch_wave1_share is not None:
            await _ups_f(
                "dispatch_wave1_share",
                max(0.05, min(0.55, float(dispatch_wave1_share))),
            )
        if dispatch_wave2_share is not None:
            await _ups_f(
                "dispatch_wave2_share",
                max(0.05, min(0.55, float(dispatch_wave2_share))),
            )
        if dispatch_tier2_price_surge is not None:
            await _ups_f(
                "dispatch_tier2_price_surge",
                max(0.0, min(0.08, float(dispatch_tier2_price_surge))),
            )
        if dispatch_tier3_extra_price_surge is not None:
            await _ups_f(
                "dispatch_tier3_extra_price_surge",
                max(0.0, min(0.06, float(dispatch_tier3_extra_price_surge))),
            )
        if dispatch_decline_penalty_per_streak is not None:
            await _ups_f(
                "dispatch_decline_penalty_per_streak",
                max(0.0, min(0.25, float(dispatch_decline_penalty_per_streak))),
            )
        if dispatch_react_fast_sec is not None:
            await _ups_f(
                "dispatch_react_fast_sec",
                max(1.0, min(30.0, float(dispatch_react_fast_sec))),
            )
        if dispatch_react_slow_sec is not None:
            await _ups_f(
                "dispatch_react_slow_sec",
                max(2.0, min(120.0, float(dispatch_react_slow_sec))),
            )
        if dispatch_react_fast_bonus is not None:
            await _ups_f(
                "dispatch_react_fast_bonus",
                max(0.0, min(0.15, float(dispatch_react_fast_bonus))),
            )
        if dispatch_react_slow_penalty is not None:
            await _ups_f(
                "dispatch_react_slow_penalty",
                max(0.0, min(0.15, float(dispatch_react_slow_penalty))),
            )
        if dispatch_far_km_threshold is not None:
            await _ups_f(
                "dispatch_far_km_threshold",
                max(2.0, min(12.0, float(dispatch_far_km_threshold))),
            )
        if dispatch_far_priority_bonus is not None:
            await _ups_f(
                "dispatch_far_priority_bonus",
                max(0.0, min(0.12, float(dispatch_far_priority_bonus))),
            )
        if dispatch_load_penalty_per_trip is not None:
            await _ups_f(
                "dispatch_load_penalty_per_trip",
                max(0.01, min(0.09, float(dispatch_load_penalty_per_trip))),
            )
        if dispatch_priority_rating_weight is not None:
            await _ups_f(
                "dispatch_priority_rating_weight",
                max(1.0, min(4.0, float(dispatch_priority_rating_weight))),
            )
        if dispatch_priority_accept_sq_weight is not None:
            await _ups_f(
                "dispatch_priority_accept_sq_weight",
                max(1.0, min(4.0, float(dispatch_priority_accept_sq_weight))),
            )
        if dispatch_idle_long_sec is not None:
            await _ups_f(
                "dispatch_idle_long_sec",
                max(120.0, min(7200.0, float(dispatch_idle_long_sec))),
            )
        patch_map = {
            "dispatch_decline_penalty_scale": dispatch_decline_penalty_scale,
            "dispatch_time_surge_at_15": dispatch_time_surge_at_15,
            "dispatch_time_surge_at_30": dispatch_time_surge_at_30,
            "dispatch_time_surge_at_45": dispatch_time_surge_at_45,
            "dispatch_time_surge_pct_15": dispatch_time_surge_pct_15,
            "dispatch_time_surge_pct_30": dispatch_time_surge_pct_30,
            "dispatch_time_surge_pct_45": dispatch_time_surge_pct_45,
            "dispatch_time_surge_total_cap": dispatch_time_surge_total_cap,
            "dispatch_solo_min_accept": dispatch_solo_min_accept,
            "dispatch_solo_min_rating": dispatch_solo_min_rating,
            "dispatch_near_good_km": dispatch_near_good_km,
            "dispatch_near_good_min_accept": dispatch_near_good_min_accept,
            "dispatch_near_good_min_rating": dispatch_near_good_min_rating,
            "dispatch_wave_max_pick_km": dispatch_wave_max_pick_km,
            "dispatch_trip_repeat_cooldown_sec": dispatch_trip_repeat_cooldown_sec,
            "dispatch_distw_auto": dispatch_distw_auto,
            "dispatch_distw_density_low_n": dispatch_distw_density_low_n,
            "dispatch_distw_density_high_n": dispatch_distw_density_high_n,
            "dispatch_distw_sparse": dispatch_distw_sparse,
            "dispatch_distw_dense": dispatch_distw_dense,
            "dispatch_score_dist_ref_km": dispatch_score_dist_ref_km,
            "dispatch_score_load_ref_trips": dispatch_score_load_ref_trips,
            "dispatch_idle_score_weight": dispatch_idle_score_weight,
            "dispatch_stability_bonus_max": dispatch_stability_bonus_max,
            "dispatch_stability_var_threshold": dispatch_stability_var_threshold,
            "dispatch_client_slow_hint_sec": dispatch_client_slow_hint_sec,
            "dispatch_client_boost_pct": dispatch_client_boost_pct,
            "dispatch_client_boost_price_mult": dispatch_client_boost_price_mult,
            "dispatch_wave1_min_size": dispatch_wave1_min_size,
        }
        if any(v is not None for v in patch_map.values()):
            before = dict(await self.get_dispatch_scoring_settings())
            merged = dict(before)
            for k, rv in patch_map.items():
                if rv is not None:
                    merged[k] = float(rv)
            merged = self._clamp_dispatch_scoring_dict(merged)
            for k, v in merged.items():
                if k not in before or float(before[k]) != float(v):
                    await _ups_f(k, float(v))
        self.invalidate_app_settings_caches()

    @staticmethod
    def _clamp_dispatch_scoring_dict(out: Dict[str, float]) -> Dict[str, float]:
        """Те же ограничения, что в get_dispatch_scoring_settings (для PATCH из админки)."""
        out["dispatch_priority_dist_weight"] = max(
            0.0, min(0.35, float(out["dispatch_priority_dist_weight"]))
        )
        out["dispatch_min_offer_gap_sec"] = max(0.0, min(120.0, float(out["dispatch_min_offer_gap_sec"])))
        out["dispatch_wave1_share"] = max(0.05, min(0.55, float(out["dispatch_wave1_share"])))
        out["dispatch_wave2_share"] = max(0.05, min(0.55, float(out["dispatch_wave2_share"])))
        out["dispatch_tier2_price_surge"] = max(0.0, min(0.08, float(out["dispatch_tier2_price_surge"])))
        out["dispatch_tier3_extra_price_surge"] = max(0.0, min(0.06, float(out["dispatch_tier3_extra_price_surge"])))
        out["dispatch_decline_penalty_per_streak"] = max(
            0.0, min(0.25, float(out["dispatch_decline_penalty_per_streak"]))
        )
        out["dispatch_react_fast_sec"] = max(1.0, min(30.0, float(out["dispatch_react_fast_sec"])))
        out["dispatch_react_slow_sec"] = max(
            float(out["dispatch_react_fast_sec"]) + 1.0,
            min(120.0, float(out["dispatch_react_slow_sec"])),
        )
        out["dispatch_react_fast_bonus"] = max(0.0, min(0.15, float(out["dispatch_react_fast_bonus"])))
        out["dispatch_react_slow_penalty"] = max(0.0, min(0.15, float(out["dispatch_react_slow_penalty"])))
        out["dispatch_far_km_threshold"] = max(2.0, min(12.0, float(out["dispatch_far_km_threshold"])))
        out["dispatch_far_priority_bonus"] = max(0.0, min(0.12, float(out["dispatch_far_priority_bonus"])))
        out["dispatch_load_penalty_per_trip"] = max(0.01, min(0.09, float(out["dispatch_load_penalty_per_trip"])))
        out["dispatch_priority_rating_weight"] = max(1.0, min(4.0, float(out["dispatch_priority_rating_weight"])))
        out["dispatch_priority_accept_sq_weight"] = max(
            1.0, min(4.0, float(out["dispatch_priority_accept_sq_weight"]))
        )
        out["dispatch_idle_long_sec"] = max(120.0, min(7200.0, float(out["dispatch_idle_long_sec"])))
        out["dispatch_decline_penalty_scale"] = max(
            0.0, min(0.25, float(out.get("dispatch_decline_penalty_scale", out["dispatch_decline_penalty_per_streak"])))
        )
        out["dispatch_time_surge_at_15"] = max(5.0, min(120.0, float(out["dispatch_time_surge_at_15"])))
        out["dispatch_time_surge_at_30"] = max(
            float(out["dispatch_time_surge_at_15"]) + 1.0,
            min(180.0, float(out["dispatch_time_surge_at_30"])),
        )
        out["dispatch_time_surge_at_45"] = max(
            float(out["dispatch_time_surge_at_30"]) + 1.0,
            min(300.0, float(out["dispatch_time_surge_at_45"])),
        )
        for _k in ("dispatch_time_surge_pct_15", "dispatch_time_surge_pct_30", "dispatch_time_surge_pct_45"):
            out[_k] = max(0.0, min(0.04, float(out[_k])))
        out["dispatch_time_surge_total_cap"] = max(0.0, min(0.12, float(out["dispatch_time_surge_total_cap"])))
        out["dispatch_solo_min_accept"] = max(0.35, min(0.95, float(out["dispatch_solo_min_accept"])))
        out["dispatch_solo_min_rating"] = max(3.0, min(5.0, float(out["dispatch_solo_min_rating"])))
        out["dispatch_near_good_km"] = max(0.3, min(2.0, float(out["dispatch_near_good_km"])))
        out["dispatch_near_good_min_accept"] = max(0.35, min(0.95, float(out["dispatch_near_good_min_accept"])))
        out["dispatch_near_good_min_rating"] = max(3.0, min(5.0, float(out["dispatch_near_good_min_rating"])))
        out["dispatch_wave_max_pick_km"] = max(1.2, min(6.0, float(out["dispatch_wave_max_pick_km"])))
        out["dispatch_trip_repeat_cooldown_sec"] = max(15.0, min(120.0, float(out["dispatch_trip_repeat_cooldown_sec"])))
        out["dispatch_distw_auto"] = max(0.0, min(1.0, float(out["dispatch_distw_auto"])))
        out["dispatch_distw_density_low_n"] = max(2.0, min(20.0, float(out["dispatch_distw_density_low_n"])))
        out["dispatch_distw_density_high_n"] = max(
            float(out["dispatch_distw_density_low_n"]) + 1.0,
            min(40.0, float(out["dispatch_distw_density_high_n"])),
        )
        out["dispatch_distw_sparse"] = max(0.1, min(0.3, float(out["dispatch_distw_sparse"])))
        out["dispatch_distw_dense"] = max(0.1, min(0.3, float(out["dispatch_distw_dense"])))
        out["dispatch_score_dist_ref_km"] = max(0.8, min(8.0, float(out["dispatch_score_dist_ref_km"])))
        out["dispatch_score_load_ref_trips"] = max(2.0, min(24.0, float(out["dispatch_score_load_ref_trips"])))
        out["dispatch_idle_score_weight"] = max(0.1, min(1.2, float(out["dispatch_idle_score_weight"])))
        out["dispatch_stability_bonus_max"] = max(0.0, min(0.12, float(out["dispatch_stability_bonus_max"])))
        out["dispatch_stability_var_threshold"] = max(0.02, min(0.35, float(out["dispatch_stability_var_threshold"])))
        out["dispatch_client_slow_hint_sec"] = max(25.0, min(120.0, float(out["dispatch_client_slow_hint_sec"])))
        out["dispatch_client_boost_pct"] = max(0.01, min(0.08, float(out["dispatch_client_boost_pct"])))
        out["dispatch_client_boost_price_mult"] = max(1.0, min(1.12, float(out["dispatch_client_boost_price_mult"])))
        out["dispatch_wave1_min_size"] = max(1.0, min(4.0, float(out["dispatch_wave1_min_size"])))
        return out

    async def get_dispatch_wave_timeout_sec(self) -> int:
        if self._dispatch_settings_cache is not None:
            return int(self._dispatch_settings_cache["timeout_sec"])
        await self._ensure_dispatch_settings_cache()
        return int(self._dispatch_settings_cache["timeout_sec"])

    async def get_dispatch_wave_size(self) -> int:
        if self._dispatch_settings_cache is not None:
            return int(self._dispatch_settings_cache["wave_size"])
        await self._ensure_dispatch_settings_cache()
        return int(self._dispatch_settings_cache["wave_size"])

    async def _ensure_dispatch_settings_cache(self) -> None:
        if self._dispatch_settings_cache is not None:
            return
        timeout = 12
        wave_size = 4
        try:
            rows = await self._execute(
                """
                SELECT key, value FROM app_settings
                WHERE key IN ('dispatch_wave_timeout_sec', 'dispatch_wave_size')
                """,
                (),
                fetchall=True,
            )
            for r in rows or []:
                k = str(r.get("key") or "")
                v = (r.get("value") or "").strip()
                if not v:
                    continue
                try:
                    if k == "dispatch_wave_timeout_sec":
                        timeout = int(float(v))
                    elif k == "dispatch_wave_size":
                        wave_size = int(float(v))
                except (TypeError, ValueError):
                    continue
        except Exception:
            pass
        timeout = max(3, min(timeout, 120))
        wave_size = max(1, min(wave_size, 20))
        self._dispatch_settings_cache = {"timeout_sec": timeout, "wave_size": wave_size}

    async def get_dispatch_scoring_settings(self) -> Dict[str, float]:
        """Параметры скоринга волн / SOLO / анти-спама из app_settings."""
        await self.ensure_default_pricing_app_settings()
        keys = (
            "dispatch_priority_dist_weight",
            "dispatch_min_offer_gap_sec",
            "dispatch_wave1_share",
            "dispatch_wave2_share",
            "dispatch_tier2_price_surge",
            "dispatch_tier3_extra_price_surge",
            "dispatch_decline_penalty_per_streak",
            "dispatch_react_fast_sec",
            "dispatch_react_slow_sec",
            "dispatch_react_fast_bonus",
            "dispatch_react_slow_penalty",
            "dispatch_far_km_threshold",
            "dispatch_far_priority_bonus",
            "dispatch_load_penalty_per_trip",
            "dispatch_priority_rating_weight",
            "dispatch_priority_accept_sq_weight",
            "dispatch_idle_long_sec",
            "dispatch_decline_penalty_scale",
            "dispatch_time_surge_at_15",
            "dispatch_time_surge_at_30",
            "dispatch_time_surge_at_45",
            "dispatch_time_surge_pct_15",
            "dispatch_time_surge_pct_30",
            "dispatch_time_surge_pct_45",
            "dispatch_time_surge_total_cap",
            "dispatch_solo_min_accept",
            "dispatch_solo_min_rating",
            "dispatch_near_good_km",
            "dispatch_near_good_min_accept",
            "dispatch_near_good_min_rating",
            "dispatch_wave_max_pick_km",
            "dispatch_trip_repeat_cooldown_sec",
            "dispatch_distw_auto",
            "dispatch_distw_density_low_n",
            "dispatch_distw_density_high_n",
            "dispatch_distw_sparse",
            "dispatch_distw_dense",
            "dispatch_score_dist_ref_km",
            "dispatch_score_load_ref_trips",
            "dispatch_idle_score_weight",
            "dispatch_stability_bonus_max",
            "dispatch_stability_var_threshold",
            "dispatch_client_slow_hint_sec",
            "dispatch_client_boost_pct",
            "dispatch_client_boost_price_mult",
            "dispatch_wave1_min_size",
        )
        defaults = {
            "dispatch_priority_dist_weight": 0.18,
            "dispatch_min_offer_gap_sec": 12.0,
            "dispatch_wave1_share": 0.2,
            "dispatch_wave2_share": 0.3,
            "dispatch_tier2_price_surge": 0.03,
            "dispatch_tier3_extra_price_surge": 0.02,
            "dispatch_decline_penalty_per_streak": 0.085,
            "dispatch_react_fast_sec": 5.0,
            "dispatch_react_slow_sec": 15.0,
            "dispatch_react_fast_bonus": 0.042,
            "dispatch_react_slow_penalty": 0.055,
            "dispatch_far_km_threshold": 4.0,
            "dispatch_far_priority_bonus": 0.035,
            "dispatch_load_penalty_per_trip": 0.038,
            "dispatch_priority_rating_weight": 2.85,
            "dispatch_priority_accept_sq_weight": 2.35,
            "dispatch_idle_long_sec": 600.0,
            "dispatch_decline_penalty_scale": 0.085,
            "dispatch_time_surge_at_15": 15.0,
            "dispatch_time_surge_at_30": 30.0,
            "dispatch_time_surge_at_45": 45.0,
            "dispatch_time_surge_pct_15": 0.015,
            "dispatch_time_surge_pct_30": 0.015,
            "dispatch_time_surge_pct_45": 0.015,
            "dispatch_time_surge_total_cap": 0.075,
            "dispatch_solo_min_accept": 0.70,
            "dispatch_solo_min_rating": 4.0,
            "dispatch_near_good_km": 0.7,
            "dispatch_near_good_min_accept": 0.60,
            "dispatch_near_good_min_rating": 4.0,
            "dispatch_wave_max_pick_km": 2.5,
            "dispatch_trip_repeat_cooldown_sec": 45.0,
            "dispatch_distw_auto": 1.0,
            "dispatch_distw_density_low_n": 5.0,
            "dispatch_distw_density_high_n": 16.0,
            "dispatch_distw_sparse": 0.135,
            "dispatch_distw_dense": 0.22,
            "dispatch_score_dist_ref_km": 4.0,
            "dispatch_score_load_ref_trips": 8.0,
            "dispatch_idle_score_weight": 0.55,
            "dispatch_stability_bonus_max": 0.042,
            "dispatch_stability_var_threshold": 0.085,
            "dispatch_client_slow_hint_sec": 50.0,
            "dispatch_client_boost_pct": 0.04,
            "dispatch_client_boost_price_mult": 1.04,
            "dispatch_wave1_min_size": 2.0,
        }
        rows = await self._execute(
            "SELECT key, value FROM app_settings WHERE key = ANY($1::text[])",
            (list(keys),),
            fetchall=True,
        )
        vals: Dict[str, str] = {
            str(r["key"]): (r.get("value") or "").strip() for r in (rows or [])
        }
        out: Dict[str, float] = {}
        for k, dflt in defaults.items():
            raw = vals.get(k)
            try:
                v = float(raw) if raw not in (None, "") else dflt
            except (TypeError, ValueError):
                v = dflt
            if math.isnan(v) or math.isinf(v):
                v = dflt
            out[k] = v
        return self._clamp_dispatch_scoring_dict(out)

    # ---------------------
    # ПОЕЗДКИ
    # ---------------------
    async def add_trip(self, client_id: int, start_lat: float, start_lon: float, end_lat: Optional[float] = None,
        end_lon: Optional[float] = None, distance_km: Optional[float] = None, requested_at: Optional[datetime] = None,
        price: Optional[float] = None, client_name: Optional[str] = None, client_rating: Optional[float] = None,
        start_address: Optional[str] = None, end_address: Optional[str] = None,
        driving_time: Optional[str] = None, route_duration_minutes: Optional[int] = None) -> Optional[int]:

        """Добавление новой поездки. Если distance_km и price не указаны, они будут рассчитаны автоматически."""
        
        try:
            if requested_at is None: 
                requested_at = datetime.now()
            if price is None and distance_km is not None:
                try:
                    dm = int(route_duration_minutes) if route_duration_minutes is not None else 0
                except (TypeError, ValueError):
                    dm = 0
                price = await self.compute_trip_price_azn(
                    distance_km, float(dm), wave=1, demand_coef=None
                )
            elif price is None:
                price = 0.0
            try:
                rdm = int(route_duration_minutes) if route_duration_minutes is not None else None
            except (TypeError, ValueError):
                rdm = None
                
            result = await self._execute(
                """
                INSERT INTO trips(client_id, start_lat, start_lon, end_lat, end_lon, distance_km, requested_at, price, client_name, client_rating, start_address, end_address, driving_time, route_duration_minutes)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING trip_id
                """,
                (client_id, start_lat, start_lon, end_lat, end_lon, distance_km, requested_at, price, client_name, client_rating, start_address, end_address, driving_time, rdm), fetchone=True)
            
            if result: 
                return result["trip_id"]
            return None
        
        except Exception as e:
            await log("[!]", f"Не удалось добавить поездку для клиента {client_id}: {e}")
            return None

    async def set_trip_offered_drivers(self, trip_id: int, driver_ids: Optional[List[int]]):
        """Список водителей, которым показан заказ (matchmaking). NULL = видят все доступные (fallback)."""
        if driver_ids is None:
            await self._execute(
                "UPDATE trips SET offer_driver_ids = NULL WHERE trip_id = $1",
                (trip_id,),
            )
        else:
            await self._execute(
                "UPDATE trips SET offer_driver_ids = $1::integer[] WHERE trip_id = $2",
                (driver_ids, trip_id),
            )

    async def start_trip_offer_wave(
        self,
        trip_id: int,
        wave: int,
        radius_km: float,
        offer_driver_ids: Optional[List[int]],
        seen_union: List[int],
        offer_expires_at: datetime,
        *,
        dispatch_quality_tier: int = 1,
        dispatch_solo_driver_id: Optional[int] = None,
    ) -> None:
        """pending|offered → offered, волна диспетчеризации."""
        row = await self._execute(
            "SELECT dispatch_seen_driver_ids FROM trips WHERE trip_id = $1",
            (trip_id,),
            fetchone=True,
        )
        prev = list(row["dispatch_seen_driver_ids"] or []) if row else []
        merged_seen = list({*prev, *seen_union})
        qt = max(1, min(3, int(dispatch_quality_tier)))
        solo = int(dispatch_solo_driver_id) if dispatch_solo_driver_id is not None else None

        await self._execute(
            """
            UPDATE trips SET
                status = 'offered',
                dispatch_wave = $2,
                dispatch_radius_km = $3,
                offer_driver_ids = $4::integer[],
                dispatch_seen_driver_ids = $5::integer[],
                offer_expires_at = $6,
                dispatch_quality_tier = $7,
                dispatch_solo_driver_id = $8,
                revision = COALESCE(revision, 1) + 1
            WHERE trip_id = $1 AND status IN ('pending', 'offered') AND driver_id IS NULL
            """,
            (
                trip_id,
                wave,
                radius_km,
                offer_driver_ids or [],
                merged_seen,
                offer_expires_at,
                qt,
                solo,
            ),
        )

    async def try_accept_trip(
        self, trip_id: int, driver_id: int, redis_obj: Optional[Any] = None
    ) -> Optional[Dict]:
        """
        Атомарное назначение водителя (один победитель): UPDATE … RETURNING.
        Используется status='offered' после волны диспетчеризации (не «сырой» pending),
        чтобы не назначить водителя вне списка offer_driver_ids.
        """
        row = await self._execute(
            """
            UPDATE trips SET
                driver_id = $1,
                status = 'accepted',
                state = 'en_route',
                revision = COALESCE(revision, 1) + 1,
                offer_expires_at = NULL
            WHERE trip_id = $2
              AND status = 'offered'
              AND driver_id IS NULL
              AND EXISTS (
                SELECT 1 FROM drivers d
                WHERE d.driver_id = $1
                  AND LOWER(TRIM(COALESCE(NULLIF(d.verification, ''), 'pending'))) = 'verified'
              )
              AND (
                offer_driver_ids IS NULL
                OR cardinality(offer_driver_ids) = 0
                OR $1::bigint = ANY(offer_driver_ids)
              )
            RETURNING *
            """,
            (driver_id, trip_id),
            fetchone=True,
        )
        if row:
            self._accept_stats_cache = None
            self._reference_pkm_cache = None
            await self.adjust_driver_dispatch_coefficient(int(driver_id), 0.02)
            await self.record_driver_offer_accepted(int(driver_id))
            if redis_obj is not None:
                try:
                    from tools import dispatch_redis_metrics as _drm

                    await _drm.decline_reset(redis_obj, int(driver_id))
                    await _drm.accept_record_latency(redis_obj, int(driver_id), int(trip_id))
                except Exception:
                    pass
        return self._convert_decimals_to_floats(row) if row else None

    async def list_offered_trips_past_deadline(self) -> List[Dict]:
        rows = await self._execute(
            """
            SELECT * FROM trips
            WHERE status = 'offered'
              AND driver_id IS NULL
              AND offer_expires_at IS NOT NULL
              AND offer_expires_at < NOW()
            ORDER BY trip_id
            LIMIT 50
            """,
            (),
            fetchall=True,
        )
        return self._convert_decimals_to_floats(rows) if rows else []

    async def get_pending_trips_for_driver(self, driver_id: int) -> List[Dict]:
        """Ожидающие/оффер: pending или offered, водитель в списке или legacy broadcast."""
        drv = await self.get_driver(driver_id)
        if not drv:
            return []
        if (str(drv.get("verification") or "pending")).strip().lower() != "verified":
            return []

        rows = await self._execute(
            """
            SELECT * FROM trips
            WHERE status IN ('pending', 'offered')
              AND driver_id IS NULL
              AND (
                offer_driver_ids IS NULL
                OR cardinality(offer_driver_ids) = 0
                OR $1::bigint = ANY(offer_driver_ids)
              )
            ORDER BY created_at DESC
            """,
            (driver_id,),
            fetchall=True,
        )
        return self._convert_decimals_to_floats(rows) if rows else []

    async def update_trip_status(self, trip_id: int, status: str):
        """Обновление статуса поездки (accepted, busy, pending, completed, cancelled)"""
        await self._execute_update("trips", "trip_id", trip_id, status=status)

    async def update_trip_state(self, trip_id: int, state: str):
        """Обновление trips.state (см. tools.trip_enums.TripLegState, граф tools.trip_fsm).

        pending_confirm → en_route → driver_arrived → onboard → in_progress →
        at_destination → finished; пауза: paused. Терминальные: cancel_*, finished.
        """

        await self._execute_update("trips", "trip_id", trip_id, state=state)

    async def try_update_trip_state(self, trip_id: int, expected_state: str, new_state: str) -> Optional[Dict]:
        """Атомарный переход state: только если текущее = expected_state. Один bump revision."""
        row = await self._execute(
            """
            UPDATE trips SET
                state = $1,
                revision = COALESCE(revision, 1) + 1
            WHERE trip_id = $2 AND state = $3
            RETURNING *
            """,
            (new_state, trip_id, expected_state),
            fetchone=True,
        )
        return self._convert_decimals_to_floats(row) if row else None

    async def update_trip_cancelled_at(self, trip_id: int, cancelled_at: datetime = None):
        """Обновление времени отмены поездки"""
        if cancelled_at is None: cancelled_at = datetime.now()
        await self._execute_update("trips", "trip_id", trip_id, cancelled_at=cancelled_at)

    async def update_trip_accepted_at(self, trip_id: int, accepted_at: datetime = None):
        """Обновление времени подтверждении поездки"""
        if accepted_at is None: accepted_at = datetime.now()
        await self._execute_update("trips", "trip_id", trip_id, accepted_at=accepted_at)

    async def update_trip_started_at(self, trip_id: int, started_at: datetime = None):
        """Обновление времени начали поездки"""
        if started_at is None: started_at = datetime.now()
        await self._execute_update("trips", "trip_id", trip_id, started_at=started_at)

    async def update_trip_completed_at(self, trip_id: int, completed_at: datetime = None):
        """Обновление времени начали поездки"""
        if completed_at is None: completed_at = datetime.now()
        await self._execute_update("trips", "trip_id", trip_id, completed_at=completed_at)
    
    async def update_trip_driver(self, trip_id: int, driver_id: int):
        """Назначение водителя на поездку"""
        await self._execute_update("trips", "trip_id", trip_id, driver_id=driver_id)

    async def complete_trip(self, trip_id: int, end_lat: float, end_lon: float, 
                            distance_km: float, price: float):
        """Завершение поездки: обновляем статус, координаты, дистанцию, цену и время завершения.
        Также обновляем балансы клиента и водителя."""
        _done_driver_id: Optional[int] = None
        try:
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    # Обновляем поездку
                    await conn.execute(
                        """
                        UPDATE trips SET end_lat=$1, end_lon=$2, distance_km=$3, 
                        price=$4, status='completed', completed_at=$5,
                        revision = COALESCE(revision, 1) + 1
                        WHERE trip_id=$6
                        """,
                        end_lat, end_lon, distance_km, price, datetime.now(), trip_id
                    )
                    
                    # Получаем информацию о поездке
                    trip = await conn.fetchrow(
                        "SELECT client_id, driver_id FROM trips WHERE trip_id=$1", 
                        trip_id
                    )
                    
                    if trip:
                        client_id, driver_id = trip['client_id'], trip['driver_id']
                        
                        # Обновляем балансы
                        if client_id:
                            await conn.execute(
                                "UPDATE clients SET balance = balance - $1 WHERE client_id=$2",
                                price, client_id
                            )
                        if driver_id:
                            await conn.execute(
                                "UPDATE drivers SET balance = balance + $1 WHERE driver_id=$2",
                                price, driver_id
                            )
                    
                    await log("[*]", f"Завершена поездка id={trip_id} цена={price}")
                    if trip and trip.get("driver_id"):
                        _done_driver_id = int(trip["driver_id"])
        except Exception as e:
            await log("[!]", f"Ошибка завершения поездки id={trip_id}: {e}")
            raise
        else:
            if _done_driver_id:
                await self.adjust_driver_dispatch_coefficient(_done_driver_id, 0.03)

    async def submit_trip_peer_rating(
        self,
        trip_id: int,
        rater_user_id: int,
        rater_type: str,
        stars: float,
        comment: Optional[str] = None,
        reasons: Optional[list] = None,
    ) -> tuple:
        """rater_type: client | driver. Возвращает (ok, code, trip_dict|None)."""
        try:
            stars_f = float(stars)
        except (TypeError, ValueError):
            return False, "bad_stars", None
        if stars_f < 1 or stars_f > 5:
            return False, "bad_stars", None
        cmt = _pack_trip_rating_comment(rater_type, stars_f, reasons, comment)

        async with self.pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow("SELECT * FROM trips WHERE trip_id=$1", trip_id)
                if not row:
                    return False, "not_found", None
                trip = dict(row)
                st = str(trip.get("state") or "")
                if st != "at_destination":
                    return False, "wrong_trip_state", self._convert_decimals_to_floats(trip)

                cid = trip.get("client_id")
                did = trip.get("driver_id")

                if rater_type == "client":
                    if cid is None or int(cid) != int(rater_user_id):
                        return False, "forbidden", None
                    if trip.get("post_trip_driver_stars") is not None:
                        fr = await conn.fetchrow("SELECT * FROM trips WHERE trip_id=$1", trip_id)
                        return True, "already_rated", self._convert_decimals_to_floats(dict(fr)) if fr else None
                    await conn.execute(
                        """
                        UPDATE trips SET
                            post_trip_driver_stars = $2,
                            post_trip_driver_comment = $3,
                            revision = COALESCE(revision, 1) + 1
                        WHERE trip_id = $1
                        """,
                        trip_id,
                        stars_f,
                        cmt,
                    )
                elif rater_type == "driver":
                    if did is None or int(did) != int(rater_user_id):
                        return False, "forbidden", None
                    if trip.get("post_trip_client_stars") is not None:
                        fr = await conn.fetchrow("SELECT * FROM trips WHERE trip_id=$1", trip_id)
                        return True, "already_rated", self._convert_decimals_to_floats(dict(fr)) if fr else None
                    await conn.execute(
                        """
                        UPDATE trips SET
                            post_trip_client_stars = $2,
                            post_trip_client_comment = $3,
                            revision = COALESCE(revision, 1) + 1
                        WHERE trip_id = $1
                        """,
                        trip_id,
                        stars_f,
                        cmt,
                    )
                else:
                    return False, "bad_rater_type", None

                fresh = await conn.fetchrow("SELECT * FROM trips WHERE trip_id=$1", trip_id)
                return True, "ok", self._convert_decimals_to_floats(dict(fresh)) if fresh else None

    async def apply_peer_aggregate_rating_roll(
        self, rated_role: str, rated_user_id: int, stars: float
    ) -> None:
        """
        Сдвиг агрегированного рейтинга водителя/клиента после поездки.
        Вызывается с задержкой (например 2 мин), чтобы «отзыв доходил» не мгновенно.
        """
        role = (rated_role or "").strip().lower()
        uid = int(rated_user_id)
        stars_f = float(stars)
        if stars_f < 1 or stars_f > 5:
            return
        if role == "driver":
            await self._execute(
                """
                UPDATE drivers SET rating = ROUND(
                    LEAST(5::numeric, GREATEST(1::numeric,
                        COALESCE(rating, 4.5::numeric) * 0.85 + ($1::numeric) * 0.15
                    )), 2
                )
                WHERE driver_id = $2
                """,
                (stars_f, uid),
            )
        elif role == "client":
            await self._execute(
                """
                UPDATE clients SET rating = ROUND(
                    LEAST(5::numeric, GREATEST(1::numeric,
                        COALESCE(rating, 4.5::numeric) * 0.85 + ($1::numeric) * 0.15
                    )), 2
                )
                WHERE client_id = $2
                """,
                (stars_f, uid),
            )

    async def get_trips(self, trip_id: Optional[int] = None, client_id: int = None, driver_id: int = None,
        all_pending_trips: bool = False, all_client_trips: bool = False, all_driver_trips: bool = False,
        driver_busy_trip: bool = False, client_busy_trip: bool = False) -> Optional[Dict]:
        
        
        if all_pending_trips: 
            pending_trips = await self._execute_get_all("trips", "status", "pending")
            if pending_trips: 
                return self._convert_decimals_to_floats(pending_trips)
            return []

        if all_client_trips and client_id is not None:
            lim = int(PROFILE_TRIP_HISTORY_LIMIT)
            client_trips = await self._execute(
                f"""
                SELECT
                    t.*,
                    TRIM(CONCAT_WS(' ', d.surname, d.name)) AS driver_name,
                    d.car_name AS car_name,
                    d.car_number AS car_number,
                    d.rating AS driver_rating
                FROM trips t
                LEFT JOIN drivers d ON d.driver_id = t.driver_id
                WHERE t.client_id = $1
                ORDER BY t.created_at DESC
                LIMIT {lim}
                """,
                (client_id,),
                fetchall=True,
            )
            if client_trips:
                return self._convert_decimals_to_floats(client_trips)
            return []

        if all_driver_trips and driver_id is not None:
            lim = int(PROFILE_TRIP_HISTORY_LIMIT)
            driver_trips = await self._execute(
                f"""
                SELECT
                    t.*,
                    TRIM(CONCAT_WS(' ', c.surname, c.name)) AS client_profile_name,
                    c.rating AS client_live_rating
                FROM trips t
                LEFT JOIN clients c ON c.client_id = t.client_id
                WHERE t.driver_id = $1
                ORDER BY t.created_at DESC
                LIMIT {lim}
                """,
                (driver_id,),
                fetchall=True,
            )
            if driver_trips:
                return self._convert_decimals_to_floats(driver_trips)
            return []

        if trip_id:
            trips = await self._execute_get("trips", "trip_id", trip_id)
            if trips: 
                return self._convert_decimals_to_floats(trips)
            
        if driver_busy_trip and driver_id is not None:
            driver_trip = await self._execute(
                """
                SELECT * FROM trips
                WHERE driver_id=$1 AND status = ANY($2::text[])
                ORDER BY created_at DESC LIMIT 1
                """,
                (driver_id, ["busy", "accepted"]), fetchone=True
            )

            if driver_trip:
                return self._convert_decimals_to_floats(driver_trip)

            return None

        if client_busy_trip and client_id is not None:
            client_trip = await self._execute(
                """
                SELECT * FROM trips
                WHERE client_id=$1 AND status = ANY($2::text[])
                ORDER BY created_at DESC LIMIT 1
                """,
                (client_id, ["busy", "accepted"]), fetchone=True
            )

            if client_trip:
                return self._convert_decimals_to_floats(client_trip)

            return None

        return None

    async def get_active_trip_for_restore(self, user_type: str, user_id: int) -> Optional[Dict]:
        """
        Активная поездка для восстановления UI после перезагрузки.
        Клиент: pending / offered / accepted / busy.
        Водитель: accepted / busy или последний offered, где водитель в offer_driver_ids.
        """
        uid = int(user_id)
        if user_type == "driver":
            row = await self._execute(
                """
                SELECT * FROM trips
                WHERE driver_id = $1 AND status IN ('accepted', 'busy')
                ORDER BY created_at DESC LIMIT 1
                """,
                (uid,),
                fetchone=True,
            )
            if row:
                return self._convert_decimals_to_floats(row)
            row = await self._execute(
                """
                SELECT * FROM trips
                WHERE status = 'offered' AND driver_id IS NULL
                  AND (
                    offer_driver_ids IS NULL
                    OR cardinality(offer_driver_ids) = 0
                    OR $1::bigint = ANY(offer_driver_ids)
                  )
                ORDER BY offer_expires_at DESC NULLS LAST, created_at DESC
                LIMIT 1
                """,
                (uid,),
                fetchone=True,
            )
            return self._convert_decimals_to_floats(row) if row else None
        if user_type == "client":
            row = await self._execute(
                """
                SELECT * FROM trips
                WHERE client_id = $1
                  AND status IN ('pending', 'offered', 'accepted', 'busy')
                ORDER BY created_at DESC LIMIT 1
                """,
                (uid,),
                fetchone=True,
            )
            return self._convert_decimals_to_floats(row) if row else None
        return None

    # ---------------------
    # ТАРИФЫ
    # ---------------------
    async def add_fare(self, car_category: str, price_per_km: float) -> Optional[int]:
        try:
            result = await self._execute(
                "INSERT INTO fares(car_category, price_per_km) VALUES ($1, $2) RETURNING fare_id",
                (car_category, price_per_km),
                fetchone=True
            )
            if result:
                await log("[+]", f"Добавлен тариф {car_category} {price_per_km} за км")
                return result["fare_id"]
            return None
        except Exception as e:
            await log("[!]", f"Не удалось добавить тариф {car_category}: {e}")
            return None

    async def update_fare(self, fare_id: int, **kwargs):
        await self._execute_update("fares", "fare_id", fare_id, **kwargs)

    async def delete_fare(self, fare_id: int):
        await self._execute_delete("fares", "fare_id", fare_id)

    async def get_fare(self, fare_id: int) -> Optional[Dict]:
        fare = await self._execute_get("fares", "fare_id", fare_id)
        if fare:
            return self._convert_decimals_to_floats(fare)
        return None

    # ---------------------
    # ТРАНЗАКЦИИ
    # ---------------------
    async def add_transaction(self, user_type: str, user_id: int, amount: float, tx_type: str, description: str = None):
        try:
            await self._execute(
                "INSERT INTO transactions(user_type, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)",
                (user_type, user_id, amount, tx_type, description)
            )
            await log("[+]", f"Транзакция для {user_type} id={user_id} сумма={amount} тип={tx_type}")
        except Exception as e:
            await log("[!]", f"Не удалось добавить транзакцию для {user_type} id={user_id}: {e}")
            raise

    async def get_transactions(self, user_type: str = None, user_id: int = None) -> List[Dict]:
        if user_type and user_id:
            transactions = await self._execute(
                "SELECT * FROM transactions WHERE user_type=$1 AND user_id=$2 ORDER BY created DESC",
                (user_type, user_id),
                fetchall=True
            )
        elif user_type:
            transactions = await self._execute(
                "SELECT * FROM transactions WHERE user_type=$1 ORDER BY created DESC",
                (user_type,),
                fetchall=True
            )
        else:
            transactions = await self._execute(
                "SELECT * FROM transactions ORDER BY created DESC",
                fetchall=True
            )
        
        return self._convert_decimals_to_floats(transactions) if transactions else []

    def _convert_decimals_to_floats(self, data: Any) -> Any:
        """Рекурсивно преобразует Decimal в float, работает со словарями и списками"""
        if isinstance(data, dict):
            result = {}
            for key, value in data.items():
                if isinstance(value, decimal.Decimal):
                    result[key] = float(value)
                elif isinstance(value, (dict, list)):
                    result[key] = self._convert_decimals_to_floats(value)
                else:
                    result[key] = value
            return result
        elif isinstance(data, list):
            return [self._convert_decimals_to_floats(item) for item in data]
        elif isinstance(data, decimal.Decimal):
            return float(data)
        else:
            return data

    # ---------------------
    # ADMIN API
    # ---------------------

    async def touch_user_last_seen(self, user_type: str, user_id: int) -> None:
        """Фиксирует последнюю активность по Socket (водитель/клиент)."""
        ut = (user_type or "").strip().lower()
        if ut == "driver":
            await self._execute(
                "UPDATE drivers SET last_seen_at = CURRENT_TIMESTAMP WHERE driver_id = $1",
                (int(user_id),),
            )
        elif ut == "client":
            await self._execute(
                "UPDATE clients SET last_seen_at = CURRENT_TIMESTAMP WHERE client_id = $1",
                (int(user_id),),
            )

    async def admin_count_stats(self) -> Dict[str, Any]:
        row = await self._execute(
            """
            SELECT
              (SELECT COUNT(*)::int FROM clients) AS clients_total,
              (SELECT COUNT(*)::int FROM drivers) AS drivers_total,
              (SELECT COUNT(*)::int FROM drivers WHERE status IN ('available', 'busy')) AS drivers_active_status,
              (SELECT COUNT(*)::int FROM drivers WHERE status = 'available') AS drivers_status_available,
              (SELECT COUNT(*)::int FROM drivers WHERE status = 'busy') AS drivers_status_busy,
              (SELECT COUNT(*)::int FROM drivers WHERE status = 'offline') AS drivers_status_offline,
              (SELECT COUNT(*)::int FROM drivers WHERE COALESCE(is_banned, FALSE) OR COALESCE(admin_disabled, FALSE))
                AS drivers_restricted,
              (SELECT COUNT(*)::int FROM trips WHERE status IN ('pending', 'accepted', 'offered', 'busy')) AS trips_active,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'pending') AS trips_pending,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'offered') AS trips_offered,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'completed') AS trips_completed,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'cancelled') AS trips_cancelled,
              (SELECT COUNT(*)::int FROM trips WHERE (created_at)::date = CURRENT_DATE) AS trips_created_today,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'completed'
                 AND completed_at IS NOT NULL
                 AND (completed_at)::date = CURRENT_DATE) AS trips_completed_today,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'cancelled'
                 AND cancelled_at IS NOT NULL
                 AND (cancelled_at)::date = CURRENT_DATE) AS trips_cancelled_today,
              (SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0)::float FROM drivers WHERE rating IS NOT NULL)
                AS avg_driver_rating,
              (SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0)::float FROM clients WHERE rating IS NOT NULL)
                AS avg_client_rating,
              (SELECT COUNT(*)::int FROM drivers
                 WHERE LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = 'pending') AS drivers_verif_pending,
              (SELECT COUNT(*)::int FROM drivers
                 WHERE LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = 'verified') AS drivers_verif_verified,
              (SELECT COUNT(*)::int FROM drivers
                 WHERE LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = 'refused') AS drivers_verif_refused,
              (SELECT COALESCE(SUM(price), 0)::float FROM trips WHERE status = 'completed') AS revenue_completed_total,
              (SELECT COALESCE(SUM(price), 0)::float FROM trips WHERE status = 'completed'
                 AND completed_at IS NOT NULL AND (completed_at)::date = CURRENT_DATE) AS revenue_completed_today,
              (SELECT COUNT(*)::int FROM trips WHERE created_at >= CURRENT_DATE - INTERVAL '6 days') AS trips_created_7d,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'accepted') AS trips_accepted,
              (SELECT COUNT(*)::int FROM drivers WHERE (created_at)::date = CURRENT_DATE) AS drivers_registered_today,
              (SELECT COUNT(*)::int FROM clients WHERE COALESCE(is_banned, FALSE) OR COALESCE(admin_disabled, FALSE))
                AS clients_restricted,
              (SELECT COUNT(*)::int FROM drivers WHERE COALESCE(is_banned, FALSE)) AS drivers_banned,
              (SELECT COUNT(*)::int FROM drivers WHERE COALESCE(admin_disabled, FALSE) AND NOT COALESCE(is_banned, FALSE))
                AS drivers_deactivated_only,
              (SELECT COUNT(*)::int FROM clients WHERE COALESCE(is_banned, FALSE)) AS clients_banned,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'busy') AS trips_busy,
              (SELECT COALESCE(ROUND(AVG(distance_km)::numeric, 2), 0)::float FROM trips
                 WHERE status = 'completed' AND distance_km IS NOT NULL AND distance_km > 0) AS avg_km_completed,
              (SELECT COUNT(*)::int FROM refusals WHERE (created_at)::date = CURRENT_DATE) AS refusals_today,
              (SELECT COUNT(*)::int FROM trips WHERE status = 'completed'
                 AND completed_at IS NOT NULL AND completed_at >= CURRENT_DATE - INTERVAL '7 days') AS trips_completed_7d,
              (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (t.accepted_at - t.created_at))), 0)::float
                 FROM trips t
                 WHERE t.created_at > NOW() - INTERVAL '24 hours'
                   AND t.accepted_at IS NOT NULL AND t.driver_id IS NOT NULL
                   AND t.status IN ('accepted', 'busy', 'completed')) AS dispatch_avg_accept_sec_24h,
              (SELECT COUNT(*)::int FROM trips t
                 WHERE t.created_at > NOW() - INTERVAL '24 hours'
                   AND t.accepted_at IS NOT NULL AND t.driver_id IS NOT NULL
                   AND t.status IN ('accepted', 'busy', 'completed')) AS dispatch_accept_samples_24h,
              (SELECT COALESCE(AVG(t.price / NULLIF(t.distance_km, 0)), 0)::float FROM trips t
                 WHERE t.status = 'completed'
                   AND t.completed_at IS NOT NULL AND t.completed_at > NOW() - INTERVAL '24 hours'
                   AND t.distance_km IS NOT NULL AND t.distance_km > 0 AND COALESCE(t.price, 0) > 0)
                 AS dispatch_avg_price_per_km_24h
            """,
            fetchone=True,
        )
        if not row:
            return {}
        return self._convert_decimals_to_floats(dict(row))

    async def admin_analytics_snapshot(self) -> Dict[str, Any]:
        by_status = await self._execute(
            "SELECT status, COUNT(*)::int AS c FROM trips GROUP BY status ORDER BY status",
            fetchall=True,
        )
        last7 = await self._execute(
            """
            SELECT (created_at::date)::text AS d, COUNT(*)::int AS c
            FROM trips
            WHERE created_at::date >= (CURRENT_DATE - INTERVAL '6 days')
            GROUP BY 1
            ORDER BY 1
            """,
            fetchall=True,
        )
        verif = await self._execute(
            """
            SELECT LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) AS v, COUNT(*)::int AS c
            FROM drivers
            GROUP BY 1
            ORDER BY 1
            """,
            fetchall=True,
        )
        completed7 = await self._execute(
            """
            SELECT (completed_at::date)::text AS d, COUNT(*)::int AS c
            FROM trips
            WHERE status = 'completed' AND completed_at IS NOT NULL
              AND (completed_at::date) >= (CURRENT_DATE - INTERVAL '6 days')
            GROUP BY 1
            ORDER BY 1
            """,
            fetchall=True,
        )
        revenue7 = await self._execute(
            """
            SELECT (completed_at::date)::text AS d, COALESCE(SUM(price), 0)::float AS rev
            FROM trips
            WHERE status = 'completed' AND completed_at IS NOT NULL
              AND (completed_at::date) >= (CURRENT_DATE - INTERVAL '6 days')
            GROUP BY 1
            ORDER BY 1
            """,
            fetchall=True,
        )
        refusals30 = await self._execute(
            """
            SELECT COALESCE(NULLIF(TRIM(reason_type), ''), '(пусто)') AS reason_type, COUNT(*)::int AS c
            FROM refusals
            WHERE created_at >= (CURRENT_DATE - INTERVAL '30 days')
            GROUP BY 1
            ORDER BY c DESC
            LIMIT 12
            """,
            fetchall=True,
        )
        new_clients_7 = await self._execute(
            """
            SELECT (created_at::date)::text AS d, COUNT(*)::int AS c
            FROM clients
            WHERE (created_at::date) >= (CURRENT_DATE - INTERVAL '6 days')
            GROUP BY 1
            ORDER BY 1
            """,
            fetchall=True,
        )
        new_drivers_7 = await self._execute(
            """
            SELECT (created_at::date)::text AS d, COUNT(*)::int AS c
            FROM drivers
            WHERE (created_at::date) >= (CURRENT_DATE - INTERVAL '6 days')
            GROUP BY 1
            ORDER BY 1
            """,
            fetchall=True,
        )
        clients_device_platform = await self._execute(
            """
            SELECT COALESCE(NULLIF(TRIM(LOWER(device_platform)), ''), '(не задано)') AS k, COUNT(*)::int AS c
            FROM clients
            GROUP BY 1
            ORDER BY c DESC
            LIMIT 12
            """,
            fetchall=True,
        )
        drivers_device_platform = await self._execute(
            """
            SELECT COALESCE(NULLIF(TRIM(LOWER(device_platform)), ''), '(не задано)') AS k, COUNT(*)::int AS c
            FROM drivers
            GROUP BY 1
            ORDER BY c DESC
            LIMIT 12
            """,
            fetchall=True,
        )
        clients_device_screen = await self._execute(
            """
            SELECT COALESCE(NULLIF(TRIM(device_screen), ''), '(не задано)') AS k, COUNT(*)::int AS c
            FROM clients
            GROUP BY 1
            ORDER BY c DESC
            LIMIT 10
            """,
            fetchall=True,
        )
        drivers_device_screen = await self._execute(
            """
            SELECT COALESCE(NULLIF(TRIM(device_screen), ''), '(не задано)') AS k, COUNT(*)::int AS c
            FROM drivers
            GROUP BY 1
            ORDER BY c DESC
            LIMIT 10
            """,
            fetchall=True,
        )
        trip_totals = await self._execute(
            """
            SELECT
              COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed_n,
              COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0)::int AS cancelled_n,
              COUNT(*)::int AS all_n
            FROM trips
            """,
            fetchone=True,
        )
        by_status_list = [{"status": r["status"], "count": r["c"]} for r in (by_status or [])]
        trips_by_status: Dict[str, int] = {}
        for r in by_status or []:
            trips_by_status[str(r["status"])] = int(r["c"])
        cn = int((trip_totals or {}).get("completed_n") or 0)
        xn = int((trip_totals or {}).get("cancelled_n") or 0)
        denom = cn + xn
        cancel_share = round(100.0 * xn / denom, 1) if denom > 0 else 0.0
        return self._convert_decimals_to_floats(
            {
                "trips_by_status": trips_by_status,
                "trips_by_status_list": by_status_list,
                "trips_created_by_day": [{"date": r["d"], "count": r["c"]} for r in (last7 or [])],
                "trips_completed_by_day": [{"date": r["d"], "count": r["c"]} for r in (completed7 or [])],
                "revenue_completed_by_day": [{"date": r["d"], "revenue": float(r["rev"] or 0)} for r in (revenue7 or [])],
                "refusals_by_reason_30d": [
                    {"reason_type": r["reason_type"], "count": r["c"]} for r in (refusals30 or [])
                ],
                "new_clients_by_day": [{"date": r["d"], "count": r["c"]} for r in (new_clients_7 or [])],
                "new_drivers_by_day": [{"date": r["d"], "count": r["c"]} for r in (new_drivers_7 or [])],
                "trips_completed_total": cn,
                "trips_cancelled_total": xn,
                "cancellation_share_pct": cancel_share,
                "drivers_by_verification": {str(r["v"]): int(r["c"]) for r in (verif or [])},
                "clients_device_platform": [
                    {"key": r["k"], "count": int(r["c"])} for r in (clients_device_platform or [])
                ],
                "drivers_device_platform": [
                    {"key": r["k"], "count": int(r["c"])} for r in (drivers_device_platform or [])
                ],
                "clients_device_screen": [
                    {"key": r["k"], "count": int(r["c"])} for r in (clients_device_screen or [])
                ],
                "drivers_device_screen": [
                    {"key": r["k"], "count": int(r["c"])} for r in (drivers_device_screen or [])
                ],
            }
        )

    async def admin_list_drivers(
        self,
        limit: int = 100,
        offset: int = 0,
        q: Optional[str] = None,
        sort_by: str = "driver_id",
        sort_dir: str = "desc",
        verification: Optional[str] = None,
    ) -> List[Dict]:
        lim = max(1, min(limit, 500))
        off = max(0, offset)
        order_map = {
            "driver_id": "driver_id",
            "id": "driver_id",
            "created_at": "created_at",
            "rating": "rating",
            "verification": "verification",
            "status": "status",
            "name": "name",
            "balance": "balance",
        }
        ob = order_map.get((sort_by or "driver_id").lower(), "driver_id")
        od = "ASC" if (sort_dir or "").upper() == "ASC" else "DESC"
        vf = (verification or "").strip().lower()
        use_vf = vf in ("pending", "verified", "refused")

        base_sel = """
                SELECT driver_id, name, surname, phone, email, last_lat, last_lon, car_name, car_category,
                       car_year, car_number, face_photo, rating, status, balance, verification, admin_disabled, is_banned,
                       created_at, updated_at, last_seen_at, COALESCE(acceptance_rate, 0.75) AS acceptance_rate,
                       device_screen, device_platform, device_lang
                FROM drivers
        """
        if q and str(q).strip():
            pat = f"%{str(q).strip()}%"
            if use_vf:
                sql = (
                    base_sel
                    + """ WHERE (CAST(driver_id AS TEXT) LIKE $1 OR phone ILIKE $1 OR name ILIKE $1 OR surname ILIKE $1)
                        AND LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = $2
                        ORDER BY """
                    + ob
                    + " "
                    + od
                    + " LIMIT $3 OFFSET $4"
                )
                rows = await self._execute(sql, (pat, vf, lim, off), fetchall=True)
            else:
                sql = (
                    base_sel
                    + """ WHERE CAST(driver_id AS TEXT) LIKE $1 OR phone ILIKE $1 OR name ILIKE $1 OR surname ILIKE $1
                        ORDER BY """
                    + ob
                    + " "
                    + od
                    + " LIMIT $2 OFFSET $3"
                )
                rows = await self._execute(sql, (pat, lim, off), fetchall=True)
        else:
            if use_vf:
                sql = (
                    base_sel
                    + " WHERE LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = $1 ORDER BY "
                    + ob
                    + " "
                    + od
                    + " LIMIT $2 OFFSET $3"
                )
                rows = await self._execute(sql, (vf, lim, off), fetchall=True)
            else:
                sql = base_sel + " ORDER BY " + ob + " " + od + " LIMIT $1 OFFSET $2"
                rows = await self._execute(sql, (lim, off), fetchall=True)
        return self._convert_decimals_to_floats(rows or [])

    @staticmethod
    def _normalize_data_url_photo_payload(val: Any) -> Optional[str]:
        """Оставляет только «хвост» base64 после последнего ;base64, (убирает вложенные data:-префиксы)."""
        if val is None:
            return None
        s = str(val).strip()
        if not s:
            return None
        low = s.lower()
        while ";base64," in low:
            idx = low.rfind(";base64,")
            tail = s[idx + 8 :].strip()
            if not tail or len(tail) >= len(s):
                break
            s, low = tail, tail.lower()
        return s or None

    async def admin_get_driver_public(self, driver_id: int) -> Optional[Dict]:
        row = await self._execute(
            """
            SELECT driver_id, name, surname, phone, email, last_lat, last_lon, car_name, car_category,
                   car_year, car_number, car_tech_passport, driver_license, rating, status, balance,
                   verification, admin_disabled, is_banned, price_per_km, rating_coefficient,
                   car_front_photo, driver_license_photo, car_tech_photo, face_photo,
                   created_at, updated_at, last_seen_at, COALESCE(acceptance_rate, 0.75) AS acceptance_rate,
                   device_screen, device_platform, device_lang
            FROM drivers WHERE driver_id = $1
            """,
            (driver_id,),
            fetchone=True,
        )
        if not row:
            return None
        d = dict(row)
        for k in ("car_front_photo", "driver_license_photo", "car_tech_photo", "face_photo"):
            if k in d:
                d[k] = self._normalize_data_url_photo_payload(d.get(k))
        return self._convert_decimals_to_floats(d)

    async def admin_list_clients(
        self,
        limit: int = 100,
        offset: int = 0,
        q: Optional[str] = None,
        sort_by: str = "client_id",
        sort_dir: str = "desc",
    ) -> List[Dict]:
        lim = max(1, min(limit, 500))
        off = max(0, offset)
        order_map = {
            "client_id": "c.client_id",
            "id": "c.client_id",
            "created_at": "c.created_at",
            "rating": "c.rating",
            "name": "c.name",
            "balance": "c.balance",
            "trips_count": "trips_count",
        }
        ob = order_map.get((sort_by or "client_id").lower(), "c.client_id")
        od = "ASC" if (sort_dir or "").upper() == "ASC" else "DESC"
        base_sel = """
                SELECT c.client_id, c.name, c.surname, c.phone, c.email, c.rating, c.balance, c.last_lat, c.last_lon,
                       c.photo, c.is_banned, c.admin_disabled, c.created_at, c.updated_at, c.last_seen_at,
                       c.device_screen, c.device_platform, c.device_lang,
                       COALESCE(t.cnt, 0)::int AS trips_count
                FROM clients c
                LEFT JOIN (
                  SELECT client_id, COUNT(*)::int AS cnt FROM trips GROUP BY client_id
                ) t ON t.client_id = c.client_id
        """
        if q and str(q).strip():
            pat = f"%{str(q).strip()}%"
            sql = (
                base_sel
                + """ WHERE CAST(c.client_id AS TEXT) LIKE $1 OR c.phone ILIKE $1 OR c.name ILIKE $1 OR c.surname ILIKE $1
                ORDER BY """
                + ob
                + " "
                + od
                + " LIMIT $2 OFFSET $3"
            )
            rows = await self._execute(sql, (pat, lim, off), fetchall=True)
        else:
            sql = base_sel + " ORDER BY " + ob + " " + od + " LIMIT $1 OFFSET $2"
            rows = await self._execute(sql, (lim, off), fetchall=True)
        return self._convert_decimals_to_floats(rows or [])

    async def admin_get_client_public(self, client_id: int) -> Optional[Dict]:
        row = await self._execute(
            """
            SELECT client_id, name, surname, phone, email, rating, balance, last_lat, last_lon,
                   photo, is_banned, admin_disabled, created_at, updated_at, last_seen_at,
                   device_screen, device_platform, device_lang
            FROM clients WHERE client_id = $1
            """,
            (client_id,),
            fetchone=True,
        )
        if not row:
            return None
        d = dict(row)
        if "photo" in d:
            d["photo"] = self._normalize_data_url_photo_payload(d.get("photo"))
        return self._convert_decimals_to_floats(d)

    async def admin_list_trips(
        self,
        limit: int = 100,
        offset: int = 0,
        status: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
        q: Optional[str] = None,
        sort_by: str = "created_at",
        sort_dir: str = "desc",
    ) -> List[Dict]:
        lim = max(1, min(limit, 500))
        off = max(0, offset)
        conds: List[str] = []
        params: List[Any] = []
        i = 1
        recent_map_order = False

        if status:
            st = str(status).strip().lower()
            if st in ("active", "in_progress", "ongoing", "live"):
                conds.append(
                    "t.status IN ('pending', 'offered', 'accepted', 'busy')"
                )
            elif st in ("map_recent", "recent_routes"):
                # Завершённые/отменённые с полным маршрутом за последние 72 ч (для карты админки).
                conds.append(
                    "t.status IN ('completed', 'cancelled') "
                    "AND t.start_lat IS NOT NULL AND t.start_lon IS NOT NULL "
                    "AND t.end_lat IS NOT NULL AND t.end_lon IS NOT NULL "
                    "AND COALESCE(t.completed_at, t.cancelled_at, t.created_at) "
                    ">= NOW() - INTERVAL '72 hours'"
                )
                recent_map_order = True
            else:
                conds.append(f"t.status = ${i}")
                params.append(status)
                i += 1
        if date_from:
            conds.append(f"t.created_at >= ${i}")
            params.append(date_from)
            i += 1
        if date_to:
            conds.append(f"t.created_at <= ${i}")
            params.append(date_to)
            i += 1
        if q and str(q).strip():
            conds.append(
                f"(CAST(t.trip_id AS TEXT) LIKE ${i} OR CAST(t.client_id AS TEXT) LIKE ${i} OR CAST(t.driver_id AS TEXT) LIKE ${i})"
            )
            params.append(f"%{str(q).strip()}%")
            i += 1

        where = ("WHERE " + " AND ".join(conds)) if conds else ""
        order_map = {
            "trip_id": "t.trip_id",
            "id": "t.trip_id",
            "created_at": "t.created_at",
            "price": "t.price",
            "distance": "t.distance_km",
            "distance_km": "t.distance_km",
            "status": "t.status",
        }
        if recent_map_order:
            ob = "COALESCE(t.completed_at, t.cancelled_at, t.created_at)"
            od = "DESC"
        else:
            ob = order_map.get((sort_by or "created_at").lower(), "t.created_at")
            od = "ASC" if (sort_dir or "").upper() == "ASC" else "DESC"
        params.extend([lim, off])
        lim_ph = f"${i}"
        off_ph = f"${i + 1}"

        sql = f"""
            SELECT t.*,
                   c.name AS client_first_name, c.surname AS client_last_name,
                   d.name AS driver_first_name, d.surname AS driver_last_name,
                   (SELECT COALESCE(r.reason_type, '') || ': ' ||
                           LEFT(COALESCE(r.reason_text, ''), 160)
                    FROM refusals r
                    WHERE r.trip_id = t.trip_id
                    ORDER BY r.created_at DESC NULLS LAST
                    LIMIT 1) AS admin_last_refusal_line
            FROM trips t
            LEFT JOIN clients c ON c.client_id = t.client_id
            LEFT JOIN drivers d ON d.driver_id = t.driver_id
            {where}
            ORDER BY {ob} {od} NULLS LAST
            LIMIT {lim_ph} OFFSET {off_ph}
        """
        rows = await self._execute(sql, tuple(params), fetchall=True)
        return self._convert_decimals_to_floats(rows or [])

    async def admin_get_trip(self, trip_id: int) -> Optional[Dict]:
        row = await self._execute(
            """
            SELECT t.*,
                   c.name AS client_first_name, c.surname AS client_last_name,
                   d.name AS driver_first_name, d.surname AS driver_last_name
            FROM trips t
            LEFT JOIN clients c ON c.client_id = t.client_id
            LEFT JOIN drivers d ON d.driver_id = t.driver_id
            WHERE t.trip_id = $1
            """,
            (trip_id,),
            fetchone=True,
        )
        return self._convert_decimals_to_floats(dict(row)) if row else None

    async def upsert_push_subscription(
        self,
        user_type: str,
        user_id: int,
        endpoint: str,
        p256dh: str,
        auth: str,
    ) -> None:
        await self._execute(
            """
            INSERT INTO push_subscriptions (user_type, user_id, endpoint, p256dh, auth)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (endpoint) DO UPDATE SET
              user_type = EXCLUDED.user_type,
              user_id = EXCLUDED.user_id,
              p256dh = EXCLUDED.p256dh,
              auth = EXCLUDED.auth,
              updated_at = CURRENT_TIMESTAMP
            """,
            (user_type, int(user_id), endpoint, p256dh, auth),
        )

    async def delete_push_subscription(
        self, user_type: str, user_id: int, endpoint: str
    ) -> bool:
        row = await self._execute(
            """
            DELETE FROM push_subscriptions
            WHERE endpoint = $1 AND user_type = $2 AND user_id = $3
            RETURNING subscription_id
            """,
            (endpoint, user_type, int(user_id)),
            fetchone=True,
        )
        return row is not None

    async def delete_all_push_subscriptions_for_user(
        self, user_type: str, user_id: int
    ) -> None:
        await self._execute(
            "DELETE FROM push_subscriptions WHERE user_type = $1 AND user_id = $2",
            (user_type, int(user_id)),
        )

    async def list_push_subscriptions_for_user(
        self, user_type: str, user_id: int
    ) -> List[Dict]:
        rows = await self._execute(
            """
            SELECT endpoint, p256dh, auth FROM push_subscriptions
            WHERE user_type = $1 AND user_id = $2
            """,
            (user_type, int(user_id)),
            fetchall=True,
        )
        return self._convert_decimals_to_floats(rows or [])

    async def list_push_notification_templates(self) -> List[Dict]:
        rows = await self._execute(
            """
            SELECT event_key, title_template, body_template, subtitle_template, updated_at
            FROM push_notification_templates
            ORDER BY event_key
            """,
            fetchall=True,
        )
        return self._convert_decimals_to_floats(rows or [])

    async def get_push_notification_template(self, event_key: str) -> Optional[Dict]:
        return await self._execute(
            """
            SELECT event_key, title_template, body_template, subtitle_template, updated_at
            FROM push_notification_templates
            WHERE event_key = $1
            """,
            (event_key,),
            fetchone=True,
        )

    async def upsert_push_notification_template(
        self,
        event_key: str,
        title_template: str,
        body_template: str,
        subtitle_template: str = "",
    ) -> None:
        ek = (event_key or "").strip()
        if not ek or len(ek) > 64:
            raise ValueError("invalid event_key")
        sub = subtitle_template or ""
        await self._execute(
            """
            INSERT INTO push_notification_templates (event_key, title_template, body_template, subtitle_template)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (event_key) DO UPDATE SET
                title_template = EXCLUDED.title_template,
                body_template = EXCLUDED.body_template,
                subtitle_template = EXCLUDED.subtitle_template,
                updated_at = CURRENT_TIMESTAMP
            """,
            (ek, title_template, body_template, sub),
        )

    async def admin_delete_trip(self, trip_id: int) -> bool:
        tid = int(trip_id)
        if tid < 1:
            raise ValueError("invalid trip_id")
        row = await self._execute(
            "DELETE FROM trips WHERE trip_id = $1 RETURNING trip_id",
            (tid,),
            fetchone=True,
        )
        return row is not None

    async def admin_map_snapshot(self) -> Dict[str, List[Dict]]:
        drivers = await self._execute(
            """
            SELECT driver_id, name, surname, rating, status, last_lat, last_lon, admin_disabled, is_banned
            FROM drivers
            WHERE last_lat IS NOT NULL AND last_lon IS NOT NULL
            ORDER BY driver_id
            """,
            fetchall=True,
        )
        clients = await self._execute(
            """
            SELECT client_id, name, surname, rating, last_lat, last_lon
            FROM clients
            WHERE last_lat IS NOT NULL AND last_lon IS NOT NULL
            ORDER BY client_id
            """,
            fetchall=True,
        )
        return {
            "drivers": self._convert_decimals_to_floats(drivers or []),
            "clients": self._convert_decimals_to_floats(clients or []),
        }

    async def admin_delete_client(self, client_id: int) -> None:
        """Удаление клиента: транзакции, поездки и связанные записи (CASCADE с trips)."""
        if not self.pool:
            await self.connect()
        cid = int(client_id)
        if cid < 1:
            raise ValueError("invalid client_id")
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                # asyncpg: аргументы — через запятую, не один кортеж (иначе один bind на $1+$2).
                await conn.execute(
                    "DELETE FROM transactions WHERE user_type = $1 AND user_id = $2",
                    "client",
                    cid,
                )
                await conn.execute("DELETE FROM trips WHERE client_id = $1", cid)
                await conn.execute("DELETE FROM clients WHERE client_id = $1", cid)
        await log("[-]", f"Админ: удалён клиент client_id={cid}")

    async def admin_delete_driver(self, driver_id: int) -> None:
        """Удаление водителя: транзакции, отвязка поездок, очистка массивов офферов."""
        if not self.pool:
            await self.connect()
        did = int(driver_id)
        if did < 1:
            raise ValueError("invalid driver_id")
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "DELETE FROM transactions WHERE user_type = $1 AND user_id = $2",
                    "driver",
                    did,
                )
                # Без $n: при нескольких $1 в одном запросе asyncpg/PG давали «expects 2 arguments, 1 was passed».
                await conn.execute(
                    f"""
                    UPDATE trips SET
                      offer_driver_ids = array_remove(COALESCE(offer_driver_ids, ARRAY[]::INTEGER[]), {did}),
                      dispatch_seen_driver_ids = array_remove(COALESCE(dispatch_seen_driver_ids, ARRAY[]::INTEGER[]), {did})
                    WHERE {did} = ANY(COALESCE(offer_driver_ids, ARRAY[]::INTEGER[]))
                       OR {did} = ANY(COALESCE(dispatch_seen_driver_ids, ARRAY[]::INTEGER[]))
                    """
                )
                await conn.execute(
                    "UPDATE trips SET driver_id = NULL WHERE driver_id = $1",
                    did,
                )
                await conn.execute("DELETE FROM drivers WHERE driver_id = $1", did)
        await log("[-]", f"Админ: удалён водитель driver_id={did}")

    async def admin_update_driver_flags(
        self,
        driver_id: int,
        *,
        is_banned: Optional[bool] = None,
        admin_disabled: Optional[bool] = None,
        force_offline: bool = True,
    ) -> bool:
        sets: List[str] = []
        vals: List[Any] = []
        n = 1
        if is_banned is not None:
            sets.append(f"is_banned = ${n}")
            vals.append(is_banned)
            n += 1
        if admin_disabled is not None:
            sets.append(f"admin_disabled = ${n}")
            vals.append(admin_disabled)
            n += 1
        if force_offline and (is_banned is True or admin_disabled is True):
            sets.append("status = 'offline'")
        if not sets:
            return False
        vals.append(driver_id)
        sql = f"UPDATE drivers SET {', '.join(sets)}, updated_at = CURRENT_TIMESTAMP WHERE driver_id = ${n}"
        await self._execute(sql, tuple(vals))
        return True

    async def admin_update_client_flags(
        self,
        client_id: int,
        *,
        is_banned: Optional[bool] = None,
        admin_disabled: Optional[bool] = None,
    ) -> bool:
        sets: List[str] = []
        vals: List[Any] = []
        n = 1
        if is_banned is not None:
            sets.append(f"is_banned = ${n}")
            vals.append(is_banned)
            n += 1
        if admin_disabled is not None:
            sets.append(f"admin_disabled = ${n}")
            vals.append(admin_disabled)
            n += 1
        if not sets:
            return False
        vals.append(client_id)
        sql = f"UPDATE clients SET {', '.join(sets)}, updated_at = CURRENT_TIMESTAMP WHERE client_id = ${n}"
        await self._execute(sql, tuple(vals))
        return True

    @staticmethod
    def _parse_json_timeline(raw: Any) -> List[Dict[str, Any]]:
        if raw is None:
            return []
        if isinstance(raw, list):
            return list(raw)
        if isinstance(raw, str):
            try:
                v = json.loads(raw)
                return list(v) if isinstance(v, list) else []
            except Exception:
                return []
        return []

    async def driver_list_withdrawals(self, driver_id: int, limit: int = 40) -> List[Dict[str, Any]]:
        rows = await self._execute(
            """
            SELECT id, driver_id, amount, status, card_bin6, card_last4, timeline,
                   balance_refunded, created_at, updated_at
            FROM driver_withdrawal_requests
            WHERE driver_id = $1
            ORDER BY id DESC
            LIMIT $2
            """,
            (driver_id, max(1, min(int(limit), 100))),
            fetchall=True,
        )
        out: List[Dict[str, Any]] = []
        for r in rows or []:
            d = dict(r)
            d["timeline"] = self._parse_json_timeline(d.get("timeline"))
            out.append(self._convert_decimals_to_floats(d))
        return out

    async def driver_create_withdrawal_request(
        self,
        driver_id: int,
        amount: float,
        card_bin6: str,
        card_last4: str,
    ) -> Optional[Dict[str, Any]]:
        """Списывает сумму с баланса и создаёт заявку. При неудаче UPDATE — None."""
        amt = round(float(amount), 2)
        if amt <= 0:
            return None
        t0 = datetime.now(timezone.utc).isoformat()
        msg0 = await self.get_withdrawal_timeline_comment("pending")
        timeline = [
            {
                "at": t0,
                "status": "pending",
                "comment": msg0,
                "actor": "system",
            }
        ]
        pool = self.pool
        if not pool:
            await self.connect()
            pool = self.pool
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    UPDATE drivers
                    SET balance = balance - $1::numeric
                    WHERE driver_id = $2
                      AND COALESCE(admin_disabled, FALSE) = FALSE
                      AND COALESCE(is_banned, FALSE) = FALSE
                      AND balance >= $1::numeric
                    RETURNING balance
                    """,
                    amt,
                    driver_id,
                )
                if not row:
                    return None
                wid = await conn.fetchval(
                    """
                    INSERT INTO driver_withdrawal_requests
                        (driver_id, amount, status, card_bin6, card_last4, timeline)
                    VALUES ($1, $2, 'pending', $3, $4, $5::jsonb)
                    RETURNING id
                    """,
                    driver_id,
                    amt,
                    card_bin6[:6],
                    card_last4[-4:],
                    json.dumps(timeline),
                )
                return {
                    "id": int(wid),
                    "amount": amt,
                    "status": "pending",
                    "balance": float(row["balance"]),
                }

    async def admin_list_withdrawals(
        self,
        *,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        lim = max(1, min(int(limit), 300))
        off = max(0, int(offset))
        if status:
            rows = await self._execute(
                """
                SELECT w.id, w.driver_id, w.amount, w.status, w.card_bin6, w.card_last4,
                       w.timeline, w.balance_refunded, w.created_at, w.updated_at,
                       d.name AS driver_name, d.surname AS driver_surname, d.phone AS driver_phone
                FROM driver_withdrawal_requests w
                JOIN drivers d ON d.driver_id = w.driver_id
                WHERE w.status = $1
                ORDER BY w.id DESC
                LIMIT $2 OFFSET $3
                """,
                (status, lim, off),
                fetchall=True,
            )
        else:
            rows = await self._execute(
                """
                SELECT w.id, w.driver_id, w.amount, w.status, w.card_bin6, w.card_last4,
                       w.timeline, w.balance_refunded, w.created_at, w.updated_at,
                       d.name AS driver_name, d.surname AS driver_surname, d.phone AS driver_phone
                FROM driver_withdrawal_requests w
                JOIN drivers d ON d.driver_id = w.driver_id
                ORDER BY w.id DESC
                LIMIT $1 OFFSET $2
                """,
                (lim, off),
                fetchall=True,
            )
        out: List[Dict[str, Any]] = []
        for r in rows or []:
            d = dict(r)
            d["timeline"] = self._parse_json_timeline(d.get("timeline"))
            out.append(self._convert_decimals_to_floats(d))
        return out

    async def admin_patch_withdrawal_request(
        self,
        withdrawal_id: int,
        new_status: str,
        comment: str,
        *,
        actor_label: str = "admin",
    ) -> Optional[Dict[str, Any]]:
        """Обновляет статус; при rejected возвращает сумму на баланс (один раз)."""
        allowed = {"pending", "processing", "completed", "rejected"}
        if new_status not in allowed:
            return None
        pool = self.pool
        if not pool:
            await self.connect()
            pool = self.pool
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM driver_withdrawal_requests WHERE id = $1 FOR UPDATE",
                    withdrawal_id,
                )
                if not row:
                    return None
                cur = str(row["status"] or "")
                comment_clean = (comment or "").strip()
                if cur == new_status and not comment_clean:
                    d = dict(row)
                    d["timeline"] = self._parse_json_timeline(d.get("timeline"))
                    return self._convert_decimals_to_floats(d)
                if cur in ("completed", "rejected") and new_status != cur:
                    return None
                timeline = self._parse_json_timeline(row.get("timeline"))
                tnow = datetime.now(timezone.utc).isoformat()
                resolved_comment = comment_clean
                if not resolved_comment:
                    resolved_comment = await self.get_withdrawal_timeline_comment(
                        new_status
                    )
                timeline.append(
                    {
                        "at": tnow,
                        "status": new_status,
                        "comment": resolved_comment,
                        "actor": actor_label,
                    }
                )
                refunded = bool(row.get("balance_refunded"))
                amt = float(row["amount"])
                did = int(row["driver_id"])
                if new_status == "rejected" and cur in ("pending", "processing") and not refunded:
                    await conn.execute(
                        "UPDATE drivers SET balance = balance + $1::numeric WHERE driver_id = $2",
                        amt,
                        did,
                    )
                    refunded = True
                await conn.execute(
                    """
                    UPDATE driver_withdrawal_requests
                    SET status = $2,
                        timeline = $3::jsonb,
                        balance_refunded = $4,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                    """,
                    withdrawal_id,
                    new_status,
                    json.dumps(timeline),
                    refunded,
                )
            fres = await conn.fetchrow(
                """
                SELECT w.id, w.driver_id, w.amount, w.status, w.card_bin6, w.card_last4,
                       w.timeline, w.balance_refunded, w.created_at, w.updated_at,
                       d.name AS driver_name, d.surname AS driver_surname, d.phone AS driver_phone
                FROM driver_withdrawal_requests w
                JOIN drivers d ON d.driver_id = w.driver_id
                WHERE w.id = $1
                """,
                withdrawal_id,
            )
        if not fres:
            return None
        d = dict(fres)
        d["timeline"] = self._parse_json_timeline(d.get("timeline"))
        return self._convert_decimals_to_floats(d)

    async def admin_delete_withdrawal_request(self, withdrawal_id: int) -> Optional[Dict[str, Any]]:
        """Удаляет заявку на вывод. Если сумма ещё не возвращалась на баланс (balance_refunded=False), начисляет её водителю."""
        pool = self.pool
        if not pool:
            await self.connect()
            pool = self.pool
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM driver_withdrawal_requests WHERE id = $1 FOR UPDATE",
                    withdrawal_id,
                )
                if not row:
                    return None
                did = int(row["driver_id"])
                amt = float(row["amount"])
                already_refunded = bool(row.get("balance_refunded"))
                if not already_refunded:
                    await conn.execute(
                        "UPDATE drivers SET balance = balance + $1::numeric WHERE driver_id = $2",
                        amt,
                        did,
                    )
                await conn.execute(
                    "DELETE FROM driver_withdrawal_requests WHERE id = $1",
                    withdrawal_id,
                )
        return {
            "id": int(withdrawal_id),
            "driver_id": did,
            "amount": amt,
            "balance_credited": not already_refunded,
        }

    # ---------------------
    # ДОПОЛНИТЕЛЬНЫЕ МЕТОДЫ
    # ---------------------
    async def init_sample_data(self):
        """Инициализация примерных данных для тестирования"""
        try:
            # Добавляем примерные тарифы
            await self.add_fare("Econom", 50.00)
            await self.add_fare("Comfort", 70.00)
            await self.add_fare("Business", 100.00)
            await self.add_fare("Premium", 150.00)
            
            await log("[*]", "Примерные данные инициализированы")
        except Exception as e:
            await log("[!]", f"Ошибка инициализации примерных данных: {e}")

    async def drop_all_tables(self):
        """Удаление всех таблиц (для тестирования)"""
        async with self.pool.acquire() as conn:
            try:
                await conn.execute('DROP TABLE IF EXISTS transactions CASCADE')
                await conn.execute('DROP TABLE IF EXISTS trips CASCADE')
                await conn.execute('DROP TABLE IF EXISTS fares CASCADE')
                await conn.execute('DROP TABLE IF EXISTS drivers CASCADE')
                await conn.execute('DROP TABLE IF EXISTS clients CASCADE')
                await log("[!]", "Все таблицы удалены")
            except Exception as e:
                await log("[!]", f"Ошибка удаления таблиц: {e}")