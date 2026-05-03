// Контроллеры для управления интерфейсом приложения

/**
 * Bearing по двум точкам (локально: atan2(Δlng·cosφ, Δlat) в градусах, 0° = север, по часовой).
 * Сглаживание кратчайшего пути по кругу.
 */
const MapNav = (function () {
    const DEG = 180 / Math.PI;
    const RAD = Math.PI / 180;
    function bearingFromDelta(lat1, lng1, lat2, lng2) {
        const dLat = lat2 - lat1;
        const dLng = (lng2 - lng1) * Math.cos(((lat1 + lat2) * 0.5) * RAD);
        return Math.atan2(dLng, dLat) * DEG;
    }
    function haversineM(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const p1 = lat1 * RAD;
        const p2 = lat2 * RAD;
        const dLat = (lat2 - lat1) * RAD;
        const dLng = (lng2 - lng1) * RAD;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    function shortAngleDeg(from, to) {
        return ((((to - from) + 540) % 360) - 180);
    }
    function lerpAngle(from, to, t) {
        if (from == null || Number.isNaN(from)) return to;
        return from + shortAngleDeg(from, to) * t;
    }
    return { bearingFromDelta, haversineM, shortAngleDeg, lerpAngle };
})();

class AppControllers {
    constructor() {
        this.additionalButtons = document.querySelector('.additional-buttons');
        this.toInputLocation = document.getElementById("to-input-location");        
        this.fromInputLocation = document.getElementById("from-input-location");
        this.pointToMapBtn = document.getElementById("point-to-map-btn");
        this.setRouteBtn = document.getElementById("set-route-btn");
        this.bottomNav = document.querySelector('.bottom-nav');
        this.loading = document.querySelector(".loading-preloader");
        this.logo = document.querySelector(".logo");
        this.handle = document.querySelector('.handle-wrapper');
        this.orderTaxiCancelBtn = document.getElementById('order-taxi-cancel-button');
        this.orderTaxiConfirmBtn = document.getElementById('order-taxi-confirm-button');
        this.mapContainer = document.getElementById('map');
        this.fromInput = document.getElementById('from-input');
        this.toInput = document.getElementById('to-input');
        this.getRegisterBtn = document.getElementById('get-register-btn');
        this.getLoginBtn = document.getElementById('get-login-btn');
        this.cancelSearchingBtnForTaxi = document.getElementById('searching-cancel-button');
        this.cancelSearchingBtnForClient = document.getElementById('searching-cancel-button-client');
        this.orderProgressCancelBtn = document.getElementById('order-progress-cancel-button');
        this.orderModalCancelBtn = document.getElementById('order-modal-cancel-button');
        this.taxiNotificationButton = document.getElementById('taxi-notification-button');
        this.resonsConfirmationButton = document.getElementById('resons-confirmation-button');
        this.orderTaxiProgressArrivedBtn = document.getElementById('order-taxi-progress-arrived-button');
        this.orderTaxiProgressStartedBtn = document.getElementById('order-taxi-progress-started-button');
        this.orderTaxiProgressDestinationBtn = document.getElementById('order-taxi-progress-destination-button');

        /** Не пересоздавать карту при подряд onboard → in_progress (один режим chauffeur). */
        this._activeChauffeurTripId = null;

        this._taxiMoveRaf = null;
        this._clientMoveRaf = null;

        this.init();
    }

    _ensureMapNav(mi) {
        if (!mi || !mi.map || mi.__nav) return;
        const m = mi.map;
        const followTrip =
            !!mi.taxiToGoal ||
            !!mi.clientToGoal ||
            !!mi.taxiToClient;
        const idleDriverOnly = !!mi.taxiMarker && !mi.clientMarker && !followTrip;

        mi.__nav = {
            prevLat: null,
            prevLng: null,
            lastFrameLat: null,
            lastFrameLng: null,
            smoothedVehicleDeg: null,
            lastMarkerRot: null,
            lastBearingTs: 0,
            lastFollowTs: 0,
            follow: followTrip || idleDriverOnly,
            rotateMap: !!m._rotate,
            isDriver: (localStorage.getItem('userType') || '') === 'driver',
        };
    }

    /**
     * Центр карты чуть выше машины (машина ниже центра экрана), как в навигаторе.
     */
    _panFollowVehicle(map, lat, lng) {
        if (!map || !map.getSize || !map.latLngToContainerPoint) return;
        const target = L.latLng(lat, lng);
        const centerPt = map.getSize().divideBy(2);
        const carPt = map.latLngToContainerPoint(target);
        const desired = L.point(centerPt.x, centerPt.y + map.getSize().y * 0.12);
        const delta = carPt.subtract(desired);
        if (Math.abs(delta.x) > 1.5 || Math.abs(delta.y) > 1.5) {
            map.panBy(delta, { animate: false, noMoveStart: true });
        }
    }

    /**
     * Поворот карты (leaflet-rotate) + маркер в norotatePane: угол на экране = курс − bearing карты.
     */
    _applyVehicleNavFrame(marker, map, ns, curLat, curLng, prevFLat, prevFLng, isFinal) {
        if (!marker || !map || !ns) return;
        const minMoveM = 1.2;
        const rotDeadDeg = 4;
        const mapBearingMinIntervalMs = 52;
        const now = performance.now();

        let raw = ns.smoothedVehicleDeg;
        const stepM = MapNav.haversineM(prevFLat, prevFLng, curLat, curLng);
        if (stepM >= minMoveM) {
            raw = MapNav.bearingFromDelta(prevFLat, prevFLng, curLat, curLng);
        } else if (raw == null && ns.prevLat != null) {
            raw = MapNav.bearingFromDelta(ns.prevLat, ns.prevLng, curLat, curLng);
        } else if (raw == null) {
            raw = 0;
        }
        ns.smoothedVehicleDeg = MapNav.lerpAngle(ns.smoothedVehicleDeg, raw, isFinal ? 0.45 : 0.28);
        const veh = ns.smoothedVehicleDeg;

        if (ns.rotateMap && typeof map.setBearing === 'function') {
            if (now - ns.lastBearingTs >= mapBearingMinIntervalMs || isFinal) {
                ns.lastBearingTs = now;
                const curB = map.getBearing();
                if (Math.abs(MapNav.shortAngleDeg(curB, veh)) >= 2 || isFinal) {
                    const nb = MapNav.lerpAngle(curB, veh, isFinal ? 0.35 : 0.14);
                    map.setBearing(nb);
                }
            }
        }

        const B = typeof map.getBearing === 'function' ? map.getBearing() : 0;
        let screenAng = MapNav.shortAngleDeg(B, veh);
        if (ns.lastMarkerRot != null) {
            screenAng = MapNav.lerpAngle(ns.lastMarkerRot, screenAng, isFinal ? 0.4 : 0.22);
        }
        if (
            isFinal ||
            ns.lastMarkerRot == null ||
            Math.abs(MapNav.shortAngleDeg(ns.lastMarkerRot, screenAng)) >= rotDeadDeg
        ) {
            if (typeof marker.setRotationAngle === 'function') {
                marker.setRotationAngle(screenAng);
            }
            ns.lastMarkerRot = screenAng;
        }

        if (ns.follow) {
            if (now - ns.lastFollowTs > 72 || isFinal) {
                ns.lastFollowTs = now;
                this._panFollowVehicle(map, curLat, curLng);
            }
        }
    }

    // Инициализация контроллеров
    init() {
        this.setupLoadingScreen();
        this.setupEventListeners();
    }

    // Настройка экрана загрузки
    setupLoadingScreen() {
        window.addEventListener("load", () => {
            this.bottomNav.style.display = "none";
            this.logo.style.display = "none";
            
            // Подождем 1 секунду перед скрытием загрузки
            setTimeout(() => {
                this.loading.classList.add("hide");
                this.bottomNav.style.display = "flex";
                this.logo.style.display = "block";
            }, 1000);
        });
    }

    


    // Настройка обработчиков событий
    setupEventListeners() {
        // Показ кнопки "указать на карте" при клике на инпут "Куда"
        if (this.toInputLocation) {
            this.toInputLocation.addEventListener("click", async () => {
                
                const client_data = await window.taxiServices.loadUserProfile();            
                if (client_data && client_data.success) {
                    this.toInputLocation.classList.remove("error");
                    this.pointToMapBtn.style.display = "flex";
                    // Режим «B на карте»: не показываем «Marşrut», пока не нажали «Hazırdır»
                    if (window.taxiApp?.mapDestinationPickActive && localStorage.getItem('userType') !== 'driver') {
                        this.setRouteBtn.style.display = "none";
                    } else {
                        this.setRouteBtn.style.display = "flex";
                    }
                } else {
                    await window.profileManager.showProfile();
                }
                
            });
        }

        // Клиент: клик по полю «Откуда» — выбрать точку подачи на карте
        if (this.fromInputLocation) {
            this.fromInputLocation.addEventListener("click", async () => {
                if (localStorage.getItem("userType") !== "client") return;
                const client_data = await window.taxiServices.loadUserProfile();
                if (client_data && client_data.success) {
                    this.fromInputLocation.classList.remove("error");
                    if (window.taxiApp?.enablePickupSelection) {
                        window.taxiApp.enablePickupSelection();
                    }
                } else {
                    await window.profileManager.showProfile();
                }
            });
        }

        if (this.resonsConfirmationButton) {
            this.resonsConfirmationButton.addEventListener("click", async () => {
                
                const clientBlock = document.querySelector('.client-reasons');
                const taxiBlock = document.querySelector('.taxi-reasons');
                const errorBlock = document.querySelector('.resons-error');
    
                let activeBlock = null;

                // 1️⃣ Определяем какая группа сейчас видна
                if (clientBlock.style.display !== 'none') {activeBlock = clientBlock;} 
                else if (taxiBlock.style.display !== 'none') {activeBlock = taxiBlock;}

                if (!activeBlock) return;

                // 2️⃣ Получаем выбранный reason
                const checkedRadio = activeBlock.querySelector('input[type="radio"]:checked');
                const customInput = activeBlock.querySelector('.custom-reason-input input');

                let result = {reason: null, source: null};

                if (checkedRadio) {
                    result.reason = checkedRadio.value;
                    result.source = 'radio';} 
                    
                else if (customInput && customInput.value.trim() !== '') {
                    result.reason = customInput.value.trim();
                    result.source = 'custom';}

                // 3️⃣ Проверка
                if (!result.reason) {errorBlock.classList.add('active'); return;} 
                else {errorBlock.classList.remove('active');}

                try {
                    await window.taxiServices.cancelOrder(
                        this.orderProgressCancelBtn.dataset.tripId, 
                        localStorage.getItem('userType'), 
                        result.source,
                        result.reason);
                } catch (e) {
                    console.error('[cancel trip reasons]', e);
                }

                if (localStorage.getItem('userType') === 'client') {window.taxiApp.closeClientReasonsModal();}
                if (localStorage.getItem('userType') === 'driver') {window.taxiApp.closeTaxiReasonsModal();}
                
                window.taxiApp.resetMap();
                this.mapInstance = null;
                this.applyPostTripCancelNav();
            });
        }

        if (this.fromInputLocation) {
            this.fromInputLocation.addEventListener("click", () => {
                this.fromInputLocation.classList.remove("error");
            });
        }

        if (this.orderTaxiCancelBtn) {
            this.orderTaxiCancelBtn.addEventListener("click", async () => {
                try {
                    const tripId = this.orderTaxiCancelBtn.dataset.tripId;
                    const result = await window.taxiServices.cancelOrder(
                        tripId,
                        'client',
                        'radio',
                        'client_cancel_from_details'
                    );
                    window.taxiApp.closeTaxiDetailsModal();
                    window.taxiApp.resetMap();
                    this.mapInstance = null;
                    this.applyPostTripCancelNav();
                    console.log('Order canceled:', result);
                } catch (error) {
                    console.error('Error canceling order:', error);
                }
            });
        }

        let isSearching = true;

        if (this.cancelSearchingBtnForTaxi) {
            this.cancelSearchingBtnForTaxi.addEventListener("click", async () => {
                const animation = document.getElementById('searching-animation-x2');
                const title = document.getElementById('searching-title-x2');
                const subtitle = document.getElementById('searching-subtitle-x2');

                if (isSearching) {
                    // ❌ Остановили поиск
                    animation.classList.add('cancel-searching-effect');
                    title.innerText = "Axtarış dayandırıldı";
                    subtitle.innerText = "Yeni axtarış üçün təkrar başlayın";
                    this.cancelSearchingBtnForTaxi.innerHTML = 'Axtarışa başlayın';
                    this.cancelSearchingBtnForTaxi.style.backgroundColor = 'var(--primary)';
                    // this.taxiNotificationButton.click();

                } else {
                    // 🔄 Запустили поиск заново
                    animation.classList.remove('cancel-searching-effect');
                    title.innerText = "Müştəri axtarırıq";
                    subtitle.innerText = "Bir az vaxt aparacaq..";
                    this.cancelSearchingBtnForTaxi.innerHTML = 'Bağla';
                    this.cancelSearchingBtnForTaxi.style.backgroundColor = '';
                    // this.taxiNotificationButton.click();
                }

                isSearching = !isSearching;
            });
        }

        if (this.cancelSearchingBtnForClient) {
            this.cancelSearchingBtnForClient.addEventListener("click", async () => {
                const tripRaw =
                    this.cancelSearchingBtnForClient.dataset?.tripId ??
                    window.taxiApp?.activeOrder?.trip_id;
                window.taxiApp.stopSearchTimer();
                try {
                    const result = await window.taxiServices.cancelOrder(
                        tripRaw,
                        'client',
                        'radio',
                        'client_cancel_while_searching'
                    );
                    if (!result?.success) {
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(
                                result?.message || 'Не удалось отменить поиск.',
                                'error'
                            );
                        }
                        if (result?.code === 'INVALID_ORDER_ID') {
                            window.taxiApp.closeTaxiSearchingModal();
                            window.taxiApp.resetMap();
                            this.mapInstance = null;
                            this.applyPostTripCancelNav();
                        } else {
                            window.taxiApp.openTaxiSearchingModal();
                        }
                        return;
                    }
                } catch (e) {
                    console.error('[cancel searching client]', e);
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast(
                            e?.message || 'Ошибка сети при отмене поиска.',
                            'error'
                        );
                    }
                    if (tripRaw) {
                        window.taxiApp.openTaxiSearchingModal();
                    } else {
                        window.taxiApp.closeTaxiSearchingModal();
                        window.taxiApp.resetMap();
                        this.mapInstance = null;
                        this.applyPostTripCancelNav();
                    }
                    return;
                }
                window.taxiApp.closeTaxiSearchingModal();
                window.taxiApp.resetMap();
                this.mapInstance = null;
                this.applyPostTripCancelNav();
            });
        }

        if (this.orderProgressCancelBtn) {
            this.orderProgressCancelBtn.addEventListener("click", async () => {

                if (localStorage.getItem('userType') === 'client') {window.taxiApp.openClientReasonsModal();}
                if (localStorage.getItem('userType') === 'driver') {window.taxiApp.openTaxiReasonsModal();}
            });
        }

        if (this.orderModalCancelBtn) {
            this.orderModalCancelBtn.addEventListener("click", async () => {

                if (localStorage.getItem('userType') === 'client') {window.taxiApp.openClientReasonsModal();}
                if (localStorage.getItem('userType') === 'driver') {window.taxiApp.openTaxiReasonsModal();}
            });
        }



       if (this.orderTaxiConfirmBtn) {
            this.orderTaxiConfirmBtn.addEventListener("click", async () => { // стрелочная функция
                const tripData = {
                    clientID: this.orderTaxiConfirmBtn.dataset.clientId,
                    driverID: this.orderTaxiConfirmBtn.dataset.driverId,
                    tripID: this.orderTaxiConfirmBtn.dataset.tripId,
                    startAddress: this.orderTaxiConfirmBtn.dataset.startAddress,
                    endAddress: this.orderTaxiConfirmBtn.dataset.endAddress,
                    fromLocation: [
                        this.orderTaxiConfirmBtn.dataset.startLat, 
                        this.orderTaxiConfirmBtn.dataset.startLon
                    ],
                    toLocation: [
                        this.orderTaxiConfirmBtn.dataset.endLat, 
                        this.orderTaxiConfirmBtn.dataset.endLon
                    ],
                    taxiLocation: [
                        this.orderTaxiConfirmBtn.dataset.taxiLat, 
                        this.orderTaxiConfirmBtn.dataset.taxiLon
                    ],
                    distance: this.orderTaxiConfirmBtn.dataset.distance,
                    drivingTime: this.orderTaxiConfirmBtn.dataset.time
                };

                try {
                    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast('Нет сети. Подтверждение поездки недоступно офлайн.', 'warn');
                        }
                        return null;
                    }
                    if (!window.taxiServices?.confirmTrip) {
                        console.error('taxiServices.confirmTrip недоступен');
                        return null;
                    }
                    const data = await window.taxiServices.confirmTrip(tripData);
                    if (data?.offline) {
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(
                                data.message || 'Нет сети. Подтверждение поездки недоступно.',
                                'warn'
                            );
                        }
                        return null;
                    }
                    if (!data || data.success === false) {
                        console.warn('Подтверждение поездки отклонено', data);
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(
                                (data && data.message) || 'Не удалось подтвердить поездку.',
                                'error'
                            );
                        }
                        return data;
                    }
                    this.additionalButtons.style.display = "flex";
                    return data;
                } catch (error) {
                    console.error('Error creating order:', error);
                    return null;
                }
            });
        }

        // Обработчик для кнопки построения маршрута
        if (this.setRouteBtn) {
            this.setRouteBtn.addEventListener("click", this.validateAndBuild.bind(this));
        }

        // Обработчик для кнопки-ручки (раскрытие/скрытие навигации)
        if (this.handle) {
            this.handle.addEventListener('click', this.toggleBottomNav.bind(this));
        }
        
        // Обработчик для кнопки регистрация для поиска такси
        if (this.getRegisterBtn) {
            this.getRegisterBtn.addEventListener('click', function() {
                document.getElementById('order-modal').style.display='none';
                document.getElementById('order-modal-get-register').style.display='none';
                window.taxiApp.showScreen('register-screen')
            }) 
        }

        if (this.orderTaxiProgressArrivedBtn) {
            this.orderTaxiProgressArrivedBtn.addEventListener('click', async () => {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast(
                            'Нет сети. Смена состояния поездки недоступна; доступен только просмотр последнего состояния.',
                            'warn'
                        );
                    }
                    return;
                }
                const tid = Number(this.orderTaxiProgressArrivedBtn.dataset.tripId);
                if (window.taxiApp) {
                    if (!window.taxiApp._tripProximityUi || window.taxiApp._tripProximityUi.tripId !== tid) {
                        window.taxiApp._tripProximityUi = {
                            tripId: tid,
                            arrivedPressed: false,
                            onboardPressed: false,
                            destinationArrivedPressed: false,
                        };
                    }
                    window.taxiApp._tripProximityUi.arrivedPressed = true;
                }
                try {
                    const r = await window.taxiServices.updateTripState(
                        'driver_arrived',
                        this.orderTaxiProgressArrivedBtn.dataset.tripId
                    );
                    if (r?.offline) {
                        if (window.taxiApp?._tripProximityUi?.tripId === tid) {
                            window.taxiApp._tripProximityUi.arrivedPressed = false;
                        }
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(r.message || 'Нет сети.', 'warn');
                        }
                        return;
                    }
                } catch (e) {
                    console.error('[order] driver_arrived', e);
                    return;
                }
                this.showArrivedButton(false);
                if (!window.taxiApp?._tripProximityUi?.onboardPressed) {
                    this.showStartedButton(true);
                }
            });
        }

        if (this.orderTaxiProgressStartedBtn) {
            this.orderTaxiProgressStartedBtn.addEventListener('click', async () => {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast(
                            'Нет сети. Смена состояния поездки недоступна; доступен только просмотр последнего состояния.',
                            'warn'
                        );
                    }
                    return;
                }
                const tid = Number(this.orderTaxiProgressStartedBtn.dataset.tripId);
                const tidStr = this.orderTaxiProgressStartedBtn.dataset.tripId;
                if (window.taxiApp) {
                    if (!window.taxiApp._tripProximityUi || window.taxiApp._tripProximityUi.tripId !== tid) {
                        window.taxiApp._tripProximityUi = {
                            tripId: tid,
                            arrivedPressed: false,
                            onboardPressed: false,
                            destinationArrivedPressed: false,
                        };
                    }
                    window.taxiApp._tripProximityUi.onboardPressed = true;
                }
                try {
                    const r1 = await window.taxiServices.updateTripState('onboard', tidStr);
                    if (r1?.offline) {
                        if (window.taxiApp?._tripProximityUi?.tripId === tid) {
                            window.taxiApp._tripProximityUi.onboardPressed = false;
                        }
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(r1.message || 'Нет сети.', 'warn');
                        }
                        return;
                    }
                    const r2 = await window.taxiServices.updateTripState('in_progress', tidStr);
                    if (r2?.offline) {
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(r2.message || 'Нет сети.', 'warn');
                        }
                        return;
                    }
                    if (r2?.state && window.taxiApp?.activeOrder) {
                        window.taxiApp.activeOrder.state = r2.state;
                    }
                } catch (e) {
                    console.error('[order] onboard/in_progress', e);
                }
                this.showStartedButton(false);
            });
        }

        if (this.orderTaxiProgressDestinationBtn) {
            this.orderTaxiProgressDestinationBtn.addEventListener('click', async () => {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast(
                            'Нет сети. Смена состояния поездки недоступна; доступен только просмотр последнего состояния.',
                            'warn'
                        );
                    }
                    return;
                }
                const tid = Number(this.orderTaxiProgressDestinationBtn.dataset.tripId);
                const tidStr = this.orderTaxiProgressDestinationBtn.dataset.tripId;
                if (window.taxiApp) {
                    if (!window.taxiApp._tripProximityUi || window.taxiApp._tripProximityUi.tripId !== tid) {
                        window.taxiApp._tripProximityUi = {
                            tripId: tid,
                            arrivedPressed: true,
                            onboardPressed: true,
                            destinationArrivedPressed: false,
                        };
                    }
                    window.taxiApp._tripProximityUi.destinationArrivedPressed = true;
                }
                this.showDestinationArrivedButton(false);
                try {
                    const r = await window.taxiServices.updateTripState('at_destination', tidStr);
                    if (r?.offline) {
                        if (window.taxiApp?._tripProximityUi?.tripId === tid) {
                            window.taxiApp._tripProximityUi.destinationArrivedPressed = false;
                        }
                        if (typeof window.showAppToast === 'function') {
                            window.showAppToast(r.message || 'Нет сети.', 'warn');
                        }
                        return;
                    }
                    if (r?.state && window.taxiApp?.activeOrder) {
                        window.taxiApp.activeOrder.state = r.state;
                    }
                } catch (e) {
                    console.error('[order] at_destination', e);
                }
            });
        }
        
        // Обработчик для кнопки войти для поиска такси
        if (this.getLoginBtn) {
            this.getLoginBtn.addEventListener('click', function() {
                document.getElementById('order-modal').style.display='none';
                document.getElementById('order-modal-get-register').style.display='none';
                window.taxiApp.showScreen('login-screen')
            });
        }

        // Изменение прозрачности навигации при перетаскивании карты
        if (window.taxiApp && window.taxiApp.map) {
            this.bottomNav.style.transition = 'opacity 0.3s ease';
            window.taxiApp.map.on('dragstart', () => {
                this.bottomNav.style.opacity = '0.2';
            });

            window.taxiApp.map.on('dragend', () => {
                this.bottomNav.style.opacity = '1';
            });
        }

        // Валидация и построение маршрута при нажатии Enter
        if (this.fromInput) {
            this.fromInput.addEventListener("keypress", (e) => {
                if (e.key === "Enter") {
                    this.validateAndBuild();
                }
            });
        }
        
        if (this.toInput) {
            this.toInput.addEventListener("keypress", (e) => {
                if (e.key === "Enter") {
                    this.validateAndBuild();
                }
            });
        }
    }

    

    // Переключение нижней навигации
    async toggleBottomNav(mode = 'default') {
        this.bottomNav.style.transition = 'transform 0.4s cubic-bezier(.4, 0, .2, 1)';
        this.bottomNav.style.willChange = 'transform';
        this.searchPanel = document.getElementById('client-searching-panel');
        this.orderPanel = document.querySelector('.order-panel');
        this.orderInfo = document.querySelector('.order-info');
        
        // Удаляем классы позиционирования; closed снимаем только в режимах «панель поднята» (см. ниже)
        this.bottomNav.classList.remove('expanded', 'taxiExpanded', 'taxiActiveTrip');
        
        switch (mode) {
            case 'taxi':
                // Переключение между поиском и заказом (после входящего заказа с .closed — иначе closed перебивает transform в CSS)
                this.bottomNav.classList.remove('closed');
                this.bottomNav.classList.add('taxiExpanded');
                if (this.searchPanel.style.display === 'none' || !this.searchPanel.style.display) {
                    this.searchPanel.style.display = 'block';
                    this.orderPanel.style.display = 'none';
                    this.orderInfo.style.display = 'none';
                }
                break;
                
            case 'taxi.close':
                // Закрываем поиск, показываем заказ
                this.bottomNav.classList.remove('closed');
                this.bottomNav.classList.add('expanded');
                if (this.searchPanel) {
                    this.searchPanel.style.display = 'none';
                }
                break;
                
            case 'taxi.active.trip':
                // Активная поездка: убрать «опущенную» навигацию от карточки заказа
                this.bottomNav.classList.remove('closed');
                this.searchPanel.style.display = 'none';
                this.orderPanel.style.display = 'none';
                this.bottomNav.classList.add('taxiActiveTrip');

                break;
                
            case 'closed':
                // Полностью закрытая навигация
                this.bottomNav.classList.add('closed');
                break;
                
            case 'clear.class':
                // Только удаляем классы
                this.bottomNav.classList.remove('expanded', 'taxiExpanded', 'taxiActiveTrip', 'closed');
                break;
                
            default: {
                const isClosed = this.bottomNav.classList.contains('closed');
                const isDriver = localStorage.getItem('userType') === 'driver';
                const isOwnOrder = Number(window.taxiApp.activeOrder?.driver_id) === Number(localStorage.getItem('userID'));

                // Если сейчас закрыто
                if (isClosed) {
                    // И это водитель со своим активным заказом
                    if (isDriver && isOwnOrder) {
                        this.bottomNav.classList.remove('closed');
                        this.bottomNav.classList.add('taxiActiveTrip');
                    } else {
                        this.bottomNav.classList.remove('closed');
                    }
                } else {
                    this.bottomNav.classList.add('closed');
                }

                break;
            }

        }
    }

    /**
     * Нижняя панель после отмены: клиент — форма маршрута (order-panel);
     * водитель — панель «Müştəri axtarırıq» (#client-searching-panel), не наоборот.
     */
    applyPostTripCancelNav() {
        const role = localStorage.getItem('userType');
        const searchPanel = document.getElementById('client-searching-panel');
        const orderPanel = document.querySelector('.order-panel');
        const orderInfo = document.querySelector('.order-info');
        if (window.taxiApp?.resetAddressInputsAdditionalSummary) {
            window.taxiApp.resetAddressInputsAdditionalSummary();
        }
        if (window.taxiApp?.clearAllOrderTaxiProgressActive) {
            window.taxiApp.clearAllOrderTaxiProgressActive();
        }
        if (window.taxiApp?.closeTaxiSearchingModal) window.taxiApp.closeTaxiSearchingModal();
        if (window.taxiApp?.closeMainModal) window.taxiApp.closeMainModal();
        if (role === 'client') {
            if (this.bottomNav) {
                this.bottomNav.classList.remove('taxiExpanded', 'taxiActiveTrip');
            }
            if (searchPanel) searchPanel.style.display = 'none';
            if (orderPanel) orderPanel.style.display = 'block';
            if (orderInfo) orderInfo.style.display = 'none';
        } else if (role === 'driver') {
            if (orderPanel) orderPanel.style.display = 'none';
            if (orderInfo) orderInfo.style.display = 'none';
            if (searchPanel) searchPanel.style.display = 'block';
            if (this.bottomNav) {
                this.bottomNav.classList.remove('taxiActiveTrip');
                this.bottomNav.classList.add('taxiExpanded');
            }
            const tc = window.taxiControlles;
            if (tc?.orderBlock) tc.orderBlock.style.display = 'none';
            if (tc?.notificationBlock) tc.notificationBlock.style.display = 'none';
        }
    }


    // Получение координат из datalist
    getCoordsFromDatalist(value) {
        const options = document.querySelectorAll('#locations option');
        for (const option of options) {if (option.value === value) {return option.dataset.coords.split(',').map(Number);}}
        return null;
    }

    // Геокодирование адреса в координаты
    async geocodeAddress(address) {
        try {
            // Временно: публичный Nominatim (может 429/CORS).
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (data && data.length > 0) {
                return {
                    lat: parseFloat(data[0].lat),
                    lng: parseFloat(data[0].lon),
                    address: data[0].display_name
                };
            }
            return null;
        } catch (error) {
            console.error('Geocoding error:', error);
            return null;
        }
    }

    // Показать/скрыть индикатор загрузки
    showLoading(show) {
        if (show) {
            // Создаем или показываем индикатор загрузки
            document.querySelector('.geocoding-loader').style.display = 'flex';
            document.getElementById('geocoding-loader-text').textContent = "Ünvanı axtarın..";
        } else {
            document.querySelector('.geocoding-loader').style.display = 'none';
        }
    }

    // Валидация и построение маршрута
    async validateAndBuild() {
        if (window.taxiApp?.mapDestinationPickActive && typeof window.taxiApp.finishDestinationMapPick === 'function') {
            window.taxiApp.finishDestinationMapPick();
        }

        // Проверяем, не заблокирован ли интерфейс
        if (window.taxiApp && window.taxiApp.isInterfaceLocked) {
            window.taxiApp.showLockNotification();
            return;}

        const fromWrapper = document.getElementById("from-input-location");
        const toWrapper = document.getElementById("to-input-location");
        let valid = true;

        // Сбрасываем ошибки
        fromWrapper.classList.remove("error");
        toWrapper.classList.remove("error");

        // Проверяем заполненность полей
        if (!this.fromInput.value.trim()) {
            fromWrapper.classList.add("error");
            valid = false;
        }
        
        if (!this.toInput.value.trim()) {
            toWrapper.classList.add("error");
            valid = false;
        }
        
        if (!valid) return;

        // Показываем индикатор загрузки
        this.showLoading(true);

        try {
            // Геокодируем адреса
            const [fromResult, toResult] = await Promise.all([
                this.geocodeAddress(this.fromInput.value),
                this.geocodeAddress(this.toInput.value)
            ]);

            if (!fromResult) {
                fromWrapper.classList.add("error");
                valid = false;
            }
            if (!toResult) {
                toWrapper.classList.add("error");
                valid = false;
            }
            if (!valid) {
                this.showLoading(false);
                return;
            }

            // Обновляем поля ввода с полными адресами
            this.fromInput.value = fromResult.address;
            this.toInput.value = toResult.address;

            // Создаём или обновляем маркеры
            if (window.taxiApp.fromMarker) {
                window.taxiApp.map.removeLayer(window.taxiApp.fromMarker);
            }
            
            window.taxiApp.fromMarker = L.marker([fromResult.lat, fromResult.lng], { 
                icon: L.icon(APP_CONFIG.icons.markerA),
                draggable: true 
            }).addTo(window.taxiApp.map);

            // Добавляем обработчик перетаскивания для fromMarker
            window.taxiApp.fromMarker.on('dragend', e => {
                window.taxiApp.reverseGeocode(e.target.getLatLng(), address => {
                    document.getElementById('from-input').value = address;
                });
                if (window.taxiApp.toMarker) {
                    window.taxiApp.calculateRouteWithOSRM();
                }
            });

            if (window.taxiApp.toMarker) {
                window.taxiApp.map.removeLayer(window.taxiApp.toMarker);
            }
            
            window.taxiApp.toMarker = L.marker([toResult.lat, toResult.lng], { 
                icon: L.icon(APP_CONFIG.icons.markerB),
                draggable: true 
            }).addTo(window.taxiApp.map);

            // Добавляем обработчик перетаскивания для toMarker
            window.taxiApp.toMarker.on('dragend', e => {
                window.taxiApp.reverseGeocode(e.target.getLatLng(), address => {
                    document.getElementById('to-input').value = address;
                });
                if (window.taxiApp.fromMarker) {
                    window.taxiApp.calculateRouteWithOSRM();
                }
            });

            // Строим маршрут через OSRM
            await window.taxiApp.calculateRouteWithOSRM();

            window.taxiApp.updateUIForRoute();
            window.taxiApp.routeStatus = true;

        } catch (error) {
            console.error('Error building route:', error);
        } finally {
            this.showLoading(false);
        }
    }


    // Поиск ближайшего водителя (объект driver)
    findNearestDriver(userLatLng) {
        if (!window.taxiApp || !window.taxiApp.drivers || !window.taxiApp.drivers.length) {
            return null;
        }

        let nearest = null;
        let minDistance = Infinity;

        // Фильтруем только доступных водителей
        const availableDrivers = window.taxiApp.drivers.filter(driver => 
            driver.status === "available"
        );

        availableDrivers.forEach(driver => {
            const driverLatLng = L.latLng(driver.currentLocation || driver.location);
            const distance = userLatLng.distanceTo(driverLatLng);

            if (distance < minDistance) {
                minDistance = distance;
                nearest = driver;
            }
        });

        return nearest;
    }

    // searchingCancelForTaxi() {
    //     const cancelBtn = document.getElementById('searching-cancel-button');
    // }



    // Обработка найденных маршрутов
    handleRoutesFound(e) {
        if (!e.routes || e.routes.length === 0) return;
        
        const route = e.routes[0];
        const distanceMeters = route.summary.totalDistance;
        const distanceKm = distanceMeters / 1000;
        if (window.taxiApp) {
            window.taxiApp.lastRouteDistanceKm = distanceKm;
            const addMetrsEl = document.getElementById('additional-metrs');
            if (addMetrsEl) addMetrsEl.dataset.distanceKm = String(distanceKm);
        }
        const distanceText = distanceMeters > 1000 
            ? distanceKm.toFixed(1) + ' km' 
            : Math.round(distanceMeters) + ' m';

        const timeSeconds = route.summary.totalTime;
        const hours = Math.floor(timeSeconds / 3600);
        const minutes = Math.floor((timeSeconds % 3600) / 60);
        const timeText = hours > 0 ? `${hours}h ${minutes}dəq` : `${minutes} dəq`;
        
        window.taxiApp.updateUIForRoute();

        // Записываем в блоки
        document.getElementById('additional-metrs').textContent = distanceText;
        document.getElementById('additional-timer').textContent = timeText;
        
        // Находим ближайшего таксиста
        // const nearestDriver = this.findNearestDriver(window.taxiApp.fromMarker.getLatLng());
        
        // if (nearestDriver) {
        //     // Считаем цену по его тарифу
        //     const distanceKm = distanceMeters / 1000;
        //     const price = (distanceKm * nearestDriver.pricePerKm).toFixed(2);
        //     document.getElementById('additional-price').textContent = price + ' ₼';
        // } else {
        //     document.getElementById('additional-price').textContent = '0.00 ₼';
        // }
        
        // Обновляем глобальный статус маршрута
        window.ROUTE_STATUS = true;
    }

    async viewTripData(trip_id, client_id, driver_id, taxi_avatar, taxi_car_name, taxi_car_number, 
        taxi_car_photo, taxi_lat, taxi_lon, start_lat, start_lon, end_lat, end_lon, distance, 
        price, taxi_name, taxi_rating, driving_time, taxi_car_year, taxi_car_category, start_address, end_address) {

        // Обновляем UI с информацией о водителе
        const timeToUser = await window.taxiApp.calculateDrivingTime({lat: taxi_lat, lng: taxi_lon}, {lat: start_lat, lng: start_lon});

        document.getElementById('modal-taxi-avatar').src = "data:image/png;base64," + taxi_avatar;
        document.getElementById('modal-taxi-car-photo').src = "data:image/png;base64," + taxi_car_photo;
        window.taxiApp.safeSetTextContent('client-taxi-go-distance', distance + " km");
        window.taxiApp.safeSetTextContent('client-taxi-go-time', timeToUser);
        window.taxiApp.safeSetTextContent('client-taxi-go-time-order-client', timeToUser);
        window.taxiApp.safeSetTextContent('modal-taxi-car-number-taxi', taxi_car_number);
        window.taxiApp.safeSetTextContent('modal-taxi-car-model-taxi', taxi_car_name ?? '');
        //  `${taxi_car_name}` + `${taxi_car_year ? ' • ' + taxi_car_year : ''}` + `${taxi_car_category ? ' • ' + taxi_car_category : ''}` : ''

        window.taxiApp.safeSetTextContent('modal-taxi-name', taxi_name);
        window.taxiApp.safeSetTextContent('modal-taxi-rating', taxi_rating);
        window.taxiApp.safeSetTextContent('modal-taxi-car-model-client', taxi_car_name ?? '');
        // `${taxi_car_name}` + `${taxi_car_year ? ' • ' + taxi_car_year : ''}` + `${taxi_car_category ? ' • ' + taxi_car_category : ''}` : ''

        window.taxiApp.safeSetTextContent('modal-taxi-car-number-client', taxi_car_number);
        window.taxiApp.safeSetTextContent('client-totla-price', parseFloat(price) + " ₼");

        this.orderTaxiCancelBtn.dataset.tripId = trip_id;
        this.orderTaxiConfirmBtn.dataset.clientId = client_id;
        this.orderTaxiConfirmBtn.dataset.driverId = driver_id;
        this.orderTaxiConfirmBtn.dataset.tripId = trip_id;
        this.orderTaxiConfirmBtn.dataset.startLat = start_lat;
        this.orderTaxiConfirmBtn.dataset.startLon = start_lon;
        this.orderTaxiConfirmBtn.dataset.distance = distance;
        this.orderTaxiConfirmBtn.dataset.taxiLat = taxi_lat;
        this.orderTaxiConfirmBtn.dataset.taxiLon = taxi_lon;
        this.orderTaxiConfirmBtn.dataset.endLat = end_lat;
        this.orderTaxiConfirmBtn.dataset.endLon = end_lon;
        this.orderTaxiConfirmBtn.dataset.startAddress = start_address;
        this.orderTaxiConfirmBtn.dataset.endAddress = end_address;
        this.orderTaxiConfirmBtn.dataset.time = driving_time;

        document.querySelectorAll('.class-for-taxi-car-number').forEach(el => el.textContent = taxi_car_number);
        document.querySelectorAll('.class-for-taxi-car-model').forEach(el => el.textContent = taxi_car_name ?? '');
        //  `${taxi_car_name}` + `${taxi_car_year ? ' • ' + taxi_car_year : ''}` + `${taxi_car_category ? ' • ' + taxi_car_category : ''}` : ''

        window.taxiApp.stopSearchTimer();
        document.getElementById('order-modal').style.display = 'flex';
        document.getElementById('taxi-notification-block').style.display = 'none';
        document.getElementById('order-modal-taxi-searching').style.display = 'none';
        document.getElementById('order-modal-taxi-details').style.display = 'block';
        document.querySelectorAll('.client-taxi-end-address-order').forEach(el => {el.textContent = end_address;});

        // Чтобы WS (trip_searching_resumed) и прочая логика видели актуальный trip_id до подтверждения клиентом
        if (window.taxiApp) {
            window.taxiApp.activeOrder = {
                trip_id: Number(trip_id),
                client_id: Number(client_id),
                driver_id: driver_id != null ? Number(driver_id) : null,
                taxi_lat,
                taxi_lon,
                start_lat,
                start_lon,
                end_lat,
                end_lon,
                start_address,
                end_address,
                distance,
                price,
                driving_time,
            };
            window.taxiApp.syncClientPickupMarkerDrag?.();
        }
    }
    
    _disposeTripMapInstance() {
        const mi = this.mapInstance;
        if (!mi?.map) {
            this.mapInstance = null;
            this._activeChauffeurTripId = null;
            return;
        }
        const m = mi.map;
        for (const c of [mi.taxiToGoal, mi.taxiToClient, mi.clientToGoal]) {
            if (!c) continue;
            try {
                if (typeof m.removeControl === 'function') {
                    m.removeControl(c);
                }
            } catch (_) {
                /* ignore */
            }
        }
        try {
            m.remove();
        } catch (_) {
            /* ignore */
        }
        this.mapInstance = null;
        this._activeChauffeurTripId = null;
    }

    /**
     * fitBounds без анимации зума — иначе при быстром remove карты падает _leaflet_pos / LRM.
     */
    _safeFitBounds(map, bounds, options = {}) {
        if (!map || !bounds || typeof bounds.isValid !== 'function' || !bounds.isValid()) return;
        const pad = options.padding != null ? options.padding : [50, 50];
        const run = () => {
            try {
                const el = map.getContainer && map.getContainer();
                if (!el || !el.isConnected) return;
                map.invalidateSize(false);
                map.fitBounds(bounds, { padding: pad, animate: false });
            } catch (e) {
                console.warn('[AppControllers] fitBounds', e);
            }
        };
        if (typeof map.whenReady === 'function') {
            map.whenReady(() => requestAnimationFrame(run));
        } else {
            requestAnimationFrame(run);
        }
    }

    applyTripLegMapFromState(state) {
        const leg =
            typeof window.normalizeTripLegState === 'function'
                ? window.normalizeTripLegState(state)
                : state;
        if (!leg) return;
        const modeByLeg = {
            pending_confirm: 'active',
            en_route: 'active',
            driver_arrived: 'active',
            /** Один режим с in_progress — не пересоздаём карту и не рвём LRM между двумя WS. */
            onboard: 'chauffeur',
            in_progress: 'chauffeur',
            paused: 'chauffeur',
            at_destination: 'near_destination',
            finished: 'completed_leg',
        };
        const mode = modeByLeg[leg] || 'active';
        if (mode === 'completed_leg') {
            this._disposeTripMapInstance();
            if (window.taxiApp?.resetMap) window.taxiApp.resetMap();
            return;
        }
        const o = window.taxiApp?.activeOrder;
        if (!o) return;
        const tripId = o.trip_id != null ? Number(o.trip_id) : NaN;
        if (
            mode === 'chauffeur' &&
            !Number.isNaN(tripId) &&
            Number(this._activeChauffeurTripId) === tripId &&
            this.mapInstance?.map &&
            this.mapInstance.taxiToGoal &&
            this.mapInstance.taxiMarker
        ) {
            return;
        }
        const tl = parseFloat(o.taxi_lat);
        const tn = parseFloat(o.taxi_lon);
        const sl = parseFloat(o.start_lat);
        const sn = parseFloat(o.start_lon);
        const el = parseFloat(o.end_lat);
        const en = parseFloat(o.end_lon);
        if (Number.isNaN(tl) || Number.isNaN(tn)) return;
        this.initializeMap(tl, tn, sl, sn, el, en, mode);
    }

    initializeMap(taxi_lat, taxi_lon, start_lat = null, start_lon = null, end_lat = null, end_lon = null, mode = "active") {
        // "active" — такси + клиент + цель + маршруты
        // "waiting" — такси + клиент (без маршрутов)
        // "idle" — только такси
        // "client" — только клиент

        const mapContainer = document.getElementById('map');
        if (!mapContainer) return;

        this._disposeTripMapInstance();

        mapContainer.innerHTML = '<div id="map-inner" style="width:100%;height:100%"></div>';

        const userType = localStorage.getItem('userType') || '';
        const isDriver = userType === 'driver';
        const wantRotate = mode !== 'client';
        const canRotate =
            wantRotate &&
            typeof L !== 'undefined' &&
            typeof L.Map !== 'undefined' &&
            typeof L.Map.prototype.setBearing === 'function';

        const map = L.map('map-inner', {
            zoomControl: false,
            attributionControl: false,
            rotate: !!canRotate,
            bearing: 0,
            rotateControl: false,
        }).setView([taxi_lat, taxi_lon], 14);

        const _jiDark = window.JITaxiMapBasemap?.isDark?.() ?? false;
        const _jiTile = window.JITaxiMapBasemap?.getUrl?.(_jiDark) ?? APP_CONFIG.map.tileLayer;
        L.tileLayer(
            _jiTile,
            APP_CONFIG.map.tileLayerOptions
        ).addTo(map);

        // -------------------------
        // 🚕 Маркер такси / стрелка навигатора (водитель)
        // -------------------------
        let taxiMarker = null;

        if (mode !== "client") { // в режиме client такси не показываем
            const taxiIconOpts = isDriver ? APP_CONFIG.icons.navigation : APP_CONFIG.icons.taxi;
            taxiMarker = L.marker([taxi_lat, taxi_lon], {
                icon: L.icon(taxiIconOpts),
                rotationAngle: 0,
                rotationOrigin: 'center',
                draggable: true,
            }).addTo(map);
        }

        const self = this;

        if (taxiMarker) {
            // Обработчик перетаскивания маркера такси
            taxiMarker.on('drag', function(e) {
                const latLng = e.target.getLatLng();
                if (mode === "active" && start_lat && start_lon) {
                    self.updateRouteFromMarker(latLng.lat, latLng.lng, start_lat, start_lon);
                } else if (mode === 'chauffeur' && isDriver) {
                    const el = parseFloat(end_lat);
                    const en = parseFloat(end_lon);
                    const mi = self.mapInstance;
                    if (mi?.taxiToGoal && !Number.isNaN(el) && !Number.isNaN(en)) {
                        mi.taxiToGoal.setWaypoints([
                            L.latLng(latLng.lat, latLng.lng),
                            L.latLng(el, en),
                        ]);
                    }
                }
            });

            taxiMarker.on('dragend', function(e) {
                const latLng = e.target.getLatLng();
                if (mode === "active" && start_lat && start_lon) {
                    self.updateRouteFromMarker(latLng.lat, latLng.lng, start_lat, start_lon);
                    window.taxiServices.updateDriverLocation(latLng.lat, latLng.lng, latLng.lat, latLng.lng);
                } else if (mode === 'chauffeur' && isDriver) {
                    const el = parseFloat(end_lat);
                    const en = parseFloat(end_lon);
                    const mi = self.mapInstance;
                    if (mi?.taxiToGoal && !Number.isNaN(el) && !Number.isNaN(en)) {
                        mi.taxiToGoal.setWaypoints([
                            L.latLng(latLng.lat, latLng.lng),
                            L.latLng(el, en),
                        ]);
                    }
                    if (window.taxiApp?.activeOrder) {
                        window.taxiApp.activeOrder.taxi_lat = latLng.lat;
                        window.taxiApp.activeOrder.taxi_lon = latLng.lng;
                    }
                    if (window.taxiServices?.updateDriverLocation) {
                        window.taxiServices.updateDriverLocation(latLng.lat, latLng.lng);
                    }
                } else if (mode === 'near_destination' && isDriver) {
                    if (window.taxiApp?.activeOrder) {
                        window.taxiApp.activeOrder.taxi_lat = latLng.lat;
                        window.taxiApp.activeOrder.taxi_lon = latLng.lng;
                    }
                    if (window.taxiServices?.updateDriverLocation) {
                        window.taxiServices.updateDriverLocation(latLng.lat, latLng.lng);
                    }
                }
            });
        }

        // -------------------------
        // 🔄 IDLE режим (только такси)
        // -------------------------
        if (mode === "idle") {
            this.mapInstance = { map, taxiMarker };
            return;
        }

        // -------------------------
        // 👤 CLIENT режим (только клиент)
        // -------------------------
        if (mode === "client") {
            if (start_lat && start_lon) {
                const clientMarker = L.marker([start_lat, start_lon], {
                    icon: L.icon(APP_CONFIG.icons.markerA),
                    draggable: true
                }).addTo(map);

                map.setView([start_lat, start_lon], APP_CONFIG.map.defaultZoom);

                this.mapInstance = { map, clientMarker };
            }
            return;
        }

        // -------------------------
        // 📍 Маркер клиента (pickup) — не в режиме onboard (клиент уже в машине)
        // -------------------------
        let clientLatLng = null;
        let clientMarker = null;
        if (start_lat && start_lon && mode !== 'onboard' && mode !== 'chauffeur') {
            clientLatLng = L.latLng(start_lat, start_lon);
            clientMarker = L.marker([start_lat, start_lon], {
                icon: L.icon(APP_CONFIG.icons.markerA),
                draggable: false
            }).addTo(map);
        }

        // -------------------------
        // ⏳ WAITING режим (без маршрутов)
        // -------------------------
        if (mode === "waiting") {
            const bounds = L.latLngBounds([
                [taxi_lat, taxi_lon],
                [start_lat, start_lon]
            ]);

            this._safeFitBounds(map, bounds);

            this.mapInstance = { map, taxiMarker, clientMarker };
            return;
        }

        // -------------------------
        // 🚗 ONBOARD: клиент сел — только такси, конечная точка B, маршрут такси → B (без маркера подачи)
        // -------------------------
        if (mode === "onboard") {
            if (!end_lat || !end_lon) {
                this.mapInstance = { map, taxiMarker, clientMarker: null, taxiToClient: null, clientToGoal: null, taxiToGoal: null };
                return;
            }
            const goalLL = L.latLng(end_lat, end_lon);
            const goalMarker = L.marker([end_lat, end_lon], {
                icon: L.icon(APP_CONFIG.icons.markerB),
            }).addTo(map);
            const taxiLL = L.latLng(taxi_lat, taxi_lon);
            const taxiToGoal = L.Routing.control({
                waypoints: [taxiLL, goalLL],
                router: L.Routing.osrmv1({ serviceUrl: APP_CONFIG.routing.serviceUrl }),
                routeWhileDragging: false,
                createMarker: () => null,
                addWaypoints: false,
                showAlternatives: false,
                lineOptions: {
                    styles: [{ color: APP_CONFIG.routing.clientToGoalColor || '#007ccf', weight: 4, opacity: 1 }],
                },
            }).addTo(map);

            const bounds = L.latLngBounds([[taxi_lat, taxi_lon], [end_lat, end_lon]]);
            this._safeFitBounds(map, bounds);

            this.mapInstance = {
                map,
                taxiMarker,
                clientMarker: null,
                taxiToClient: null,
                clientToGoal: null,
                taxiToGoal,
                goalMarker,
            };
            return;
        }

        // -------------------------
        // 🛣 CHAUFFEUR: поездка к назначению — маршрут такси → B (динамический)
        // -------------------------
        if (mode === "chauffeur") {
            if (!end_lat || !end_lon) {
                this.mapInstance = { map, taxiMarker, taxiToGoal: null, goalMarker: null };
                return;
            }
            const goalLL = L.latLng(end_lat, end_lon);
            const goalMarker = L.marker([end_lat, end_lon], {
                icon: L.icon(APP_CONFIG.icons.markerB),
            }).addTo(map);
            const taxiLL = L.latLng(taxi_lat, taxi_lon);
            const taxiToGoal = L.Routing.control({
                waypoints: [taxiLL, goalLL],
                router: L.Routing.osrmv1({ serviceUrl: APP_CONFIG.routing.serviceUrl }),
                routeWhileDragging: false,
                createMarker: () => null,
                addWaypoints: false,
                showAlternatives: false,
                lineOptions: {
                    styles: [{ color: APP_CONFIG.routing.clientToGoalColor || '#007ccf', weight: 4, opacity: 1 }],
                },
            }).addTo(map);
            const bounds = L.latLngBounds([[taxi_lat, taxi_lon], [end_lat, end_lon]]);
            this._safeFitBounds(map, bounds);
            this.mapInstance = {
                map,
                taxiMarker,
                clientMarker: null,
                taxiToClient: null,
                clientToGoal: null,
                taxiToGoal,
                goalMarker,
            };
            if (window.taxiApp?.activeOrder?.trip_id != null) {
                this._activeChauffeurTripId = Number(window.taxiApp.activeOrder.trip_id);
            }
            return;
        }

        // У точки назначения: только маркеры, без перестроения маршрута
        if (mode === "near_destination") {
            if (!end_lat || !end_lon) {
                this.mapInstance = { map, taxiMarker, goalMarker: null };
                return;
            }
            const goalMarker = L.marker([end_lat, end_lon], {
                icon: L.icon(APP_CONFIG.icons.markerB),
            }).addTo(map);
            const bounds = L.latLngBounds([[taxi_lat, taxi_lon], [end_lat, end_lon]]);
            this._safeFitBounds(map, bounds);
            this.mapInstance = {
                map,
                taxiMarker,
                clientMarker: null,
                taxiToClient: null,
                clientToGoal: null,
                taxiToGoal: null,
                goalMarker,
            };
            return;
        }

        if (mode === "completed_leg") {
            if (window.taxiApp?.resetMap) {
                window.taxiApp.resetMap();
            }
            this.mapInstance = null;
            this._activeChauffeurTripId = null;
            return;
        }

        // -------------------------
        // 🎯 ACTIVE режим (маршруты)
        // -------------------------
        const taxiLatLng = L.latLng(taxi_lat, taxi_lon);

        if (clientLatLng && taxiMarker) {
            taxiMarker.setRotationAngle(
                MapNav.bearingFromDelta(
                    taxiLatLng.lat,
                    taxiLatLng.lng,
                    clientLatLng.lat,
                    clientLatLng.lng
                )
            );
        }

        // Маркер цели
        let goalLatLng = null;
        if (end_lat && end_lon) {
            goalLatLng = L.latLng(end_lat, end_lon);
            L.marker([end_lat, end_lon], { icon: L.icon(APP_CONFIG.icons.markerB) }).addTo(map);
        }

        // Маршрут такси → клиент
        const taxiToClient = L.Routing.control({
            waypoints: [taxiLatLng, clientLatLng],
            router: L.Routing.osrmv1({ serviceUrl: APP_CONFIG.routing.serviceUrl }),
            routeWhileDragging: false,
            createMarker: () => null,
            addWaypoints: false,
            showAlternatives: false,
            lineOptions: {
                styles: [{ color: APP_CONFIG.routing.taxiToClientColor || 'var(--primary)', weight: 4, opacity: 1 }]
            }
        }).addTo(map);

        // Маршрут клиент → цель
        const clientToGoal = L.Routing.control({
            waypoints: [clientLatLng, goalLatLng],
            router: L.Routing.osrmv1({ serviceUrl: APP_CONFIG.routing.serviceUrl }),
            routeWhileDragging: false,
            createMarker: () => null,
            addWaypoints: false,
            showAlternatives: false,
            lineOptions: {
                styles: [{ color: APP_CONFIG.routing.clientToGoalColor || '#007ccf', weight: 4, opacity: 1 }]
            }
        }).addTo(map);

        const bounds = L.latLngBounds([
            [taxi_lat, taxi_lon],
            [start_lat, start_lon],
            [end_lat, end_lon]
        ]);

        this._safeFitBounds(map, bounds);

        this.mapInstance = { map, taxiMarker, clientMarker, taxiToClient, clientToGoal };
    }

    /** Плавное перемещение маркера такси (lerp + bearing + follow + поворот карты). */
    _lerpTaxiMarker(marker, targetLat, targetLng, onDone) {
        const mi = this.mapInstance;
        if (!mi?.map || !marker) {
            if (onDone) onDone();
            return;
        }
        this._ensureMapNav(mi);
        const map = mi.map;
        const ns = mi.__nav;
        const start = marker.getLatLng();
        const end = L.latLng(targetLat, targetLng);
        if (this._taxiMoveRaf) cancelAnimationFrame(this._taxiMoveRaf);

        let lastILat = start.lat;
        let lastILng = start.lng;
        if (ns.lastFrameLat != null && ns.lastFrameLng != null) {
            lastILat = ns.lastFrameLat;
            lastILng = ns.lastFrameLng;
        }

        let t = 0;
        const step = () => {
            t += 0.12;
            if (t >= 1) {
                marker.setLatLng(end);
                ns.lastFrameLat = end.lat;
                ns.lastFrameLng = end.lng;
                ns.prevLat = end.lat;
                ns.prevLng = end.lng;
                this._taxiMoveRaf = null;
                this._applyVehicleNavFrame(
                    marker,
                    map,
                    ns,
                    end.lat,
                    end.lng,
                    lastILat,
                    lastILng,
                    true
                );
                if (onDone) onDone();
                return;
            }
            const ilat = start.lat + (end.lat - start.lat) * t;
            const ilng = start.lng + (end.lng - start.lng) * t;
            marker.setLatLng([ilat, ilng]);
            this._applyVehicleNavFrame(marker, map, ns, ilat, ilng, lastILat, lastILng, false);
            lastILat = ilat;
            lastILng = ilng;
            ns.lastFrameLat = ilat;
            ns.lastFrameLng = ilng;
            this._taxiMoveRaf = requestAnimationFrame(step);
        };
        this._taxiMoveRaf = requestAnimationFrame(step);
    }

    /** Плавное перемещение маркера клиента (lerp по кадрам). Карта/курс такси — из GPS водителя. */
    _lerpClientMarker(marker, targetLat, targetLng, onDone) {
        const start = marker.getLatLng();
        const end = L.latLng(targetLat, targetLng);
        if (this._clientMoveRaf) cancelAnimationFrame(this._clientMoveRaf);
        let t = 0;
        const step = () => {
            t += 0.12;
            if (t >= 1) {
                marker.setLatLng(end);
                this._clientMoveRaf = null;
                if (onDone) onDone();
                return;
            }
            const ilat = start.lat + (end.lat - start.lat) * t;
            const ilng = start.lng + (end.lng - start.lng) * t;
            marker.setLatLng([ilat, ilng]);
            this._clientMoveRaf = requestAnimationFrame(step);
        };
        this._clientMoveRaf = requestAnimationFrame(step);
    }

    /** Позиция такси с сервера (водитель движется) — клиент и водитель видят один маркер. */
    applyRemoteDriverPosition(lat, lng) {
        const order = window.taxiApp?.activeOrder;
        if (!order || !this.mapInstance) return;

        order.taxi_lat = lat;
        order.taxi_lon = lng;

        const clat = parseFloat(order.pickup_lat ?? order.start_lat);
        const clng = parseFloat(order.pickup_lon ?? order.start_lon);
        const taxiMarker = this.mapInstance.taxiMarker;

        if (!taxiMarker) return;

        if (this.mapInstance.taxiToGoal) {
            const elat = parseFloat(order.end_lat);
            const elng = parseFloat(order.end_lon);
            this._lerpTaxiMarker(taxiMarker, lat, lng, () => {
                if (
                    !Number.isNaN(elat) &&
                    !Number.isNaN(elng) &&
                    this.mapInstance.taxiToGoal
                ) {
                    this.mapInstance.taxiToGoal.setWaypoints([
                        L.latLng(lat, lng),
                        L.latLng(elat, elng),
                    ]);
                }
            });
            return;
        }

        if (!Number.isNaN(clat) && !Number.isNaN(clng) && this.mapInstance.taxiToClient) {
            this._lerpTaxiMarker(taxiMarker, lat, lng, () => {
                this.updateRouteFromMarker(lat, lng, clat, clng, { skipHeading: true });
            });
        } else if (!Number.isNaN(clat) && !Number.isNaN(clng)) {
            this._lerpTaxiMarker(taxiMarker, lat, lng, null);
        } else {
            taxiMarker.setLatLng([lat, lng]);
            this._ensureMapNav(this.mapInstance);
            const mi = this.mapInstance;
            const prevLat = mi.__nav.prevLat != null ? mi.__nav.prevLat : lat;
            const prevLng = mi.__nav.prevLng != null ? mi.__nav.prevLng : lng;
            this._applyVehicleNavFrame(
                taxiMarker,
                mi.map,
                mi.__nav,
                lat,
                lng,
                prevLat,
                prevLng,
                true
            );
            mi.__nav.prevLat = lat;
            mi.__nav.prevLng = lng;
        }
    }

    /** Позиция клиента по WS (только у водителя): не затираем точку подачи из заказа — маршруты taxi→подача и подача→цель по pickup_lat/lon. */
    applyRemoteClientPosition(_liveLat, _liveLng) {
        if (localStorage.getItem('userType') !== 'driver') return;
        const order = window.taxiApp?.activeOrder;
        if (!order || !this.mapInstance) return;

        const liveLat = Number(_liveLat);
        const liveLng = Number(_liveLng);
        if (Number.isNaN(liveLat) || Number.isNaN(liveLng)) return;

        const pickupLat = parseFloat(order.pickup_lat ?? order.start_lat);
        const pickupLng = parseFloat(order.pickup_lon ?? order.start_lon);
        if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) return;

        const cm = this.mapInstance.clientMarker;
        if (!cm) return;

        const afterMove = () => {
            const m = cm.getLatLng();
            const tlat = parseFloat(order.taxi_lat);
            const tlng = parseFloat(order.taxi_lon);
            if (this.mapInstance.taxiToClient && !Number.isNaN(tlat) && !Number.isNaN(tlng)) {
                this.mapInstance.taxiToClient.setWaypoints([
                    L.latLng(tlat, tlng),
                    L.latLng(m.lat, m.lng),
                ]);
            }
            const elat = parseFloat(order.end_lat);
            const elng = parseFloat(order.end_lon);
            if (this.mapInstance.clientToGoal && !Number.isNaN(elat) && !Number.isNaN(elng)) {
                this.mapInstance.clientToGoal.setWaypoints([
                    L.latLng(m.lat, m.lng),
                    L.latLng(elat, elng),
                ]);
            }
        };

        this._lerpClientMarker(cm, liveLat, liveLng, afterMove);
    }

    // Функция для обновления позиции такси и его ориентации
    updateTaxiPosition(newLat, newLng, clientLat, clientLng) {
        if (!this.mapInstance?.taxiMarker) return;

        const taxiMarker = this.mapInstance.taxiMarker;
        const newTaxiLatLng = L.latLng(newLat, newLng);

        taxiMarker.setLatLng(newTaxiLatLng);

        // 🔥 получаем угол по маршруту
        const targetAngle = this.getRotationFromRoute(newTaxiLatLng);

        // текущий угол
        if (this.currentAngle === undefined) {
            this.currentAngle = targetAngle;
        }

        // плавный поворот
        this.currentAngle = this.smoothRotate(
            this.currentAngle,
            targetAngle
        );

        taxiMarker.setRotationAngle(this.currentAngle);
    }

    updateRouteFromMarker(taxiLat, taxiLng, clientLat, clientLng, opts = {}) {
        if (!this.mapInstance?.map || !this.mapInstance.taxiMarker) return;

        const taxiLatLng = L.latLng(taxiLat, taxiLng);
        const clientLatLng = L.latLng(clientLat, clientLng);

        const taxiMarker = this.mapInstance.taxiMarker;

        // Обновляем позицию маркера
        taxiMarker.setLatLng(taxiLatLng);

        if (!opts.skipHeading) {
            const bearing = MapNav.bearingFromDelta(
                taxiLatLng.lat,
                taxiLatLng.lng,
                clientLatLng.lat,
                clientLatLng.lng
            );
            taxiMarker.setRotationAngle(bearing);
        }

        // ✅ Если маршрут уже существует — просто обновляем
        if (this.mapInstance.taxiToClient) {
            this.mapInstance.taxiToClient.setWaypoints([
                taxiLatLng,
                clientLatLng
            ]);
        } else {
            // ✅ Если вдруг маршрута нет — создаём один раз
            this.mapInstance.taxiToClient = L.Routing.control({
                waypoints: [taxiLatLng, clientLatLng],
                router: L.Routing.osrmv1({
                    serviceUrl: APP_CONFIG.routing.serviceUrl
                }),
                routeWhileDragging: false,
                createMarker: () => null,
                addWaypoints: false,
                showAlternatives: false,
                lineOptions: {
                    styles: [{
                        color: APP_CONFIG.routing.taxiToClientColor || 'var(--primary)',
                        weight: 4,
                        opacity: 1
                    }]
                }
            }).addTo(this.mapInstance.map);
        }
    }

    smoothRotate(currentAngle, targetAngle, factor = 0.15) {
        let diff = targetAngle - currentAngle;

        // нормализация угла (-180 → 180)
        diff = ((diff + 180) % 360) - 180;

        return currentAngle + diff * factor;
    }

    getRotationFromRoute(currentLatLng) {
        const coords = this.mapInstance.routeCoordinates;
        if (!coords || coords.length < 2) return this.currentAngle || 0;

        let closestIndex = 0;
        let minDistance = Infinity;

        for (let i = 0; i < coords.length; i++) {
            const dist = currentLatLng.distanceTo(coords[i]);
            if (dist < minDistance) {
                minDistance = dist;
                closestIndex = i;
            }
        }

        const nextIndex = Math.min(closestIndex + 3, coords.length - 1);

        const p1 = coords[closestIndex];
        const p2 = coords[nextIndex];

        return MapNav.bearingFromDelta(p1.lat, p1.lng, p2.lat, p2.lng);
    }

    // ========================
    // Кнопка прогресса заказа
    // ========================

    /**
     * Сбрасывает прогресс кнопки
     * @param {string|HTMLElement} buttonSelector - селектор или элемент кнопки
     */
    resetButtonProgress(buttonSelector = '.new-notification-button') {
        const button = typeof buttonSelector === 'string' 
            ? document.querySelector(buttonSelector) 
            : buttonSelector;
        
        if (!button) return;
        
        const progressBar = button.querySelector('.progress-bar');
        if (!progressBar) return;
        
        console.log("[-----]", progressBar.style.width)
        // Сбрасываем анимации и стили
        progressBar.style.transition = 'none';
        progressBar.style.width = '100%';
        progressBar.style.opacity = '1';
        button.style.color = 'white';
        console.log("[-----]", progressBar.style.width)
        
        // Скрываем лоадер карты (специфично для вашего кода)
        if (this.mapLoadin) {
            this.mapLoadin.classList.remove('hide');
        }

        // Останавливаем таймеры для этой кнопки
        const buttonId = this._getButtonId(button);
        if (this.progressTimeouts && this.progressTimeouts[buttonId]) {
            this.progressTimeouts[buttonId].forEach(timeout => clearTimeout(timeout));
            delete this.progressTimeouts[buttonId];
        }
    }

    /**
     * Запускает прогресс на кнопке
     * @param {Object} options - параметры прогресса
     * @param {number} options.duration - длительность в секундах (по умолчанию 60)
     * @param {string|HTMLElement} options.button - селектор или элемент кнопки (по умолчанию '.new-notification-button')
     * @param {string} options.progressBarSelector - селектор прогресс-бара внутри кнопки (по умолчанию '.progress-bar')
     * @param {number} options.colorChangeAt - момент смены цвета (0-1, по умолчанию 0.5)
     * @param {boolean} options.displayNone - скрывать ли кнопку по остановке (по умолчанию false)
     * @param {string} options.colorChangeTo - цвет после смены (по умолчанию '#016a2f')
     * @param {Function} options.onHalfTime - коллбэк при достижении половины времени
     * @param {Function} options.onComplete - коллбэк при завершении
     * @param {boolean} options.hideModalOnComplete - скрывать ли модалку по завершению (по умолчанию true)
     * @returns {Function} функция для остановки прогресса
     */
    startButtonProgress(options = {}) {
        const {
            duration = 60,
            button = '.new-notification-button',
            progressBarSelector = '.progress-bar',
            colorChangeAt = 0.5,
            displayNone = false,
            colorChangeTo = '#016a2f',
            onHalfTime = null,
            onComplete = null,
            hideModalOnComplete = true,
            tripData = null,

        } = options;

        const buttonElement = typeof button === 'string'
            ? document.querySelector(button)
            : button;

        if (!buttonElement) {
            console.error('Button not found:', button);
            return null;
        }

        const progressBar = buttonElement.querySelector(progressBarSelector);
        if (!progressBar) {
            console.error('Progress bar not found in button');
            return null;
        }

        if (!this.progressTimeouts) {
            this.progressTimeouts = {};
        }

        const buttonId = this._getButtonId(buttonElement);
        buttonElement.dataset.tripId = tripData.trip_id;
        buttonElement.dataset.taxiLat = tripData.taxi_lat;
        buttonElement.dataset.taxiLon = tripData.taxi_lon;

        // Останавливаем предыдущие таймеры
        if (this.progressTimeouts[buttonId]) {
            this.progressTimeouts[buttonId].forEach(t => clearTimeout(t));
        }

        this.progressTimeouts[buttonId] = [];

        // Лоадер
        if (this.mapLoadin) {
            this.mapLoadin.classList.remove('hide');
        }

        // Сброс прогресса
        progressBar.style.transition = 'none';
        progressBar.style.width = '100%';
        progressBar.style.opacity = '1';
        buttonElement.style.color = 'white';

        // Принудительный reflow чтобы transition сработал стабильно
        progressBar.offsetWidth;

        // Запуск анимации
        progressBar.style.transition = `width ${duration}s linear`;
        progressBar.style.width = '0%';

        // Создаём единый stop
        const stop = () => {
            this.stopButtonProgress(buttonElement, displayNone);
        };

        // Half-time
        const halfTimeTimeout = setTimeout(() => {
            if (onHalfTime) onHalfTime(buttonElement, progressBar);
        }, duration * colorChangeAt * 1000);

        // Завершение
        const endTimeout = setTimeout(() => {

            if (onComplete) {
                onComplete(buttonElement, progressBar);
            }

            if (hideModalOnComplete) {
                if (this.orderBlock) this.orderBlock.style.display = 'none';
                if (this.notificationBlock) this.notificationBlock.style.display = 'none';
            }

            stop();

        }, duration * 1000);

        this.progressTimeouts[buttonId].push(halfTimeTimeout, endTimeout);

        return stop;
    }


    /**
     * Останавливает прогресс на кнопке
     */
    stopButtonProgress(button = '.new-notification-button', displayNone = false) {

        const buttonElement = typeof button === 'string'
            ? document.querySelector(button)
            : button;

        if (!buttonElement) return;

        const buttonId = this._getButtonId(buttonElement);

        // Очищаем таймеры
        if (this.progressTimeouts && this.progressTimeouts[buttonId]) {
            this.progressTimeouts[buttonId].forEach(t => clearTimeout(t));
            delete this.progressTimeouts[buttonId];
        }

        const progressBar = buttonElement.querySelector('.progress-bar');

        if (progressBar) {
            progressBar.style.transition = 'none';
            progressBar.style.width = '100%';
            progressBar.style.opacity = '1';
        }

        buttonElement.style.color = 'white';

        if (this.mapLoadin) {
            this.mapLoadin.classList.remove('hide');
        }

        if (displayNone === true) {
            buttonElement.style.display = 'none';
        }
    }

    /**
     * Вспомогательный метод для получения ID кнопки
     * @private
     */
    _getButtonId(buttonElement) {
        return buttonElement.id || 
            buttonElement.className.replace(/\s+/g, '_') || 
            `button_${Math.random().toString(36).substr(2, 9)}`;
    }


    getDistanceInMeters(taxi_lat, taxi_lon, client_lat, client_lon) {
        const R = 6371000;
        const toRad = deg => deg * Math.PI / 180;

        const lat1 = toRad(taxi_lat);
        const lat2 = toRad(client_lat);
        const dLat = toRad(client_lat - taxi_lat);
        const dLon = toRad(client_lon - taxi_lon);

        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) *
            Math.cos(lat2) *
            Math.sin(dLon / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    showArrivedButton(show) {
        if (!this.orderTaxiProgressArrivedBtn) return;

        if (show && window.taxiApp?._tripProximityUi?.arrivedPressed) {
            return;
        }

        if (show) {
            this.orderTaxiProgressArrivedBtn.style.display = 'flex';
            this.orderTaxiProgressArrivedBtn.disabled = false;} 
        
        else {
            this.orderTaxiProgressArrivedBtn.style.display = 'none';
            this.orderTaxiProgressArrivedBtn.disabled = true;}
    }

    showStartedButton(show) {
        if (!this.orderTaxiProgressStartedBtn) return;

        if (show && window.taxiApp?._tripProximityUi?.onboardPressed) {
            return;
        }

        if (show) {
            this.orderTaxiProgressStartedBtn.style.display = 'flex';
            this.orderTaxiProgressStartedBtn.disabled = false;} 
        
        else {
            this.orderTaxiProgressStartedBtn.style.display = 'none';
            this.orderTaxiProgressStartedBtn.disabled = true;}
    }

    showDestinationArrivedButton(show) {
        if (!this.orderTaxiProgressDestinationBtn) return;
        if (show && window.taxiApp?._tripProximityUi?.destinationArrivedPressed) {
            return;
        }
        if (show) {
            this.orderTaxiProgressDestinationBtn.style.display = 'flex';
            this.orderTaxiProgressDestinationBtn.disabled = false;
        } else {
            this.orderTaxiProgressDestinationBtn.style.display = 'none';
            this.orderTaxiProgressDestinationBtn.disabled = true;
        }
    }

    async confirmationTrip(tripData, userType='client') {
        
        console.log('[*] Подтверждение поездки с данными:', tripData, 'для пользователя типа:', userType);

        document.querySelector('.order-panel').style.display = 'none';
        document.querySelector('.order-info').style.display = 'block';
        document.getElementById('order-modal').style.display = 'none';
        document.getElementById('order-modal-taxi-details').style.display = 'none';
        document.getElementById('taxi-notification-block').style.display = 'none';
        
        this.orderProgressCancelBtn.dataset.tripId = tripData.trip_id;
        this.orderTaxiProgressArrivedBtn.dataset.tripId = tripData.trip_id;
        this.orderTaxiProgressStartedBtn.dataset.tripId = tripData.trip_id;
        if (this.orderTaxiProgressDestinationBtn) {
            this.orderTaxiProgressDestinationBtn.dataset.tripId = tripData.trip_id;
        }

        this.orderProgressCancelBtn.dataset.taxiLat = tripData.taxi_lat;
        this.orderProgressCancelBtn.dataset.taxiLon = tripData.taxi_lon;
        this.orderProgressCancelBtn.style.display = "flex";

        const timeToUser = await window.taxiApp.calculateDrivingTime({lat: tripData.taxi_lat, lng: tripData.taxi_lon}, {lat: tripData.start_lat, lng: tripData.start_lon});
        
        window.taxiApp.safeSetTextContent('additional-price', tripData.price + ' ₼');
        window.taxiApp.safeSetTextContent('client-totla-price', tripData.price + ' ₼');
        window.taxiApp.safeSetTextContent('additional-price-order', tripData.price + ' ₼');
        window.taxiApp.safeSetTextContent('client-totla-price-order', tripData.price + ' ₼');
        window.taxiApp.safeSetTextContent('additional-metrs-order', tripData.distance + ' km');
        window.taxiApp.safeSetTextContent('additional-timer-order', tripData.driving_time);

        // Если это клиент, то показываем информацию о водителе
        if (userType === 'client') {
            document.getElementById('modal-taxi-avatar-order').src = "data:image/png;base64," + tripData.taxi_avatar;
            document.getElementById('phone-call-block').href = 'tel:' + tripData.taxi_phone.replace(/[^\d+]/g, '');
            window.taxiApp.safeSetTextContent('client-taxi-go-time-order', timeToUser);
            window.taxiApp.safeSetTextContent('modal-taxi-car-name-order', tripData.taxi_car_name ?? '');
            window.taxiApp.safeSetTextContent('modal-taxi-name-order', tripData.taxi_name ?? '');
            window.taxiApp.safeSetTextContent('modal-taxi-rating-order', tripData.taxi_rating ?? '');
            window.taxiApp.safeSetTextContent('modal-taxi-car-model-order', tripData.taxi_car_model ?? '');
            //  `${tripData.taxi_car_model}${tripData.taxi_car_year ? ' • ' + tripData.taxi_car_year : ''}`: ''

            window.taxiApp.safeSetTextContent('modal-taxi-car-number-order', tripData.taxi_car_number ?? '');
            document.querySelectorAll('.class-for-taxi-car-number').forEach(el => el.textContent = tripData.taxi_car_number);
            document.querySelectorAll('.class-for-taxi-car-model').forEach(el => el.textContent = tripData.taxi_car_name ?? '');
            //  `${tripData.taxi_car_name}` + `${tripData.taxi_car_year ? ' • ' + tripData.taxi_car_year : ''}` + `${tripData.taxi_car_category ? ' • ' + tripData.taxi_car_category : ''}` : ''
            
            document.querySelectorAll('.client-taxi-end-address-order').forEach(el => {el.textContent = tripData.end_address;});
            window.taxiApp.safeSetTextContent('modal-taxi-car-number-order', tripData.taxi_car_number ?? '');
        } 
        
        // Если это водитель, то показываем информацию о клиенте
        else if (userType === 'driver') {
            console.log('[*] Отображаем информацию о клиенте для водителя');
            const avatar = document.getElementById('modal-taxi-avatar-order');

            // Если аватара имеется, показываем иконку по умолчанию, иначе - аватар
            if (tripData.client_avatar) {
                avatar.src = typeof window.profileAvatarSrc === 'function'
                    ? window.profileAvatarSrc(tripData.client_avatar)
                    : ('data:image/png;base64,' + tripData.client_avatar);
                avatar.style.display = 'block';
            } else {
                avatar.src = '/static/images/user-profile-avatar.png';
                avatar.style.display = 'block';
            }

            console.log('[*] Данные клиента:', {
                name: tripData.client_name,
                phone: tripData.client_phone,
                rating: tripData.client_rating,
            });

            console.log('[*] Данные водителя:', {
                name: tripData.taxi_name,
                phone: tripData.taxi_phone,
                rating: tripData.taxi_rating,
                carYear: tripData.taxi_car_year,
                carModel: tripData.taxi_car_model,
                carCategory: tripData.taxi_car_category,
            });

            {
                const avOrder = document.getElementById('modal-taxi-avatar-order');
                if (avOrder && tripData.client_avatar) {
                    avOrder.src = typeof window.profileAvatarSrc === 'function'
                        ? window.profileAvatarSrc(tripData.client_avatar)
                        : ('data:image/png;base64,' + tripData.client_avatar);
                } else if (avOrder) {
                    avOrder.src = '/static/images/user-profile-avatar.png';
                }
            }
            document.getElementById('phone-call-block').href = 'tel:' + tripData.client_phone.replace(/[^\d+]/g, '');
            window.taxiApp.safeSetTextContent('client-taxi-go-time-order', timeToUser);
            window.taxiApp.safeSetTextContent('modal-taxi-car-name-order', tripData.taxi_car_name ?? '');
            window.taxiApp.safeSetTextContent('modal-taxi-name-order', tripData.client_name ?? '');
            window.taxiApp.safeSetTextContent('modal-taxi-rating-order', tripData.client_rating ?? '');
            window.taxiApp.safeSetTextContent('modal-taxi-car-model-order', tripData.taxi_car_model ?? '');
            //  `${tripData.taxi_car_model}${tripData.taxi_car_year ? ' • ' + tripData.taxi_car_year : ''}`: ''

            window.taxiApp.safeSetTextContent('modal-taxi-car-number-taxi', tripData.taxi_car_number ?? '');
            window.taxiApp.safeSetTextContent('modal-taxi-car-model-taxi', tripData.taxi_car_name ?? '');
            // + `${tripData.taxi_car_year ? ' • ' + tripData.taxi_car_year : ''}` + `${tripData.taxi_car_category ? ' • ' + tripData.taxi_car_category : ''}` : ''
            
            document.querySelectorAll('.class-for-taxi-car-number').forEach(el => el.textContent = tripData.taxi_car_number ?? '');
            document.querySelectorAll('.class-for-taxi-car-model').forEach(el => el.textContent = tripData.taxi_car_name ?? '');
            
            document.querySelectorAll('.client-taxi-end-address-order').forEach(el => {el.textContent = tripData.end_address;});
            window.taxiApp.safeSetTextContent('modal-taxi-car-number-order', tripData.taxi_car_number ?? '');
            // tripData.taxi_car_model ? `${tripData.taxi_car_model}${tripData.taxi_car_year ? ' • ' + tripData.taxi_car_year : ''}`: '');
            
            await this.toggleBottomNav('taxi.active.trip');    
        }
        this.initializeMap(tripData.taxi_lat, tripData.taxi_lon, tripData.start_lat, tripData.start_lon, tripData.end_lat, tripData.end_lon);
        tripData.pickup_lat = tripData.start_lat;
        tripData.pickup_lon = tripData.start_lon;
        window.taxiApp.activeOrder = tripData; // Сохраняем данные поездки в глобальном объекте приложения для доступа из других частей приложения
        window.taxiApp.syncClientPickupMarkerDrag?.();
        if (userType === 'driver' && window.taxiApp?.stopDriverLocationTracking && window.taxiApp?.startDriverLocationTracking) {
            window.taxiApp.stopDriverLocationTracking();
            window.taxiApp.startDriverLocationTracking();
        }
        if (window.taxiApp && tripData.trip_id != null) {
            window.taxiApp._tripProximityUi = {
                tripId: Number(tripData.trip_id),
                arrivedPressed: false,
                onboardPressed: false,
                destinationArrivedPressed: false,
            };
        }
        if (this.orderTaxiProgressDestinationBtn) {
            this.showDestinationArrivedButton(false);
        }


    }
}

// Инициализация контроллеров после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
    window.appControllers = new AppControllers();
});