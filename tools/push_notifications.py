"""
Шаблоны Web Push из БД + отправка по ключу события (RU по умолчанию).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Dict, Optional

from tools.database import Database
from tools.pwa_push import send_web_push_to_user

logger = logging.getLogger(__name__)

# Резерв, если строка в БД отсутствует (не должно при нормальной миграции).
# Кортеж: title, body, subtitle (subtitle часто игнорируется Web API; на части сборок Safari может отобразиться).
_BUILTIN_TEMPLATES: Dict[str, tuple[str, str, str]] = {
    "driver_new_trip_offer": (
        "Новый заказ",
        "Поездка №{trip_id}. Примерная стоимость {price} ₼. Откройте приложение, чтобы откликнуться.",
        "",
    ),
    "client_driver_found": (
        "Водитель найден",
        "{driver_label} назначен на поездку №{trip_id}. Откройте экран поездки.",
        "",
    ),
    "client_trip_confirmed": (
        "Поездка подтверждена",
        "Поездка №{trip_id} началась. Водитель: {taxi_name}. Стоимость около {price} ₼.",
        "",
    ),
    "driver_trip_confirmed": (
        "Клиент подтвердил поездку",
        "Поездка №{trip_id} подтверждена. Можно выезжать к точке подачи.",
        "",
    ),
    "driver_withdraw_submitted": (
        "Запрос на вывод",
        "Сумма {amount} ₼. Заявка №{withdrawal_id} принята.",
        "",
    ),
    "driver_withdraw_processing": (
        "Вывод средств",
        "Заявка №{withdrawal_id}: обрабатывается. Сумма {amount} ₼.",
        "",
    ),
    "driver_withdraw_completed": (
        "Вывод выполнен",
        "Заявка №{withdrawal_id} завершена. Сумма {amount} ₼ на карту *{card_last4}.",
        "",
    ),
    "driver_withdraw_rejected": (
        "Вывод отклонён",
        "Заявка №{withdrawal_id}. Сумма {amount} ₼ возвращена. Причина: {reason}",
        "",
    ),
    "driver_trip_cancelled": (
        "Поездка отменена",
        "Поездка №{trip_id} отменена клиентом.",
        "",
    ),
    "client_trip_cancelled": (
        "Поездка отменена",
        "Поездка №{trip_id} отменена водителем.",
        "",
    ),
    "client_trip_finished": (
        "Поездка завершена",
        "Поездка №{trip_id} завершена. Сумма: {price} ₼.",
        "",
    ),
    "driver_trip_finished": (
        "Поездка завершена",
        "Поездка №{trip_id} завершена. Сумма: {price} ₼.",
        "",
    ),
}

# Справка для админки (GET /admin/push-templates → placeholder_help). Совпадает с контекстом send_event_push.
PUSH_TEMPLATE_PLACEHOLDER_HINTS: Dict[str, str] = {
    "driver_new_trip_offer": (
        "{trip_id}, {price}, {start_address}; дубли адресов/дистанции: {addressFrom}, {addressTo}, "
        "{distanceKm} и snake_case: {address_from}, {address_to}, {distance_km}, {end_address}"
    ),
    "client_driver_found": "{trip_id}, {driver_label}",
    "client_trip_confirmed": "{trip_id}, {taxi_name}, {price}",
    "driver_trip_confirmed": "{trip_id}",
    "driver_withdraw_submitted": (
        "{withdrawal_id} — id заявки (строка); {amount} — сумма в ₼. "
        "{card_last4} и {reason} в этом push не передаются (останутся пустыми)."
    ),
    "driver_withdraw_processing": (
        "{withdrawal_id}, {amount}, {card_last4}; {reason} — текст для уведомления "
        "(последний комментарий в истории заявки или комментарий админа, иначе «—»)."
    ),
    "driver_withdraw_completed": (
        "{withdrawal_id}, {amount}, {card_last4}, {reason} — как при смене статуса на «в обработке»."
    ),
    "driver_withdraw_rejected": (
        "{withdrawal_id}, {amount}, {card_last4}, {reason} — при отклонении в {reason} попадает причина."
    ),
    "driver_trip_cancelled": "{trip_id} — клиент отменил поездку; push получает водитель.",
    "client_trip_cancelled": "{trip_id} — водитель отменил поездку; push получает клиент.",
    "client_trip_finished": "{trip_id}, {price} — завершение поездки для клиента (сумма в ₼, строка).",
    "driver_trip_finished": "{trip_id}, {price} — завершение поездки для водителя.",
}


def push_template_placeholder_hint(event_key: str) -> str:
    k = (event_key or "").strip()
    return PUSH_TEMPLATE_PLACEHOLDER_HINTS.get(k, "")


def _format_map(tpl: str, context: Dict[str, Any]) -> str:
    m: defaultdict[str, str] = defaultdict(str)
    for k, v in context.items():
        m[str(k)] = "" if v is None else str(v)
    try:
        return tpl.format_map(m)
    except Exception as e:
        logger.warning("push template format error: %s", e)
        return tpl


async def render_push_templates(
    database: Database, event_key: str, context: Dict[str, Any]
) -> tuple[str, str, str]:
    row = await database.get_push_notification_template(event_key)
    if row:
        title_t = str(row.get("title_template") or "")
        body_t = str(row.get("body_template") or "")
        sub_t = str(row.get("subtitle_template") or "")
    else:
        triple = _BUILTIN_TEMPLATES.get(event_key)
        if not triple:
            title_t, body_t, sub_t = "Уведомление", "Откройте приложение JI Taxi.", ""
        else:
            title_t, body_t, sub_t = triple
    return (
        _format_map(title_t, context),
        _format_map(body_t, context),
        _format_map(sub_t, context),
    )


async def send_event_push(
    database: Database,
    user_type: str,
    user_id: int,
    event_key: str,
    context: Dict[str, Any],
    *,
    url: str = "/",
    trip_id: Optional[int] = None,
) -> int:
    """Рендер шаблона из БД и отправка всем подпискам пользователя."""
    try:
        title, body, subtitle = await render_push_templates(database, event_key, context)
        return await send_web_push_to_user(
            database,
            user_type,
            int(user_id),
            title=title,
            body=body,
            subtitle=subtitle.strip() or None,
            url=url,
            trip_id=trip_id,
        )
    except Exception:
        logger.exception(
            "send_event_push failed event=%s user=%s:%s",
            event_key,
            user_type,
            user_id,
        )
        return 0
