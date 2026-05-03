// ============================================
// SERVICES ADAPTER - Backward Compatibility
// ============================================

/**
 * Адаптер для обратной совместимости с существующим кодом
 * Обеспечивает переход на новую архитектуру без изменения старого кода
 */
class TaxiServicesAdapter {
    constructor() {
        this.service = getTaxiService();
        this.ws = this.service.wsService;
        this.http = this.service.httpService;
        this.pricePerKm = 0.00;
        /** @type {number|null} */
        this._clientTripWatchId = null;
        /** Throttle отправки координат по сокету (секунды / метры). */
        this._geoSentAt = 0;
        this._geoSentLat = null;
        this._geoSentLng = null;
        this._lastKnownLat = null;
        this._lastKnownLng = null;
        /** @type {ReturnType<typeof setInterval>|null} */
        this._heartbeatTimer = null;

        this.settings = {
            get() {return JSON.parse(localStorage.getItem('settings')) || {};},
            set(newSettings) {localStorage.setItem('settings', JSON.stringify(newSettings));},
            update(key, value) {const settings = this.get(); settings[key] = value; this.set(settings);}
        };
        
        this.setupEventHandlers();
        this.initialize();
    }
    
    setupEventHandlers() {
        // Обновление цены
        this.service.on('price_updated', (price) => {
            this.pricePerKm = price;
        });
        
        // Новая поездка
        this.service.on('new_trip', (trip) => {
            this.handleNewTrip(trip);
        });
        
        // Подтверждение поездки
        this.service.on('confirmation_trip', (data) => {
            this.handleConfirmationTrip(data);
        });
        
        // Получение поездок для профиля
        this.service.on('client_trips_for_profile', (trips) => {
            this.handleClientTripsForProfile(trips);
        });

        // Просмотр поездки для клиента
        this.service.on('view_trip_for_client', (data) => {
            this.handleViewTripForClient(data);
        });
        
        // Отмена поездки
        this.service.on('trip_cancelled', (data) => {
            void this.handleTripCancelled(data).catch((e) => console.error('[Adapter] trip_cancelled', e));
        });

        this.service.on('trip_searching_resumed', (data) => {
            void this.handleTripSearchingResumed(data).catch((e) =>
                console.error('[Adapter] trip_searching_resumed', e)
            );
        });

        this.service.on('trip_dispatch_waiting_hint', (data) => {
            void this.handleTripDispatchWaitingHint(data).catch((e) =>
                console.error('[Adapter] trip_dispatch_waiting_hint', e)
            );
        });

        // Обновление состоянии позедки
        this.service.on('update_trip_state', (data) => {
            this.updateTripStateUI(data);
        });

        this.service.on('trip_peer_location', (data) => {
            this.handleTripPeerLocation(data);
        });
    }
    
    async initialize() {
        await this.service.initialize();
    }
    
    // ========================================
    // Обработчики событий
    // ========================================
    
    handleNewTrip(trip) {
        console.log('[Adapter] New trip received:', trip);
        
        const taxiStatus = localStorage.getItem("taxiNotificationStatus");
        const userType = localStorage.getItem("userType");
        
        if (taxiStatus === "available" && userType === "driver") {
            if (window.taxiControlles && window.taxiControlles.showTripOrder) {
                window.taxiControlles.showTripOrder({
                    taxi_lat: window.taxiApp?.fromMarker?.getLatLng()?.lat || 0,
                    taxi_lon: window.taxiApp?.fromMarker?.getLatLng()?.lng || 0,
                    start_lat: trip.start_lat,
                    start_lon: trip.start_lon,
                    end_lat: trip.end_lat,
                    end_lon: trip.end_lon,
                    time: trip.driving_time,
                    start_address: trip.start_address,
                    end_address: trip.end_address,
                    price: trip.price,
                    distance: trip.distance,
                    clientName: trip.client_name,
                    clientRating: trip.client_rating,
                    clientID: trip.client_id,
                    tripID: trip.trip_id,
                    clientPhoto: trip.client_photo
                });
            }
        }
    }
    
