// ============================================
// TAXI SERVICES - Refactored Architecture
// ============================================

/**
 * Socket.IO транспорт (раньше чистый WebSocket). События с сервера = имена событий;
 * запросы к серверу идут через emit('message', payload) с ACK.
 */
class WebSocketManager {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.messageHandlers = new Map();
        this.pendingMessages = [];
        this._processedEventIds = new Set();
        this._ackedEventIds = new Set();
        this._serverPushEvents = [
            'connected', 'price_per_km', 'taxi_status', 'taxi_status_updated',
            'new_trip', 'client_trips_for_profile', 'confirmation_trip', 'update_trip_state',
            'view_trip_for_client', 'trip_dispatch_waiting_hint',
            'map_radars', 'trip_cancelled', 'trip_searching_resumed',
            'pending_trips',
            'location_updated', 'trip_peer_location', 'error', 'pong',
            'session_revoked',
        ];
    }

    async connect() {
        if (typeof io === 'undefined') {
            console.error('[Socket.IO] Клиентская библиотека не загружена (socket.io.min.js)');
            return;
        }

        if (this.socket?.connected) {
            console.log('[Socket.IO] Уже подключено');
            return;
        }

        try {
            const response = await fetch('/api/session-token', { credentials: 'include' });
            if (!response.ok) {
                throw new Error('Failed to get session token');
            }
            const data = await response.json();
            const sessionToken = data.token;

            if (this.socket) {
                this.socket.removeAllListeners();
                this.socket.disconnect();
            }

            this.socket = io(window.location.origin, {
                path: '/socket.io',
                transports: ['polling', 'websocket'],
                auth: { token: sessionToken },
                reconnectionAttempts: 8,
                reconnectionDelay: 2000,
                timeout: 20000,
            });

            this.socket.on('connect', () => {
                console.log('[Socket.IO] Подключено');
                this.isConnected = true;
                this._processedEventIds?.clear();
                this.flushPendingMessages();
                this.emit('connected');
                this._requestTripResync();
                this._restoreGpsAfterReconnect();
                this.getMapRadars();
            });

            if (this.socket.io && typeof this.socket.io.on === 'function') {
                this.socket.io.on('reconnect', () => {
                    console.log('[Socket.IO] Восстановление сессии после reconnect');
                    this.flushPendingMessages();
                    this._requestTripResync();
                    this._restoreGpsAfterReconnect();
                });
            }

            this.socket.on('disconnect', (reason) => {
                console.log('[Socket.IO] Отключено', reason);
                this.isConnected = false;
                this.emit('disconnected');
            });

            this.socket.on('connect_error', (err) => {
                console.error('[Socket.IO] connect_error', err?.message || err);
            });

            this._serverPushEvents.forEach((evt) => {
                this.socket.on(evt, (payload) => {
                    const merged = payload && typeof payload === 'object'
                        ? { type: evt, ...payload }
                        : { type: evt, payload };
                    this.handleMessage(merged);
                });
            });
        } catch (error) {
            console.error('[Socket.IO] Connection error:', error);
        }
    }

    _requestTripResync() {
        const tripId = window.taxiApp?.activeOrder?.trip_id;
        if (!tripId || !this.socket?.connected) return;
        this.socket.timeout(10000).emit('message', { type: 'sync_request', trip_id: tripId }, (err, res) => {
            if (err || !res?.ok || !res.snapshot) return;
            if (window.taxiApp?.applyTripSyncFromServer) {
                window.taxiApp.applyTripSyncFromServer(res.snapshot);
            } else {
                this.emit('trip_snapshot', res.snapshot);
            }
        });
    }

    _restoreGpsAfterReconnect() {
        try {
            if (!window.taxiApp?.activeOrder?.trip_id) return;
            const ts = window.taxiServices;
            if (ts && typeof ts.restoreGpsAfterSocketReconnect === 'function') {
                ts.restoreGpsAfterSocketReconnect();
            }
        } catch (e) {
            console.warn('[Socket.IO] restore GPS:', e);
        }
    }

    _sendEventAckWithRetry(eventId) {
        if (!eventId || !this.socket?.connected) return;
        if (!this._ackedEventIds) this._ackedEventIds = new Set();
        if (this._ackedEventIds.has(eventId)) return;
        let attempts = 0;
        const max = 3;
        const run = () => {
            if (!this.socket?.connected || this._ackedEventIds.has(eventId)) return;
            attempts += 1;
            this.socket.timeout(12000).emit('message', { type: 'event_ack', event_id: eventId }, (err, res) => {
                if (!err && res && res.type === 'event_ack_ok') {
                    this._ackedEventIds.add(eventId);
                    return;
                }
                if (attempts < max) setTimeout(run, 700 * attempts);
            });
        };
        run();
    }

    handleMessage(data) {
        if (!data || !data.type) return;
        if (data.type === 'event_ack_ok') {
            if (data.event_id) {
                if (!this._ackedEventIds) this._ackedEventIds = new Set();
                this._ackedEventIds.add(data.event_id);
            }
            return;
        }
        if (data.event_id) {
            if (!this._processedEventIds) this._processedEventIds = new Set();
            if (this._processedEventIds.has(data.event_id)) return;
        }
        console.log('[Socket.IO] Сообщение:', data.type, data);
        const handlers = this.messageHandlers.get(data.type) || [];
        handlers.forEach((handler) => {
            try {
                handler(data);
            } catch (error) {
                console.error(`[Socket.IO] Handler error for ${data.type}:`, error);
            }
        });
        if (data.event_id) {
            if (this._processedEventIds.size > 800) this._processedEventIds.clear();
            this._processedEventIds.add(data.event_id);
        }
        if (data.ack_required && data.event_id) {
            this._sendEventAckWithRetry(data.event_id);
        }
    }

    send(message) {
        if (!this.socket || !this.socket.connected) {
            console.warn('[Socket.IO] Нет соединения, в очередь');
            this.pendingMessages.push(message);
            return false;
        }
        // Частые location_update не ждём ACK — иначе очередь копится и координаты «летают» раз в несколько секунд.
        if (message && message.type === 'location_update') {
            try {
                this.socket.emit('message', message);
            } catch (e) {
                console.warn('[Socket.IO] emit location_update', e);
                return false;
            }
            return true;
        }
        this.socket.timeout(15000).emit('message', message, (err, response) => {
            if (err) {
                console.warn('[Socket.IO] Нет ACK от сервера', err);
                return;
            }
            if (response) this.handleMessage(response);
        });
        return true;
    }

    flushPendingMessages() {
        while (this.pendingMessages.length > 0) {
            const message = this.pendingMessages.shift();
            this.send(message);
        }
    }

    on(messageType, handler) {
        if (!this.messageHandlers.has(messageType)) {
            this.messageHandlers.set(messageType, []);
        }
        this.messageHandlers.get(messageType).push(handler);
    }

    off(messageType, handler) {
        if (!this.messageHandlers.has(messageType)) return;
        const handlers = this.messageHandlers.get(messageType);
        const index = handlers.indexOf(handler);
        if (index > -1) handlers.splice(index, 1);
    }

    emit(eventName, data = null) {
        const handlers = this.messageHandlers.get(eventName) || [];
        handlers.forEach((handler) => handler(data));
    }

    disconnect() {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
        this.isConnected = false;
        this.messageHandlers.clear();
        this.pendingMessages = [];
    }

    // API методы
    updateLocation(lat, lng) {
        if (window.taxiApp.activeOrder) {
            const tripData = window.taxiApp.activeOrder;
            const plat = tripData.pickup_lat ?? tripData.start_lat;
            const plng = tripData.pickup_lon ?? tripData.start_lon;
            const distance = window.appControllers.getDistanceInMeters(lat, lng, plat, plng);
            
            console.log('[&] Поездка найдена, дистанция от клиента:', distance)
    
            if (localStorage.getItem('userType') === 'driver') {
                const tid = Number(tripData.trip_id);
                if (!window.taxiApp._tripProximityUi || window.taxiApp._tripProximityUi.tripId !== tid) {
                    window.taxiApp._tripProximityUi = {
                        tripId: tid,
                        arrivedPressed: false,
                        onboardPressed: false,
                        destinationArrivedPressed: false,
                    };
                }
                const ui = window.taxiApp._tripProximityUi;
                if (ui.destinationArrivedPressed === undefined) {
                    ui.destinationArrivedPressed = false;
                }
                if (!ui.arrivedPressed) {
                    if (distance <= 80) {
                        const ob = document.getElementById('order-progress-cancel-button');
                        const mb = document.getElementById('order-modal-cancel-button');
                        if (ob) ob.style.display = 'none';
                        if (mb) mb.style.display = 'flex';
                        window.appControllers.showArrivedButton(true);
                    } else {
                        window.appControllers.showArrivedButton(false);
                        const ob = document.getElementById('order-progress-cancel-button');
                        const mb = document.getElementById('order-modal-cancel-button');
                        if (mb) mb.style.display = 'none';
                        if (ob) ob.style.display = 'flex';
                    }
                }
                const leg =
                    typeof window.normalizeTripLegState === 'function'
                        ? window.normalizeTripLegState(tripData.state || '')
                        : String(tripData.state || '');
                const ac = window.appControllers;
                if (
                    ac &&
                    (leg === 'in_progress' || leg === 'progress' || leg === 'paused') &&
                    !ui.destinationArrivedPressed
                ) {
                    const elat = parseFloat(tripData.end_lat);
                    const elng = parseFloat(tripData.end_lon);
                    if (!Number.isNaN(elat) && !Number.isNaN(elng)) {
                        const dEnd = ac.getDistanceInMeters(lat, lng, elat, elng);
                        if (dEnd <= 80) {
                            ac.showDestinationArrivedButton(true);
                        } else {
                            ac.showDestinationArrivedButton(false);
                        }
                    }
                } else if (ac?.showDestinationArrivedButton) {
                    ac.showDestinationArrivedButton(false);
                }
            }

        } else {console.log('[&] Поездка не найдена!')}


        if (window.taxiApp?.radarsClass) {
            if (window.taxiServices.settings.get().roadCams) {
                window.taxiApp.radarsClass.addNearbyCameras(lat, lng, 1000);
            }

        } else {
            console.warn("[WS] radarsClass ещё не инициализирован, не могу обновить радары");
        }
        return this.send({ type: 'location_update', lat, lng });
    }

    getTaxiStatus() {
        return this.send({ type: 'get_taxi_status' });
    }

    getTripsForProfile() {
        return this.send({ type: 'get_client_trips' });
    }

    updateTaxiStatus(status, lat = null, lng = null) {
        return this.send({ type: 'update_taxi_status', status, lat, lng });
    }

    getPrice() {
        return this.send({ type: 'get_price' });
    }

    getPendingTrips() {
        return this.send({ type: 'get_pending_trips' });
    }

    getMapRadars() {
        console.log('[WS - getMapRadars] Получение радаров для карты');
        return this.send({ type: 'get_map_radars' });
    }
}

