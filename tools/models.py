from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from typing import List, Optional, Any
import datetime

from enum import Enum
from itsdangerous import BadSignature, SignatureExpired

# Создание и проверка сессии
def create_session_token(serializer, user_id: int, user_type: str) -> str:
    return serializer.dumps({"user_id": user_id, "user_type": user_type})

# Получение ID Пользователя через сессию
def get_user_from_token(serializer, token: str) -> dict | None:
    try:
        return serializer.loads(token, max_age=3600*24*30)
    except (SignatureExpired, BadSignature):
        return None

# # Создание и проверка сессии
# def create_session_token(serializer, client_id: int) -> str:
#     return serializer.dumps({"client_id": client_id})

# # Получение ID Клиента через сессию
# def get_client_id_from_token(serializer, token: str) -> int | None:
#     try:
#         data = serializer.loads(token, max_age=3600*24*30)  # токен живёт 30 дней
#         return data.get("client_id")
    
#     # Обработка ошибок токена
#     except SignatureExpired: return None
    
#     # Неверный токен
#     except BadSignature: return None

# # Получение ID Водителя через сессию
# def get_driver_id_from_token(serializer, token: str) -> int | None:
#     try:
#         data = serializer.loads(token, max_age=3600*24*30)  # токен живёт 30 дней
#         return data.get("driver_id")
    
#     # Обработка ошибок токена
#     except SignatureExpired: return None
    
#     # Неверный токен
#     except BadSignature: return None

# Модели данных
class Driver(BaseModel):
    id: int
    name: str
    photo: str
    carModel: str
    carYear: int
    carColor: str
    carNumber: str
    pricePerKm: float
    location: List[float]
    rating: float
    status: str  # available, busy, offline
    currentLocation: List[float]

class Order(BaseModel):
    id: str
    userId: str
    driverId: int
    fromLocation: List[float]
    toLocation: List[float]
    status: str  # pending, accepted, in_progress, completed, cancelled
    price: float
    distance: float
    createdAt: datetime.datetime
    updatedAt: datetime.datetime

class CheckTrip(BaseModel):
    clientID: int
    tripID: int
    fromLocation: List[float]
    toLocation: List[float]
    taxiLocation: List[float]
    startAddress: str
    endAddress: str
    distance: float
    drivingTime: str
    idempotency_key: Optional[str] = None

class DriverStatus(str, Enum):
    AVAILABLE = "available"
    OFFLINE = "offline"
    BUSY = "busy"
    
    @classmethod
    def values(cls):
        return [item.value for item in cls]

class Coordinates:
    @staticmethod
    def validate(lat: Any, lng: Any) -> Optional[tuple]:
        """Валидация координат"""
        try:
            lat_float = float(lat)
            lng_float = float(lng)
            
            if -90 <= lat_float <= 90 and -180 <= lng_float <= 180:
                return (lat_float, lng_float)
        except (ValueError, TypeError):
            pass
        return None

class ConfirmationTrip(BaseModel):
    clientID: int
    tripID: int
    driverID: int
    fromLocation: List[float]
    toLocation: List[float]
    taxiLocation: List[float]
    startAddress: str
    endAddress: str
    distance: float
    drivingTime: str
    idempotency_key: Optional[str] = None

class DriverReleaseAwaitingBody(BaseModel):
    """Водитель снимает себя с заказа до подтверждения клиентом (снова поиск)."""
    trip_id: int = Field(..., ge=1)


class ClientDispatchBoostBody(BaseModel):
    """Клиент: одноразовый мягкий буст цены, пока заказ в поиске."""

    trip_id: int = Field(..., ge=1)


class DriverDeclineOfferBody(BaseModel):
    """Водитель: явный отказ от показанного заказа (снятие с offer_driver_ids)."""

    trip_id: int = Field(..., ge=1)
    reason: Optional[str] = Field(
        default="decline",
        max_length=32,
        description="decline | busy | timeout (или синонимы занятости)",
    )


class OrderCreate(BaseModel):
    clientID: int
    startAddress: str
    endAddress: str
    fromLocation: List[float]
    toLocation: List[float]
    distance: float
    clientName: str
    clientRating: float
    drivingTime: str
    routeDurationMinutes: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices("routeDurationMinutes", "route_duration_minutes"),
    )
    idempotency_key: Optional[str] = None