    async handleConfirmationTrip(data) {
        console.log('[Adapter] Confirmation trip:', data);

        // Сервер после подтверждения клиентом шлёт status: "busy"; ранее ожидали только "accepted".
        if (!data?.trip) return;
        if (data.success === false) return;
        const st = data.status;
        if (st && st !== 'accepted' && st !== 'busy') return;

        const userId = localStorage.getItem("userID");
        if (!userId) return;

        const trip = data.trip;
        
        if (Number(trip.client_id) === Number(userId)) {
            console.log('[Adapter] Confirmation for CLIENT');
            if (window.appControllers && window.appControllers.confirmationTrip) {
                await window.appControllers.confirmationTrip(trip, 'client');
                this._startClientTripLocationShare();
            }
        } else if (Number(trip.driver_id) === Number(userId)) {
            console.log('[Adapter] Confirmation for DRIVER');
            if (window.appControllers && window.appControllers.confirmationTrip) {
                window.taxiApp.startDriverLocationTracking();
                await window.appControllers.confirmationTrip(trip, 'driver');
            }
        }
    }

    /**
     * Сброс UI после завершения поездки (и после своей оценки, пока второй не оценил).
     * Идемпотентно: повторные вызовы безопасны.
     * @param {{ afterLocalPeerRating?: boolean }} [opts]
     */
    applyFinishedTripLegCleanup(opts = {}) {
        const ao = window.taxiApp?.activeOrder;
        const tid =
            ao?.trip_id != null && ao.trip_id !== ""
                ? Number(ao.trip_id)
                : NaN;
        if (opts.afterLocalPeerRating && Number.isFinite(tid) && window.taxiApp) {
            if (!window.taxiApp._postRatingLocalEndTripIds) {
                window.taxiApp._postRatingLocalEndTripIds = new Set();
            }
            window.taxiApp._postRatingLocalEndTripIds.add(tid);
        }
        window.taxiApp?.closeTripRatingModal?.();
        window.taxiApp._ratingModalShownForTripId = null;
        window.taxiApp._geoWatchLegForDriver = undefined;
        window.taxiApp.activeOrder = null;
        window.taxiApp._tripProximityUi = null;
        window.taxiApp.syncClientPickupMarkerDrag?.();
        window.taxiApp.stopDriverLocationTracking();
        this._stopClientTripLocationShare();
        if (window.appControllers) {
            window.appControllers._activeChauffeurTripId = null;
        }
        if (window.appControllers?.applyPostTripCancelNav) {
            window.appControllers.applyPostTripCancelNav();
        }
        try {
            window.JITripOfflineCache?.clear?.();
        } catch (_) {
            /* ignore */
        }
    }

    updateTripStateUI(data) {
        console.log('[Adapter] Update trip state:', data);

        const userId = localStorage.getItem("userID");
        if (!userId) return;
        
        const trip = data.trip;
        if (!trip) return;
        const isParticipant =
            Number(trip.client_id) === Number(userId) || Number(trip.driver_id) === Number(userId);
        if (!isParticipant) return;

        const tid = trip.trip_id != null ? Number(trip.trip_id) : NaN;
        const legRaw = trip.state;
        const leg =
            typeof window.normalizeTripLegState === "function"
                ? window.normalizeTripLegState(legRaw)
                : legRaw;
        if (
            leg === "at_destination" &&
            Number.isFinite(tid) &&
            window.taxiApp?._postRatingLocalEndTripIds?.has(tid)
        ) {
            return;
        }

        const active = window.taxiApp?.activeOrder;
        if (active && !Number.isNaN(tid) && Number(active.trip_id) === tid) {
            Object.assign(active, trip);
            window.taxiApp.syncClientPickupMarkerDrag?.();
        }

        window.taxiApp?.updateTripStateUI(trip.state);

        try {
            if (window.JITripOfflineCache && trip && trip.trip_id != null) {
                window.JITripOfflineCache.save({
                    trip_id: trip.trip_id,
                    state: trip.state,
                    status: trip.status,
                    start_lat: trip.start_lat,
                    start_lon: trip.start_lon,
                    end_lat: trip.end_lat,
                    end_lon: trip.end_lon,
                    start_address: trip.start_address,
                    end_address: trip.end_address,
                    taxi_lat: trip.taxi_lat,
                    taxi_lon: trip.taxi_lon,
                });
            }
        } catch (_) {
            /* ignore */
        }

        if (leg === 'at_destination') {
            window.taxiApp?.openTripRatingModalIfNeeded?.();
        }
        if (leg === 'finished') {
            window.taxiApp?._postRatingLocalEndTripIds?.delete(tid);
            this.applyFinishedTripLegCleanup();
        }
    }