/**
 * HTTP Service - HTTP API запросы
 */
class HTTPService {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
    }

    /** POST-мутации поездки/заказа: при офлайне не бросаем исключение, а отдаём { offline: true }. */
    _isCriticalTripMutation(endpoint, method) {
        const m = (method || 'GET').toUpperCase();
        if (m !== 'POST') return false;
        if (endpoint.includes('/api/confirmation/trip')) return true;
        if (endpoint.includes('/api/check/trip')) return true;
        if (endpoint.includes('/api/trip/state')) return true;
        if (endpoint.includes('/api/orders/cancel')) return true;
        if (endpoint.includes('/api/trips/driver-release-awaiting-client')) return true;
        if (endpoint.includes('/api/trips/client-dispatch-boost')) return true;
        if (endpoint.includes('/api/trips/driver-decline-offer')) return true;
        if (endpoint === '/api/orders' || endpoint.endsWith('/api/orders')) return true;
        return false;
    }

    _offlineResponse(extra = {}) {
        return {
            offline: true,
            network: false,
            success: false,
            message: 'Нет сети. Действие недоступно.',
            ...extra,
        };
    }

    async request(endpoint, options = {}) {
        const { headers: optHeaders, ...restOptions } = options;
        const url = `${this.baseUrl}${endpoint}`;
        const method = (restOptions.method || 'GET').toUpperCase();
        const critical = this._isCriticalTripMutation(endpoint, method);

        if (critical && typeof navigator !== 'undefined' && navigator.onLine === false) {
            return this._offlineResponse();
        }

        const config = {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...(optHeaders || {}),
            },
            ...restOptions,
        };

        try {
            const response = await fetch(url, config);
            const text = await response.text();
            let data = null;
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch (_) {
                    data = null;
                }
            }

            if (data && data.offline === true) {
                return {
                    ...data,
                    success: data.success === undefined ? false : data.success,
                };
            }

            if (!response.ok) {
                let detail = response.statusText;
                if (data && typeof data.message === 'string') detail = data.message;
                else if (data && typeof data.detail === 'string') detail = data.detail;
                else if (data && Array.isArray(data.detail)) {
                    detail = data.detail
                        .map((d) =>
                            d && typeof d.msg === 'string'
                                ? d.msg
                                : d && typeof d.message === 'string'
                                  ? d.message
                                  : JSON.stringify(d)
                        )
                        .join('; ');
                }
                throw new Error(`HTTP ${response.status}: ${detail}`);
            }

            if (data !== null) return data;
            return {};
        } catch (error) {
            const offlineish =
                critical &&
                (typeof navigator !== 'undefined' && navigator.onLine === false
                    || (error && error.name === 'TypeError'));
            if (offlineish) {
                console.warn(`[HTTP] Offline / сеть для ${endpoint}:`, error?.message || error);
                return this._offlineResponse();
            }
            console.error(`[HTTP] Request failed for ${endpoint}:`, error);
            throw error;
        }
    }

    // API методы
    async createOrder(orderData) {
        return this.request('/api/orders', {
            method: 'POST',
            body: JSON.stringify(orderData)
        });
    }

    async submitTripPeerRating(tripId, stars, reasons) {
        const tags = Array.isArray(reasons) ? reasons.filter((x) => typeof x === 'string') : [];
        return this.request('/api/trip/rate', {
            method: 'POST',
            body: JSON.stringify({
                trip_id: Number(tripId),
                stars: Number(stars),
                reasons: tags,
            }),
        });
    }

   async updateTripState(state = 'driver_arrived', trip_id = null) {
        const idempotency_key =
            typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        return this.request(`/api/trip/state`, {
            method: 'POST',
            body: JSON.stringify({
                state,
                trip_id: trip_id,
                idempotency_key,
            }),
            headers: { 'Idempotency-Key': idempotency_key },
        });
    }

    async confirmTrip(tripData) {
        return this.request('/api/confirmation/trip', {
            method: 'POST',
            body: JSON.stringify(tripData)
        });
    }

    async checkTrip(tripData) {
        const body = { ...tripData };
        if (!body.idempotency_key) {
            body.idempotency_key =
                typeof crypto !== 'undefined' && crypto.randomUUID
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        }
        return this.request('/api/check/trip', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Idempotency-Key': body.idempotency_key },
        });
    }

    async driverReleaseAwaitingClient(tripId) {
        return this.request('/api/trips/driver-release-awaiting-client', {
            method: 'POST',
            body: JSON.stringify({ trip_id: Number(tripId) }),
        });
    }

    async clientDispatchBoost(tripId) {
        return this.request('/api/trips/client-dispatch-boost', {
            method: 'POST',
            body: JSON.stringify({ trip_id: Number(tripId) }),
        });
    }

    async driverDeclineOffer(tripId, reason = 'decline') {
        return this.request('/api/trips/driver-decline-offer', {
            method: 'POST',
            body: JSON.stringify({ trip_id: Number(tripId), reason: String(reason || 'decline') }),
        });
    }

    /** Положительный trip_id / order_id для API (иначе Number('') → NaN → JSON null → 422). */
    _parsePositiveOrderId(value) {
        if (value == null || value === '') return null;
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return Math.trunc(value);
        }
        const s = String(value).trim();
        if (!s) return null;
        const n = parseInt(s, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    async cancelOrder(orderId, userType, reasonType, reasonText) {
        const order_id = this._parsePositiveOrderId(orderId);
        if (order_id == null) {
            return {
                success: false,
                message: 'Не указан номер поездки. Создайте заказ заново или обновите страницу.',
                code: 'INVALID_ORDER_ID',
            };
        }
        const idempotency_key =
            typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        const body = {
            order_id,
            user_type: userType,
            reason_text: reasonText != null ? String(reasonText) : '',
            reason_type: reasonType != null ? String(reasonType) : 'radio',
            idempotency_key,
        };
        const result = await this.request('/api/orders/cancel', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Idempotency-Key': idempotency_key },
        });
        if (result?.success) {
            window.taxiApp.activeOrder = null;
            if (window.taxiApp) window.taxiApp._tripProximityUi = null;
            window.taxiApp.syncClientPickupMarkerDrag?.();
        }
        return result;
    }

    async getUserProfile() {
        return this.request('/api/me', { method: 'POST' });
    }

    async updateTaxiStatus(status, lat, lng) {
        return this.request('/api/taxi-status', {
            method: 'POST',
            body: JSON.stringify({ status, last_lat: lat, last_lng: lng })
        });
    }

    async getTaxiStatus() {
        return this.request('/api/taxi-status', { method: 'GET' });
    }

    async getBusyTrip() {
        return this.request('/api/trip/busy', { method: 'GET' });
    }

    async getActiveTrip() {
        return this.request('/api/trip/active', { method: 'GET' });
    }

    async getDriverInfo(driverId) {
        return this.request(`/api/drivers/${driverId}`, { method: 'GET' });
    }

    async getOrderStatus(orderId) {
        return this.request(`/api/orders/${orderId}/status`, { method: 'GET' });
    }
}

