"""
Обработчики входящих Socket.IO «message» — делегирование в trip_commands.
Логика остаётся в tools.trip_commands.dispatch_socket_message.
"""
from __future__ import annotations

from typing import Any, Dict


async def dispatch_socket_message(
    db: Any, data: Dict[str, Any], user_id: str, user_type: str
) -> Dict[str, Any]:
    from tools import trip_commands

    return await trip_commands.dispatch_socket_message(db, data, user_id, user_type)