    async handleClientTripsForProfile(trips) {
        console.log('[Adapter] Client trips for profile:', trips);
        await window.profileManager?.setPendingTrips(trips);
    }
    
    async handleViewTripForClient(data) {
        console.log('[Adapter] View trip for client:', data);
        
        const userId = localStorage.getItem("userID");
        const trip = data.trip;
        
        if (trip.for === "client" && Number(trip.client_id) === Number(userId)) {
            if (window.appControllers && window.appControllers.viewTripData) {
                await window.appControllers.viewTripData(
                    trip.trip_id, trip.client_id, trip.driver_id,
                    trip.taxi_avatar, trip.taxi_car_name, trip.taxi_car_number,
                    trip.taxi_car_photo, trip.taxi_lat, trip.taxi_lon,
                    trip.start_lat, trip.start_lon, trip.end_lat, trip.end_lon,
                    trip.distance, trip.price, trip.taxi_name, trip.taxi_rating,
                    trip.driving_time, trip.taxi_car_year, trip.taxi_car_category,
                    trip.start_address, trip.end_address
                );
            }
        }
    }

    _haversineMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * true = не слать по сети (ещё рано по времени и мало сместились).
     * Промежуточные точки отбрасываются: на сервер уходит только «последняя значимая» после окна throttle.
     */
    _shouldThrottleGeo(lat, lng) {
        const lowBat = document.documentElement?.dataset?.jiBatteryLow === '1';
        const mult = lowBat ? 1.6 : 1;
        const MIN_INTERVAL_MS = Math.round(3800 * mult);
        const MIN_DIST_M = Math.round(14 * mult);
        const now = Date.now();
        if (this._geoSentLat == null || this._geoSentLng == null) return false;
        if (now - this._geoSentAt >= MIN_INTERVAL_MS) return false;
        return this._haversineMeters(lat, lng, this._geoSentLat, this._geoSentLng) < MIN_DIST_M;
    }

    _startTripLocationHeartbeat() {
        this._stopTripLocationHeartbeat();
        const lowBat = document.documentElement?.dataset?.jiBatteryLow === '1';
        const intervalMs = lowBat ? 32000 : 22000;
        this._heartbeatTimer = setInterval(() => {
            const ws = this.service?.wsService;
            if (!ws?.socket?.connected) return;
            const lat = this._lastKnownLat;
            const lng = this._lastKnownLng;
            if (lat == null || lng == null) return;
            ws.updateLocation(lat, lng);
        }, intervalMs);
    }