/**
 * Taxi Service Manager - главный координатор
 */
class TaxiServiceManager {
    constructor() {
        this.wsService = new WebSocketManager();
        this.httpService = new HTTPService();
        this.pricePerKm = 0.00;
        this.eventHandlers = new Map();
        
        this.setupWebSocketHandlers();
    }

    setupWebSocketHandlers() {
        // Обработчик подключения
        this.wsService.on('connected', (data) => {
            console.log('[Service] WebSocket connected');
            this.wsService.getPrice();
            this.emit('initialized');
            if (
                (localStorage.getItem('userType') || '') === 'driver' &&
                window.taxiApp &&
                typeof window.taxiApp.refreshDriverNotificationFromServer === 'function'
            ) {
                void window.taxiApp.refreshDriverNotificationFromServer();
            }
        });

        // Обработчик цены
        this.wsService.on('price_per_km', (data) => {
            this.pricePerKm = data.price;
            this.emit('price_updated', this.pricePerKm);
        });

        // Обработчик статуса такси
        this.wsService.on('taxi_status', (data) => {
            if (data.status) {
                this.updateTaxiStatusUI(data.status);
            }
        });

        // Обработчик новой поездки
        this.wsService.on('new_trip', (data) => {
            this.emit('new_trip', data.trip);
        });

        // Обработчик получения поездок для профиля 
        this.wsService.on('client_trips_for_profile', (data) => {
            this.emit('client_trips_for_profile', data.profile.trips);
        });

        // Обработчик подтверждения поездки
        this.wsService.on('confirmation_trip', (data) => {
            this.emit('confirmation_trip', data);
        });

        // Обработчик обновлении состоянии поездки
        this.wsService.on('update_trip_state', (data) => {
            this.emit('update_trip_state', data);
        });

        // Обработчик просмотра поездки для клиента
        this.wsService.on('view_trip_for_client', (data) => {
            this.emit('view_trip_for_client', data);
        });

        this.wsService.on('trip_dispatch_waiting_hint', (data) => {
            this.emit('trip_dispatch_waiting_hint', data);
        });

        // Обработчик получения радаров для карты
        this.wsService.on('map_radars', (data) => {
            console.log('[WS - map_radars] Получены радары с сервера', data.radars);

            if (window.taxiApp?.radarsClass) {
                window.taxiApp.radarsClass.setRadars(data.radars);
                console.log('[WS - map_radars] Рдары обновлены на карте');
            } else {
                console.warn('radarsClass ещё не инициализирован');
            }
        });

        // Обработчик отмены поездки
        this.wsService.on('trip_cancelled', (data) => {
            this.emit('trip_cancelled', data);
        });

        this.wsService.on('trip_searching_resumed', (data) => {
            this.emit('trip_searching_resumed', data);
        });

        this.wsService.on('trip_peer_location', (data) => {
            this.emit('trip_peer_location', data);
        });

        this.wsService.on('session_revoked', () => {
            void (async () => {
                try {
                    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
                } catch (_) { /* ignore */ }
                try {
                    this.wsService.disconnect();
                } catch (_) { /* ignore */ }
                try {
                    localStorage.removeItem('userType');
                    localStorage.removeItem('userID');
                    localStorage.removeItem('taxiNotificationStatus');
                } catch (_) { /* ignore */ }
                window.location.reload();
            })();
        });
    }