# Модель запроса для сохранении состоянии поездки
class TripState(BaseModel):
    state: str
    trip_id: str
    idempotency_key: Optional[str] = None

    @field_validator("state", mode="before")
    @classmethod
    def _normalize_leg_state(cls, v: Any) -> str:
        from tools.trip_enums import normalize_leg_state

        return normalize_leg_state(str(v) if v is not None else None)


class TripPeerRating(BaseModel):
    trip_id: int
    stars: int
    comment: Optional[str] = None
    """Устарело: свободный текст; новый клиент шлёт reasons."""
    reasons: Optional[List[str]] = None
    """Теги-причины (мультиселект), сериализуются в post_trip_*_comment как JSON."""

    @field_validator("stars", mode="before")
    @classmethod
    def _stars_range(cls, v: Any) -> int:
        s = int(v)
        if s < 1 or s > 5:
            raise ValueError("stars must be 1..5")
        return s


# Модель для регистрации клиента
class ClientRegistration(BaseModel):
    name: str
    surname: str
    phone: str
    last_lat: float
    last_lng: float
    password: str
    agree_to_terms: bool

# Модель ответа
class ClientRegistrationResponse(BaseModel):
    success: bool
    message: str
    client_id: Optional[str] = None
    error: Optional[str] = None

# Модель для регистрации таксиста
class TaxiRegistration(BaseModel):
    name: str
    surname: str
    phone: str
    password: str
    car_name: str
    car_year: int
    car_number: str
    tech_passport: str
    driver_license: str
    car_photo: str  # base64
    driver_license_photo: str  # base64
    tech_passport_photo: str  # base64
    face_photo: str  # base64
    last_lat: Optional[float] = None
    last_lng: Optional[float] = None
    agree_to_terms: bool

# Модель ответа для таксиста
class TaxiRegistrationResponse(BaseModel):
    success: bool
    message: str
    driver_id: Optional[str] = None
    error: Optional[str] = None

# Модель запроса для входа
class ClientLogin(BaseModel):
    phone: str
    password: str
    agree_to_terms: bool

# Модель ответа для входа
class ClientLoginResponse(BaseModel):
    success: bool
    message: str
    error: str = None
    client_id: str = None

# Модель для изменения статуса активности таксиста
class TaxiUpdateStatus(BaseModel):
    last_lat: Optional[float] = None
    last_lng: Optional[float] = None
    status: str

# Модель для ответа на статуса активности таксиста
class TaxiUpdateStatusResponse(BaseModel):
    success: float
    message: str
    error: Optional[str] = None

# Модель для получения статуса таксиста
class TaxiGetStatus(BaseModel):
    last_lat: Optional[float] = None
    last_lng: Optional[float] = None

# Модель для ответа на получение статуса активности таксиста
class TaxiGetStatusResponse(BaseModel):
    success: float
    message: str
    status: str
    driver_id: str
    error: Optional[str] = None

# Модель для отмены заказа
class CancelOrderRequest(BaseModel):
    order_id: int
    reason_text: str
    reason_type: str # 'radio' | 'custom'
    user_type: str   # "client" | "driver"
    idempotency_key: Optional[str] = None

# Модель для получения занятых поехдок
# class BusyTripRequest(BaseModel):
#     trip_id: int
#     user_type: str  # "client" / "driver"


class MeProfileUpdate(BaseModel):
    """Частичное обновление профиля; на сервере применяется только whitelist по роли."""

    model_config = ConfigDict(extra="ignore")

    name: Optional[str] = None
    surname: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    new_password: Optional[str] = None
    photo: Optional[str] = None
    car_name: Optional[str] = None
    car_year: Optional[int] = None
    car_number: Optional[str] = None
    car_tech_passport: Optional[str] = None
    driver_license: Optional[str] = None
    car_front_photo: Optional[str] = None
    driver_license_photo: Optional[str] = None
    car_tech_photo: Optional[str] = None
    face_photo: Optional[str] = None
    anonymous_profile: Optional[bool] = None