    _stopTripLocationHeartbeat() {
        if (this._heartbeatTimer != null) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    startDriverLocationHeartbeat() {
        this._startTripLocationHeartbeat();
    }

    stopDriverLocationHeartbeat() {
        this._stopTripLocationHeartbeat();
    }

    _startClientTripLocationShare() {
        this._stopClientTripLocationShare();
        if (localStorage.getItem('userType') !== 'client' || !navigator.geolocation) return;

        // В фоне (iOS PWA/Safari) watchPosition часто перестаёт обновляться — heartbeat шлёт последнюю точку.
        this._clientTripWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                this._lastKnownLat = lat;
                this._lastKnownLng = lng;
                if (this._shouldThrottleGeo(lat, lng)) return;
                this._geoSentAt = Date.now();
                this._geoSentLat = lat;
                this._geoSentLng = lng;
                this.service.updateLocation(lat, lng);
            },
            (err) => console.warn('[Adapter] client trip geolocation:', err),
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 18000 }
        );
        this._startTripLocationHeartbeat();
    }

    _stopClientTripLocationShare() {
        if (this._clientTripWatchId != null) {
            navigator.geolocation.clearWatch(this._clientTripWatchId);
            this._clientTripWatchId = null;
        }
        this._stopTripLocationHeartbeat();
    }

    handleTripPeerLocation(data) {
        const active = window.taxiApp?.activeOrder;
        if (!active || !data || Number(data.trip_id) !== Number(active.trip_id)) return;

        const role = localStorage.getItem('userType');
        const ac = window.appControllers;
        if (!ac) return;

        if (data.peer === 'driver' && role === 'client') {
            ac.applyRemoteDriverPosition(Number(data.lat), Number(data.lng));
        } else if (data.peer === 'client' && role === 'driver') {
            ac.applyRemoteClientPosition(Number(data.lat), Number(data.lng));
        }
    }
    
    _applyClientSearchingPriceToUi(priceNum) {
        if (!Number.isFinite(Number(priceNum))) return;
        const s = `${Number(priceNum).toFixed(2)} ₼`;
        if (window.taxiApp?.safeSetTextContent) {
            window.taxiApp.safeSetTextContent('additional-price', s);
            window.taxiApp.safeSetTextContent('client-totla-price', s);
            window.taxiApp.safeSetTextContent('additional-price-order', s);
            window.taxiApp.safeSetTextContent('client-totla-price-order', s);
        }
    }

    async handleTripDispatchWaitingHint(data) {
        if (localStorage.getItem('userType') !== 'client') return;
        const tid = data?.trip_id != null ? Number(data.trip_id) : NaN;
        if (!Number.isFinite(tid)) return;
        const active = window.taxiApp?.activeOrder;
        const cancelEl = document.getElementById('searching-cancel-button-client');
        const cancelTid = cancelEl?.dataset?.tripId != null ? Number(cancelEl.dataset.tripId) : NaN;
        const matchesTrip =
            (active && Number(active.trip_id) === tid) ||
            (!Number.isNaN(cancelTid) && cancelTid === tid);
        if (!matchesTrip) return;

        const row = document.getElementById('dispatch-wait-hint-row');
        const txt = document.getElementById('dispatch-wait-hint-text');
        const btn = document.getElementById('dispatch-wait-boost-btn');
        if (!row || !txt) return;
        txt.textContent =
            data?.message ||
            'Sürücü tapmaq şansını artırmaq üçün qiyməti artırmaq istəyirsiniz?';
        if (btn) {
            const pct = data?.boost_percent;
            const can = data?.can_boost !== false;
            btn.textContent = can
                ? pct != null && pct !== ''
                    ? `Şansı artırın (+${pct}%)`
                    : 'Şansı artırın'
                : 'Aktivdir';
            btn.disabled = !can;
            btn.onclick = async () => {
                if (btn.disabled) return;
                btn.disabled = true;
                try {
                    const res = await this.http.clientDispatchBoost(tid);
                    if (res?.success && res.price != null) {
                        this._applyClientSearchingPriceToUi(Number(res.price));
                        btn.disabled = true;
                        btn.textContent = 'Aktivdir';
                        btn.onclick = null;
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(res.message || 'Qiymət yeniləndi.', 'success');
                        }
                    } else {
                        btn.disabled = false;
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(res?.message || 'Əməliyyat uğursuz oldu', 'warning');
                        }
                    }
                } catch (e) {
                    btn.disabled = false;
                    console.error('[Adapter] clientDispatchBoost', e);
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast('Şəbəkə xətası. Daha sonra təkrarlayın.', 'error');
                    }
                }
            };
        }
        row.style.display = 'block';
    }

    async handleTripSearchingResumed(data) {
        const tid = data?.trip_id != null ? Number(data.trip_id) : NaN;
        if (localStorage.getItem('userType') !== 'client' || Number.isNaN(tid)) return;
        const active = window.taxiApp?.activeOrder;
        const cancelEl = document.getElementById('searching-cancel-button-client');
        const confirmEl = document.getElementById('order-taxi-confirm-button');
        const cancelTid = cancelEl?.dataset?.tripId != null ? Number(cancelEl.dataset.tripId) : NaN;
        const confirmTid = confirmEl?.dataset?.tripId != null ? Number(confirmEl.dataset.tripId) : NaN;
        const matchesTrip =
            (active && Number(active.trip_id) === tid) ||
            (!Number.isNaN(cancelTid) && cancelTid === tid) ||
            (!Number.isNaN(confirmTid) && confirmTid === tid);
        if (!matchesTrip) return;
        if (typeof window.showAppToast === 'function') {
            window.showAppToast(
                data?.message || 'Sürücü gözləməni ləğv etdi. Sürücü tapmaq şansını artırmaq üçün qiyməti artırmaq istəyirsiniz?',
                'info'
            );
        }
        if (window.taxiApp?.resumeClientTripSearchUi) {
            window.taxiApp.resumeClientTripSearchUi(tid);
        }
    }

    async handleTripCancelled(data) {
        console.log('[Adapter] Trip cancelled:', data);

        const tid = data?.trip_id != null ? Number(data.trip_id) : NaN;
        const active = window.taxiApp?.activeOrder;
        const sameTrip = active && !Number.isNaN(tid) && tid === Number(active.trip_id);
        if (sameTrip) {
            if (window.taxiApp) window.taxiApp._geoWatchLegForDriver = undefined;
            this._stopClientTripLocationShare();
            window.taxiApp.stopDriverLocationTracking();
            try {
                window.JITripOfflineCache?.clear?.();
            } catch (_) {
                /* ignore */
            }
        }

        const role = localStorage.getItem('userType');
        const uidRaw = localStorage.getItem('userID');
        const myId = uidRaw != null && uidRaw !== '' ? Number(uidRaw) : NaN;
        const cancelledRaw = data?.cancelled_user_id;
        const cancelledNum =
            cancelledRaw != null && cancelledRaw !== '' ? Number(cancelledRaw) : NaN;
        /** Сервер при отмене клиентом кладёт сюда driver_id назначенного водителя (контрагент). */
        const peerMatchesMe =
            Number.isFinite(cancelledNum) &&
            Number.isFinite(myId) &&
            cancelledNum === myId;

        const allowBtn = window.taxiControlles?.allowOrderButton;
        const offerTidRaw = allowBtn?.dataset?.tripId;
        const offerTid =
            offerTidRaw != null && String(offerTidRaw).trim() !== ''
                ? Number(offerTidRaw)
                : NaN;
        /** Клиент отменил поиск: trip_id совпадает с карточкой входящего заказа, cancelled_user_id может быть null. */
        const driverOfferCancelled =
            role === 'driver' &&
            Number.isFinite(tid) &&
            Number.isFinite(offerTid) &&
            offerTid === tid;

        const shouldResetMainUi = peerMatchesMe || driverOfferCancelled;

        if (shouldResetMainUi) {
            if (role === 'driver' && window.taxiControlles?.hideTripOfferPanel) {
                window.taxiControlles.hideTripOfferPanel();
            }
            await window.appControllers.toggleBottomNav('clear.class');
            if (window.appControllers.mapInstance?.map) {
                try {
                    window.appControllers.mapInstance.map.remove();
                } catch (_) {
                    /* ignore */
                }
            }
            window.appControllers.mapInstance = null;
            window.taxiApp.activeOrder = null;
            if (window.taxiApp) window.taxiApp._tripProximityUi = null;
            window.taxiApp.syncClientPickupMarkerDrag?.();
            window.taxiApp.resetMap();
            window.appControllers.applyPostTripCancelNav();
        }
    }
    
    // ========================================
    // Методы обратной совместимости
    // ========================================
    
    updateDriverLocation(lat, lng) {
        const ac = window.appControllers;

        if (localStorage.getItem('userType') === 'driver' && ac) {
            ac.applyRemoteDriverPosition(lat, lng);
        }

        this._lastKnownLat = lat;
        this._lastKnownLng = lng;
        if (this._shouldThrottleGeo(lat, lng)) {
            return;
        }
        this._geoSentAt = Date.now();
        this._geoSentLat = lat;
        this._geoSentLng = lng;
        return this.service.updateLocation(lat, lng);
    }

    getMapRadars() {
        return this.service.getMapRadars();
    }

    getBusyTrip() {
        return this.service.getBusyTrip();
    }

    /**
     * Восстановить активный заказ из БД (перезагрузка страницы / новая вкладка).
     */
    async restoreActiveOrderIfAny() {
        const uid = localStorage.getItem('userID');
        const role = localStorage.getItem('userType');
        if (!uid || !role) return;
        if (!navigator.onLine) {
            const snap = window.JITripOfflineCache?.load?.();
            if (snap) {
                console.info('[Adapter] Оффлайн: сохранённый снимок поездки', snap.trip_id);
                try {
                    window.dispatchEvent(new CustomEvent('ji-offline-trip', { detail: snap }));
                } catch (_) {
                    /* ignore */
                }
            }
            return;
        }
        try {
            const data = await this.service.getActiveTrip();
            if (!data?.success || !data.payload || data.phase === 'none') return;
            const p = data.payload;
            const phase = data.phase;

            if (role === 'client' && phase === 'searching') {
                window.taxiApp.activeOrder = {
                    trip_id: p.trip_id,
                    client_id: p.client_id,
                    start_lat: p.start_lat,
                    start_lon: p.start_lon,
                    pickup_lat: p.start_lat,
                    pickup_lon: p.start_lon,
                    end_lat: p.end_lat,
                    end_lon: p.end_lon,
                    taxi_lat: p.taxi_lat ?? p.start_lat,
                    taxi_lon: p.taxi_lon ?? p.start_lon,
                    start_address: p.start_address,
                    end_address: p.end_address,
                    distance: p.distance,
                    driving_time: p.driving_time,
                    status: p.status,
                    state: p.state,
                };
                const cancelBtn = document.getElementById('searching-cancel-button-client');
                if (cancelBtn) cancelBtn.dataset.tripId = String(p.trip_id);
                if (window.taxiApp.restoreRouteFromActivePayload) {
                    await window.taxiApp.restoreRouteFromActivePayload(p);
                }
                window.taxiApp.openTaxiSearchingModal();
                return;
            }

            if (role === 'client' && (phase === 'assigned' || phase === 'confirmed')) {
                await window.appControllers.confirmationTrip(p, 'client');
                this._startClientTripLocationShare();
                if (p.state && window.taxiApp?.updateTripStateUI) {
                    window.taxiApp.updateTripStateUI(p.state);
                }
                this._maybeResyncTrip();
                return;
            }

            if (role === 'driver' && phase === 'incoming') {
                const photo = p.client_avatar || '';
                if (window.taxiControlles?.showTripOrder) {
                    window.taxiControlles.showTripOrder({
                        taxi_lat: p.taxi_lat,
                        taxi_lon: p.taxi_lon,
                        start_lat: p.start_lat,
                        start_lon: p.start_lon,
                        end_lat: p.end_lat,
                        end_lon: p.end_lon,
                        time: p.driving_time || '',
                        price:
                            parseFloat(
                                String(p.price || '0').replace(/[^\d.,-]/g, '').replace(',', '.')
                            ) || 0,
                        distance: p.distance,
                        clientName: p.client_name || '',
                        clientRating: String(p.client_rating ?? ''),
                        clientID: p.client_id,
                        tripID: p.trip_id,
                        clientPhoto: photo,
                        start_address: p.start_address,
                        end_address: p.end_address,
                    });
                }
                return;
            }

            if (role === 'driver' && phase === 'confirmed') {
                window.taxiApp.startDriverLocationTracking();
                await window.appControllers.confirmationTrip(p, 'driver');
                if (p.state && window.taxiApp?.updateTripStateUI) {
                    window.taxiApp.updateTripStateUI(p.state);
                }
                if (window.taxiApp && p.trip_id != null && p.state) {
                    const leg =
                        typeof window.normalizeTripLegState === 'function'
                            ? window.normalizeTripLegState(p.state)
                            : p.state;
                    const arrivedDone =
                        leg === 'driver_arrived' ||
                        leg === 'waiting' ||
                        leg === 'onboard' ||
                        leg === 'in_progress' ||
                        leg === 'paused' ||
                        leg === 'at_destination' ||
                        leg === 'finished';
                    const onboardDone =
                        leg === 'onboard' ||
                        leg === 'in_progress' ||
                        leg === 'paused' ||
                        leg === 'at_destination' ||
                        leg === 'finished';
                    const destDone = leg === 'at_destination' || leg === 'finished';
                    window.taxiApp._tripProximityUi = {
                        tripId: Number(p.trip_id),
                        arrivedPressed: arrivedDone,
                        onboardPressed: onboardDone,
                        destinationArrivedPressed: destDone,
                    };
                }
                this._maybeResyncTrip();
            }
        } catch (e) {
            console.warn('[Adapter] restoreActiveOrderIfAny', e);
        }
    }

    _maybeResyncTrip() {
        try {
            const ws = this.service?.wsService;
            if (ws && typeof ws._requestTripResync === 'function') {
                ws._requestTripResync();
            }
        } catch (_) {
            /* ignore */
        }
    }

    /**
     * После reconnect Socket.IO: заново поднять watchPosition / шаринг клиента.
     * watchPosition в фоне (заблокированный экран, другая вкладка) на iOS часто не даёт новых точек —
     * остаётся heartbeat с последней известной координатой.
     */
    restoreGpsAfterSocketReconnect() {
        try {
            if (!window.taxiApp?.activeOrder?.trip_id) return;
            const role = localStorage.getItem('userType');
            if (role === 'driver') {
                window.taxiApp.stopDriverLocationTracking();
                window.taxiApp.startDriverLocationTracking();
                return;
            }
            if (role === 'client') {
                this._stopClientTripLocationShare();
                this._startClientTripLocationShare();
            }
        } catch (e) {
            console.warn('[Adapter] restoreGpsAfterSocketReconnect', e);
        }
    }
    
    async checkTaxiStatus() {
        return this.service.getTaxiStatus();
    }

    checkTripsForProfile() {
        return this.service.getTripsForProfile();
    }
    
    updateTaxiStatus(status, lat = null, lng = null) {
        return this.service.setTaxiStatus(status, lat, lng);
    }
    
    async createOrder(orderData) {
        return this.service.createOrder(orderData);
    }

    async confirmTrip(tripData) {
        return this.service.confirmTrip(tripData);
    }

    async checkTrip(tripData) {
        return this.service.checkTrip(tripData);
    }

    driverReleaseAwaitingClient(tripId) {
        return this.service.driverReleaseAwaitingClient(tripId);
    }

    async updateTripState(state = 'driver_arrived', trip_id) {
        return this.service.updateTripState(state, trip_id);
    }

    async submitTripPeerRating(tripId, stars, reasons) {
        const res = await this.service.submitTripPeerRating(tripId, stars, reasons);
        if (res && res.success && res.code !== "already_rated") {
            try {
                window.taxiApp?.updateTripStateUI?.("finished");
            } catch (_) {
                /* ignore */
            }
            this.applyFinishedTripLegCleanup({ afterLocalPeerRating: true });
        }
        return res;
    }
    
    async loadUserProfile() {
        try {
            const data = await this.service.getUserProfile();
            
            if (data.success) {
                return data;
            } else {
                // Показываем модальное окно регистрации
                const orderModal = document.getElementById('order-modal');
                const taxiSearching = document.getElementById('order-modal-taxi-searching');
                const getRegister = document.getElementById('order-modal-get-register');
                
                if (orderModal) orderModal.style.display = 'flex';
                if (taxiSearching) taxiSearching.style.display = 'none';
                if (getRegister) getRegister.style.display = 'flex';
                
                return null;
            }
        } catch (error) {
            console.error('[Adapter] Error loading profile:', error);
            return null;
        }
    }
    
    async getOrderStatus(orderId) {
        return this.service.getOrderStatus(orderId);
    }
    
    async getDriverInfo(driverId) {
        return this.service.getDriverInfo(driverId);
    }
    
    async cancelOrder(orderId, userType, reasonType, reasonText) {
        return this.service.cancelOrder(orderId, userType, reasonType, reasonText);
    }
    
    updateTaxiStatusUI(status) {
        this.service.updateTaxiStatusUI(status);
    }
    
    initWebSocket() {
        // Автоматически инициализируется в конструкторе
        return this.service.initialize();
    }
    
    disconnect() {
        return this.service.cleanup();
    }
}

// ========================================
// Глобальная инициализация
// ========================================

// Создаем и экспортируем адаптер
window.taxiServices = new TaxiServicesAdapter();
window.taxiWS = window.taxiServices.ws;

console.log('[Adapter] Initialized');