    async initialize() {
        await this.wsService.connect();
        
    }

    // Event system
    on(eventName, handler) {
        if (!this.eventHandlers.has(eventName)) {
            this.eventHandlers.set(eventName, []);
        }
        this.eventHandlers.get(eventName).push(handler);
    }

    off(eventName, handler) {
        if (!this.eventHandlers.has(eventName)) return;
        
        const handlers = this.eventHandlers.get(eventName);
        const index = handlers.indexOf(handler);
        if (index > -1) {
            handlers.splice(index, 1);
        }
    }

    emit(eventName, data = null) {
        const handlers = this.eventHandlers.get(eventName) || [];
        handlers.forEach(handler => {
            try {
                handler(data);
            } catch (error) {
                console.error(`[Service] Event handler error for ${eventName}:`, error);
            }
        });
    }

    // Публичные методы
    updateLocation(lat, lng) {
        return this.wsService.updateLocation(lat, lng);
    }

    getTaxiStatus() {
        return this.wsService.getTaxiStatus();
    }

    getTripsForProfile() {
        return this.wsService.getTripsForProfile();
    }

    setTaxiStatus(status, lat = null, lng = null) {
        return this.wsService.updateTaxiStatus(status, lat, lng);
    }

    createOrder(orderData) {
        return this.httpService.createOrder(orderData);
    }

    confirmTrip(tripData) {
        return this.httpService.confirmTrip(tripData);
    }

    checkTrip(tripData) {
        return this.httpService.checkTrip(tripData);
    }

    driverReleaseAwaitingClient(tripId) {
        return this.httpService.driverReleaseAwaitingClient(tripId);
    }

    clientDispatchBoost(tripId) {
        return this.httpService.clientDispatchBoost(tripId);
    }

    driverDeclineOffer(tripId, reason) {
        return this.httpService.driverDeclineOffer(tripId, reason);
    }

    getBusyTrip() {
        return this.httpService.getBusyTrip();
    }

    getActiveTrip() {
        return this.httpService.getActiveTrip();
    }

    cancelOrder(orderId, userType, reasonType, reasonText) {
        return this.httpService.cancelOrder(orderId, userType, reasonType, reasonText);
    }

    updateTripState(state, trip_id) {
        return this.httpService.updateTripState(state, trip_id);
    }

    async submitTripPeerRating(tripId, stars, reasons) {
        return this.httpService.submitTripPeerRating(tripId, stars, reasons);
    }

    getUserProfile() {
        return this.httpService.getUserProfile();
    }

    getDriverInfo(driverId) {
        return this.httpService.getDriverInfo(driverId);
    }

    getOrderStatus(orderId) {
        return this.httpService.getOrderStatus(orderId);
    }

    updateTaxiStatusUI(status) {
        if (window.taxiApp && typeof window.taxiApp.updateTaxiStatusUI === 'function') {
            window.taxiApp.updateTaxiStatusUI(status);
            return;
        }
        const button = document.querySelector('.taxi-notification-button');
        if (!button) return;

        button.classList.remove('offline', 'available', 'spinner');
        const s = String(status || '').toLowerCase();

        if (s === 'spinner' || s === 'loading') {
            button.classList.add('spinner');
            return;
        }
        if (s === 'available' || s === 'busy') {
            button.classList.add('available');
            button.dataset.driverPresence = s === 'busy' ? 'busy' : 'available';
            localStorage.setItem('taxiNotificationStatus', 'available');
        } else if (s === 'offline') {
            button.classList.add('offline');
            button.dataset.driverPresence = 'offline';
            localStorage.setItem('taxiNotificationStatus', 'offline');
        } else {
            button.classList.add('offline');
            button.dataset.driverPresence = 'offline';
            localStorage.setItem('taxiNotificationStatus', 'offline');
        }
    }

    cleanup() {
        this.wsService.disconnect();
        this.eventHandlers.clear();
    }
}

// Singleton instance
let taxiServiceInstance = null;

function getTaxiService() {
    if (!taxiServiceInstance) {
        taxiServiceInstance = new TaxiServiceManager();
    }
    return taxiServiceInstance;
}

// Export для использования в других файлах
window.getTaxiService = getTaxiService;
