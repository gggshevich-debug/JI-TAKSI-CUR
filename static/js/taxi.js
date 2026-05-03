class TaxiControlles {
    constructor(appConfig) {
        this.APP_CONFIG = appConfig;

        this.taxiNotificationButton = document.getElementById('taxi-notification-button');
        this.taxiMessageTextBlock = document.getElementById('new-notification-message-text-block');
        this.taxiDeclineorderButton = document.getElementById('decline-taxi-order-button');
        this.orderBlock = document.getElementById('order-modal');
        this.notificationBlock = document.getElementById('taxi-notification-block');
        this.allowOrderButton = document.getElementById('allow-taxi-order-button');
        this.mapLoadin = document.querySelector('.mini-map-loadin');
        this.mapInstance = null;
        /** Снимок последнего входящего заказа — восстановить UI при ошибке API после «Bağla». */
        this._lastTripOfferForRestore = null;
        this.initStatusButton();
        this.initDriverWaitDecline();
    }

    // ========================
    // Таксист: кнопка статуса
    // ========================
    initStatusButton() {
        if (!this.taxiNotificationButton) return;

        this.taxiNotificationButton.addEventListener('click', () => {
            const btn = this.taxiNotificationButton;
            const p = String(btn.dataset.driverPresence || '').toLowerCase();
            let isOnline;
            if (p === 'available' || p === 'busy') isOnline = true;
            else if (p === 'offline') isOnline = false;
            else isOnline = btn.classList.contains('available');

            const status = isOnline ? 'offline' : 'available';
            const rollbackPresence =
                p === 'available' || p === 'busy' || p === 'offline'
                    ? p
                    : (btn.classList.contains('available') ? 'available' : 'offline');

            // Web Push: запрос разрешения в том же пользовательском жесте (до await в sendTaxiStatus).
            if (
                status === 'available' &&
                window.JIPWA &&
                typeof window.JIPWA.subscribePush === 'function' &&
                window.JIPWA.isPushLikelySupported &&
                window.JIPWA.isPushLikelySupported()
            ) {
                void window.JIPWA.subscribePush().catch((e) =>
                    console.warn('[PWA] subscribePush (driver online):', e)
                );
            }
            btn.classList.remove('offline', 'available');
            btn.classList.add('spinner');

            void this.sendTaxiStatus(status, rollbackPresence);
        });

        this.allowOrderButton.addEventListener('click', async () => {
            const tripData = {
                clientID: this.allowOrderButton.dataset.clientId,
                tripID: this.allowOrderButton.dataset.tripId,
                fromLocation: [this.allowOrderButton.dataset.startLat, this.allowOrderButton.dataset.startLon],
                toLocation: [this.allowOrderButton.dataset.endLat, this.allowOrderButton.dataset.endLon],
                taxiLocation: [this.allowOrderButton.dataset.taxiLat, this.allowOrderButton.dataset.taxiLon],
                startAddress: this.allowOrderButton.dataset.startAddress,
                endAddress: this.allowOrderButton.dataset.endAddress,
                distance: this.allowOrderButton.dataset.distance,
                drivingTime: this.allowOrderButton.dataset.time
            };

            try {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast('Нет сети. Принятие заказа недоступно офлайн.', 'warn');
                    }
                    return;
                }
                const idempotency_key =
                    typeof crypto !== 'undefined' && crypto.randomUUID
                        ? crypto.randomUUID()
                        : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
                if (!window.taxiServices?.checkTrip) {
                    console.error('taxiServices.checkTrip недоступен');
                    return;
                }
                const data = await window.taxiServices.checkTrip({
                    ...tripData,
                    idempotency_key,
                });
                if (data?.offline) {
                    const om = data.message || 'Нет сети.';
                    if (typeof window.showAppToast === 'function') window.showAppToast(om, 'warn');
                    return;
                }
                if (!data.success) {
                    if (data.silent || data.code === 'TRIP_NOT_OPEN' || data.code === 'TRIP_NOT_FOUND') {
                        this.hideTripOfferPanel();
                        return;
                    }
                    const msg = data.message || data.detail || 'Не удалось принять заказ';
                    if (typeof window.showAppToast === 'function') window.showAppToast(msg, 'error');
                    return;
                }

                this.allowOrderButton.style.display = 'none';
                this.taxiMessageTextBlock.style.display = 'flex';
                this.taxiDeclineorderButton.style.display = 'flex';
                this.resetButtonProgress(this.allowOrderButton);
                this.stopButtonProgress(this.allowOrderButton);


                // const data = await response.json();
                // this.initializeMainMap(this.allowOrderButton.dataset.taxiLat, this.allowOrderButton.dataset.taxiLon, 
                //     this.allowOrderButton.dataset.startLat, this.allowOrderButton.dataset.startLon, 
                //     this.allowOrderButton.dataset.endLat, this.allowOrderButton.dataset.endLon)
                
                // this.orderBlock.style.display = 'none';
                // this.notificationBlock.style.display = 'none';
                

                // return data;
            } catch (error) {
                console.error('Error creating order:', error);
                return null;
            }

        });
    }

    hideTripOfferPanel() {
        const allowBtn = this.allowOrderButton;
        try {
            if (allowBtn) {
                this.resetButtonProgress(allowBtn);
                this.stopButtonProgress(allowBtn);
            }
        } catch (_) {
            /* ignore */
        }
        if (this.orderBlock) this.orderBlock.style.display = 'none';
        if (this.notificationBlock) this.notificationBlock.style.display = 'none';
        if (this.taxiDeclineorderButton) this.taxiDeclineorderButton.style.display = 'none';
        if (this.allowOrderButton) this.allowOrderButton.style.display = 'none';
        if (this.taxiMessageTextBlock) this.taxiMessageTextBlock.style.display = 'none';
        const om = document.getElementById('order-modal');
        if (om) om.style.display = 'none';
        const det = document.getElementById('order-modal-taxi-details');
        if (det) det.style.display = 'none';
        if (window.appControllers?.toggleBottomNav) {
            void window.appControllers.toggleBottomNav('taxi');
        }
    }

    initDriverWaitDecline() {
        if (!this.taxiDeclineorderButton) return;
        this.taxiDeclineorderButton.addEventListener('click', async () => {
            const tid = this.allowOrderButton?.dataset?.tripId;
            if (!tid) return;
            const restore = this._lastTripOfferForRestore
                ? { ...this._lastTripOfferForRestore }
                : null;
            try {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast('Нет сети.', 'warn');
                    }
                    return;
                }
                if (!window.taxiServices?.driverReleaseAwaitingClient) {
                    console.error('taxiServices.driverReleaseAwaitingClient недоступен');
                    return;
                }
                this.taxiDeclineorderButton.disabled = true;
                this.hideTripOfferPanel();
                const data = await window.taxiServices.driverReleaseAwaitingClient(tid);
                if (data?.offline) {
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast(data.message || 'Нет сети.', 'warn');
                    }
                    if (restore && typeof this.showTripOrder === 'function') {
                        await this.showTripOrder(restore);
                    }
                    this.taxiDeclineorderButton.disabled = false;
                    return;
                }
                if (!data?.success) {
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast(
                            data?.message || 'Не удалось отменить ожидание.',
                            'error'
                        );
                    }
                    if (restore && typeof this.showTripOrder === 'function') {
                        await this.showTripOrder(restore);
                    }
                    this.taxiDeclineorderButton.disabled = false;
                    return;
                }
                this._lastTripOfferForRestore = null;
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast(
                        'Вы отказались ждать клиента. Заказ снова в поиске у клиента.',
                        'info',
                        10000
                    );
                }
            } catch (e) {
                console.error('[taxi] driver release awaiting client', e);
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast('Ошибка сети или сервера.', 'error');
                }
                if (restore && typeof this.showTripOrder === 'function') {
                    await this.showTripOrder(restore);
                }
            } finally {
                if (this.taxiDeclineorderButton) this.taxiDeclineorderButton.disabled = false;
            }
        });
    }

    /**
     * @param {'available'|'offline'} status
     * @param {string} [rollbackPresence] — dataset driverPresence до запроса (available|busy|offline)
     */
    async sendTaxiStatus(status, rollbackPresence = null) {
        try {
            const response = await fetch('/api/taxi-status', {
                credentials: 'include',
                method: 'post',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: status,
                    last_lat: this.userLatLng?.lat || 0,
                    last_lng: this.userLatLng?.lng || 0
                })
            });
            const result = await response.json();
            if (result.success) {
                window.taxiApp?.updateTaxiStatusUI(status);
            } else if (rollbackPresence != null && window.taxiApp?.updateTaxiStatusUI) {
                window.taxiApp.updateTaxiStatusUI(rollbackPresence);
            } else if (window.taxiApp?.refreshDriverNotificationFromServer) {
                await window.taxiApp.refreshDriverNotificationFromServer();
            }

            // await window.appControllers.toggleBottomNav('taxi');

        } catch (err) {
            console.error('Ошибка при отправке статуса таксиста:', err);
            if (rollbackPresence != null && window.taxiApp?.updateTaxiStatusUI) {
                window.taxiApp.updateTaxiStatusUI(rollbackPresence);
            } else if (window.taxiApp?.refreshDriverNotificationFromServer) {
                await window.taxiApp.refreshDriverNotificationFromServer();
            }
        } finally {
            this.taxiNotificationButton.classList.remove('spinner');
        }
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
        
        // Сбрасываем анимации и стили
        progressBar.style.transition = 'none';
        progressBar.style.width = '100%';
        progressBar.style.opacity = '1';
        button.style.color = 'white';
        
        // Скрываем лоадер карты (специфично для вашего кода)
        if (this.mapLoadin) {
            this.mapLoadin.classList.remove('hide');
        }

        // Останавливаем таймеры для этой кнопки (включая отложенный kickoff ширины 0%)
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
     * @param {string} options.colorChangeTo - цвет после смены (по умолчанию '#016a2f')
     * @param {Function} options.onHalfTime - коллбэк при достижении половины времени
     * @param {Function} options.onComplete - коллбэк при завершении
     * @param {boolean} options.hideModalOnComplete - скрывать ли модалку по завершению (по умолчанию true)
     * @returns {Function} функция для остановки прогресса
     */
    startButtonProgress(options = {}) {
        // Параметры по умолчанию
        const {
            duration = 60,
            button = '.new-notification-button',
            progressBarSelector = '.progress-bar',
            colorChangeAt = 0.5,
            colorChangeTo = '#016a2f',
            onHalfTime = null,
            onComplete = null,
            hideModalOnComplete = true
        } = options;
        
        // Находим кнопку
        const buttonElement = typeof button === 'string' 
            ? document.querySelector(button) 
            : button;
        
        if (!buttonElement) {
            console.error('Button not found:', button);
            return null;
        }
        
        // Находим прогресс-бар
        const progressBar = buttonElement.querySelector(progressBarSelector);
        if (!progressBar) {
            console.error('Progress bar not found in button');
            return null;
        }
        
        // Инициализируем хранилище таймеров
        if (!this.progressTimeouts) {
            this.progressTimeouts = {};
        }
        
        // Уникальный ID для кнопки
        const buttonId = this._getButtonId(buttonElement);
        
        // Останавливаем предыдущие таймеры для этой кнопки
        if (this.progressTimeouts[buttonId]) {
            this.progressTimeouts[buttonId].forEach(timeout => clearTimeout(timeout));
            this.progressTimeouts[buttonId] = [];
        } else {
            this.progressTimeouts[buttonId] = [];
        }
        
        // Скрываем лоадер карты (специфично для вашего кода)
        if (this.mapLoadin) {
            this.mapLoadin.classList.remove('hide');
        }
        
        // Сбрасываем прогресс
        progressBar.style.transition = 'none';
        progressBar.style.width = '100%';
        progressBar.style.opacity = '1';
        buttonElement.style.color = 'white';
        
        // Запускаем анимацию прогресса (таймер обязан попадать в progressTimeouts — иначе при новом заказе
        // старый kickoff сбросит ширину в 0% после reset нового предложения).
        const kickoffTimeout = setTimeout(() => {
            progressBar.style.transition = `width ${duration}s linear`;
            progressBar.style.width = '0%';
        }, 10);
        this.progressTimeouts[buttonId].push(kickoffTimeout);
        
        // Таймер для смены цвета
        const halfTimeTimeout = setTimeout(() => {
            buttonElement.style.color = colorChangeTo;
            if (onHalfTime) onHalfTime(buttonElement, progressBar);
        }, duration * colorChangeAt * 1000);
        
        // Таймер для завершения
        const endTimeout = setTimeout(() => {
            // Вызываем пользовательский коллбэк
            if (onComplete) {
                onComplete(buttonElement, progressBar);
            }
            try {
                this.stopButtonProgress(buttonElement);
            } catch (_) {
                /* ignore */
            }
            
            // Скрываем карточку заказа и поднимаем bottom-nav (тот же путь, что при отказе / тихом закрытии)
            if (hideModalOnComplete) {
                this.hideTripOfferPanel();
            }
            
            // Очищаем таймеры после завершения
            delete this.progressTimeouts[buttonId];
        }, duration * 1000);
        
        // Сохраняем таймеры
        this.progressTimeouts[buttonId].push(halfTimeTimeout, endTimeout);
        
        // Возвращаем функцию для остановки прогресса
        return () => this.stopButtonProgress(buttonElement);
    }

    /**
     * Останавливает прогресс на кнопке
     * @param {string|HTMLElement} button - селектор или элемент кнопки
     */
    stopButtonProgress(button = '.new-notification-button') {
        const buttonElement = typeof button === 'string' 
            ? document.querySelector(button) 
            : button;
        
        if (!buttonElement) return;
        
        const buttonId = this._getButtonId(buttonElement);
        
        // Останавливаем таймеры
        if (this.progressTimeouts && this.progressTimeouts[buttonId]) {
            this.progressTimeouts[buttonId].forEach(timeout => clearTimeout(timeout));
            delete this.progressTimeouts[buttonId];
        }
        
        // Сбрасываем визуальное состояние
        const progressBar = buttonElement.querySelector('.progress-bar');
        if (progressBar) {
            progressBar.style.transition = 'none';
            progressBar.style.width = '100%';
            progressBar.style.opacity = '1';
        }
        buttonElement.style.color = 'white';
        
        // Скрываем лоадер карты
        if (this.mapLoadin) {
            this.mapLoadin.classList.remove('hide');
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

    // ========================
    // Мини-карта, маршруты и главная карта
    // ========================
    initializeMainMap(taxi_lat, taxi_lon, start_lat, start_lon, end_lat, end_lon) {
        const container = document.getElementById('map');
        window.taxiApp.showLocationLoading(true);

        console.log('[*] КОНТЕЙНЕР ГЛАВНОЙ КАРТЫ НАЙДЕН');
        if (!container) {
            console.log('[!] КОНТЕЙНЕР ГЛАВНОЙ КАРТЫ ОТСУТСТВУЕТ'); 
            return;
        }

        // Полностью уничтожаем предыдущую карту
        if (this.mainMapInstance?.map) {
            console.log('[*] УДАЛЯЕМ СТАРУЮ КАРТУ');
            this.mainMapInstance.map.remove();
            this.mainMapInstance = null;
        }

        // Полностью пересоздаем контейнер
        console.log('[*] ПЕРЕСОЗДАЕМ КОНТЕЙНЕР');
        const parent = container.parentNode;
        const newContainer = document.createElement('div');
        newContainer.id = 'map';
        newContainer.className = 'map-container';
        newContainer.style.width = '100%';
        newContainer.style.height = '100%';

        // Добавляем кнопку моих локаций
        const myLocationsBtn = document.createElement('div');
        myLocationsBtn.className = 'my-locations';
        myLocationsBtn.id = 'my-locations-btn';
        myLocationsBtn.innerHTML = '<svg width="30px" height="30px" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true" role="img" class="iconify iconify--gis" preserveAspectRatio="xMidYMid meet" fill="#000000"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path d="M43 0v13.166C27.944 16.03 16.03 27.944 13.166 43H0v14h13.166C16.03 72.056 27.944 83.97 43 86.834V100h14V86.834C72.056 83.97 83.97 72.056 86.834 57H100V43H86.834C83.97 27.944 72.056 16.03 57 13.166V0H43zm7 22.5A27.425 27.425 0 0 1 77.5 50A27.425 27.425 0 0 1 50 77.5A27.425 27.425 0 0 1 22.5 50A27.425 27.425 0 0 1 50 22.5z" fill="#5c5c5c"></path><circle r="15" cy="50" cx="50" fill="#6f6f6fa3"></circle></g></svg>';

        newContainer.appendChild(myLocationsBtn);
        parent.replaceChild(newContainer, container);

        // Даем время на обновление DOM
        setTimeout(() => {
            try {
                console.log('[*] СОЗДАЕМ НОВУЮ КАРТУ');
                const userLatLng = window.taxiApp.fromMarker ? 
                    [window.taxiApp.fromMarker.getLatLng().lat, window.taxiApp.fromMarker.getLatLng().lng] : 
                    [taxi_lat, taxi_lon];

                console.log('[&] Pезультат usrLatLng:', userLatLng);

                // Создаем карту
                const map = L.map('map', {
                    zoomControl: true,
                    attributionControl: false,
                    rotate: false,
                    rotateControl: false,
                }).setView(userLatLng, 19);

                const _jiD = window.JITaxiMapBasemap?.isDark?.() ?? false;
                const _jiU = window.JITaxiMapBasemap?.getUrl?.(_jiD) ?? this.APP_CONFIG.map.tileLayer;
                L.tileLayer(_jiU, this.APP_CONFIG.map.tileLayerOptions).addTo(map);

                // Маркеры
                L.marker([taxi_lat, taxi_lon], { icon: L.icon(this.APP_CONFIG.icons.taxi) }).addTo(map);
                L.marker([start_lat, start_lon], { icon: L.icon(this.APP_CONFIG.icons.markerA) }).addTo(map);
                L.marker([end_lat, end_lon], { icon: L.icon(this.APP_CONFIG.icons.markerB) }).addTo(map);

                // Функция для принудительного обновления и зума
                const forceZoom = () => {
                    console.log('[*] Принудительное обновление размера карты');
                    map.invalidateSize(true);
                    
                    // Несколько попыток с небольшими задержками
                    setTimeout(() => {
                        map.setView(userLatLng, 19, {
                            animate: false,
                            duration: 0
                        });
                        console.log('[*] Первая попытка зума на', userLatLng, 'с зумом 19');
                    }, 50);
                    
                    setTimeout(() => {
                        map.setView(userLatLng, 19, {
                            animate: false,
                            duration: 0
                        });
                        console.log('[*] Вторая попытка зума на', userLatLng, 'с зумом 19');
                    }, 150);
                    
                    setTimeout(() => {
                        map.setView(userLatLng, 19, {
                            animate: false,
                            duration: 0
                        });
                        console.log('[*] Третья попытка зума на', userLatLng, 'с зумом 19');
                    }, 300);
                };

                // Проверяем доступность Routing
                if (typeof L.Routing !== 'undefined') {
                    console.log('[*] СОЗДАЕМ МАРШРУТЫ');

                    // Сегмент 1: таксист -> клиент
                    const taxiToClient = L.Routing.control({
                        waypoints: [
                            L.latLng(taxi_lat, taxi_lon),
                            L.latLng(start_lat, start_lon)
                        ],
                        router: L.Routing.osrmv1({ serviceUrl: this.APP_CONFIG.routing.serviceUrl }),
                        routeWhileDragging: false,
                        createMarker: () => null,
                        addWaypoints: false,
                        lineOptions: {
                            styles: [{ color: this.APP_CONFIG.routing.taxiToClientColor || 'var(--primary)', weight: 4, opacity: 1, zIndex: 99999 }]
                        },
                        showAlternatives: false
                    }).addTo(map);

                    // Сегмент 2: клиент -> цель
                    const clientToGoal = L.Routing.control({
                        waypoints: [
                            L.latLng(start_lat, start_lon),
                            L.latLng(end_lat, end_lon)
                        ],
                        router: L.Routing.osrmv1({ serviceUrl: this.APP_CONFIG.routing.serviceUrl }),
                        routeWhileDragging: false,
                        createMarker: () => null,
                        addWaypoints: false,
                        lineOptions: {
                            styles: [{ color: this.APP_CONFIG.routing.clientToGoalColor || '#007ccfff', weight: 4, opacity: 1, zIndex: 99999 }]
                        },
                        showAlternatives: false
                    }).addTo(map);

                    this.mainMapInstance = { map, taxiToClient, clientToGoal };

                } else {
                    console.log('[*] ИСПОЛЬЗУЕМ ПРОСТЫЕ ЛИНИИ');
                    // fallback: простые линии
                    L.polyline([
                        [taxi_lat, taxi_lon],
                        [start_lat, start_lon]
                    ], { color: this.APP_CONFIG.routing.taxiToClientColor || 'var(--primary)', weight: 4 }).addTo(map);

                    L.polyline([
                        [start_lat, start_lon],
                        [end_lat, end_lon]
                    ], { color: this.APP_CONFIG.routing.clientToGoalColor || '#007ccfff', weight: 4 }).addTo(map);

                    this.mainMapInstance = { map };
                }

                // Принудительное обновление с задержкой
                setTimeout(forceZoom, 100);
                
                // Дополнительное обновление через 500мс на всякий случай
                setTimeout(forceZoom, 500);

                console.log('[*] КАРТА УСПЕШНО СОЗДАНА');
                window.taxiApp.showLocationLoading(false);

            } catch (error) {
                console.error('Error initializing main map:', error);
                window.taxiApp.showLocationLoading(false);
            }
        }, 100);
    }

    initializeMiniMap(taxi_lat, taxi_lon, start_lat, start_lon, end_lat, end_lon) {
        const container = document.getElementById('mini-map');
        this.mapLoadin.classList.add('hide');
        
        console.log('[*] КОНТЕЙНЕР НАЙДЕН')
        if (!container) {console.log('[!] КОНТЕЙНЕР ОТСУТСТВУЕТ'); return;}

        // Полностью очищаем контейнер и создаем новый элемент
        if (this.mapInstance?.map) {
            this.mapInstance.map.remove();
            this.mapInstance = null;
            
            // Полностью очищаем контейнер
            container.innerHTML = '';
            
            // Создаем новый div для карты
            const newMapContainer = document.createElement('div');
            newMapContainer.id = 'mini-map';
            newMapContainer.style.width = '100%';
            newMapContainer.style.height = '100%';
            container.appendChild(newMapContainer);
        }

        // Создаем карту
        const map = L.map('mini-map', {
            zoomControl: false,
            attributionControl: false,
            rotate: false,
            rotateControl: false,
        }).setView([taxi_lat, taxi_lon], 14);

        const _jiD2 = window.JITaxiMapBasemap?.isDark?.() ?? false;
        const _jiU2 = window.JITaxiMapBasemap?.getUrl?.(_jiD2) ?? this.APP_CONFIG.map.tileLayer;
        L.tileLayer(_jiU2, this.APP_CONFIG.map.tileLayerOptions).addTo(map);

        // Маркеры
        L.marker([taxi_lat, taxi_lon], { icon: L.icon(this.APP_CONFIG.icons.taxi) }).addTo(map);
        L.marker([start_lat, start_lon], { icon: L.icon(this.APP_CONFIG.icons.markerA) }).addTo(map);
        L.marker([end_lat, end_lon], { icon: L.icon(this.APP_CONFIG.icons.markerB) }).addTo(map);

        setTimeout(() => {
            // Обновляем размер карты
            map.invalidateSize();
                
            // Проверяем доступность Routing
            if (typeof L.Routing !== 'undefined') {

                // Сегмент 1: таксист -> клиент
                const taxiToClient = L.Routing.control({
                    waypoints: [
                        L.latLng(taxi_lat, taxi_lon),
                        L.latLng(start_lat, start_lon)
                    ],
                    router: L.Routing.osrmv1({ serviceUrl: this.APP_CONFIG.routing.serviceUrl }),
                    routeWhileDragging: false,
                    createMarker: () => null,
                    addWaypoints: false,
                    lineOptions: {
                        styles: [{ color: this.APP_CONFIG.routing.taxiToClientColor || 'var(--primary)', weight: 4, opacity: 1, zIndex: 99999 }]
                    },
                    showAlternatives: false
                }).addTo(map);

                // Сегмент 2: клиент -> цель
                const clientToGoal = L.Routing.control({
                    waypoints: [
                        L.latLng(start_lat, start_lon),
                        L.latLng(end_lat, end_lon)
                    ],
                    router: L.Routing.osrmv1({ serviceUrl: this.APP_CONFIG.routing.serviceUrl }),
                    routeWhileDragging: false,
                    createMarker: () => null,
                    addWaypoints: false,
                    lineOptions: {
                        styles: [{ color: this.APP_CONFIG.routing.clientToGoalColor || '#007ccfff', weight: 4, opacity: 1, zIndex: 99999 }]
                    },
                    showAlternatives: false
                }).addTo(map);

                // Центрируем карту по всем точкам
                const bounds = L.latLngBounds([
                    [taxi_lat, taxi_lon],
                    [start_lat, start_lon],
                    [end_lat, end_lon]
                ]);

                map.whenReady(() => {
                    console.log('[*] Карта готова, обновляем размер и центр...');
                    map.invalidateSize();
                    map.fitBounds(bounds, { padding: [50, 50] });
                });

                // Сохраняем контролы и карту
                this.mapInstance = { map, taxiToClient, clientToGoal };

            } else {
                // fallback: простые линии
                L.polyline([
                    [taxi_lat, taxi_lon],
                    [start_lat, start_lon]
                ], { color: this.APP_CONFIG.routing.taxiToClientColor || 'var(--primary)', weight: 4 }).addTo(map);

                L.polyline([
                    [start_lat, start_lon],
                    [end_lat, end_lon]
                ], { color: this.APP_CONFIG.routing.clientToGoalColor || '#007ccfff', weight: 4 }).addTo(map);

                this.mapInstance = { map };
            }
        }, 200);
    }

   
    // ========================
    // Отображение нового заказа для таксиста
    // ========================
    async showTripOrder({ taxi_lat, taxi_lon, start_lat, start_lon, end_lat, end_lon, time, price, distance, clientName, clientRating, clientID, tripID, clientPhoto, start_address, end_address }) {
        // await window.appControllers.toggleBottomNav('taxi.close');
        await window.appControllers.toggleBottomNav('closed');

        this._lastTripOfferForRestore = {
            taxi_lat,
            taxi_lon,
            start_lat,
            start_lon,
            end_lat,
            end_lon,
            time,
            price,
            distance,
            clientName,
            clientRating,
            clientID,
            tripID,
            clientPhoto,
            start_address,
            end_address,
        };
        
        const acceptBtn = this.allowOrderButton;
        // Сначала сбрасываем прогресс только на кнопке «Qəbul edin», не на document.querySelector('.new-notification-button')
        this.resetButtonProgress(acceptBtn);
        
        // Затем запускаем новый прогресс
        this.startButtonProgress({ button: acceptBtn });
    
        document.getElementById('notification-roud-time').textContent = time;
        const priceNum =
            typeof price === 'number' && !Number.isNaN(price)
                ? price
                : parseFloat(String(price).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
        document.getElementById('notification-roud-price').textContent = priceNum.toFixed(2) + ' ₼';
        document.getElementById('notification-roud-distance').textContent = distance + ' km';
        document.getElementById('notification-roud-client-name').textContent = clientName;
        document.getElementById('notification-roud-client-rating').textContent = clientRating;

        this.allowOrderButton.dataset.startLat = start_lat;
        this.allowOrderButton.dataset.startLon = start_lon;
        this.allowOrderButton.dataset.clientId = clientID;
        this.allowOrderButton.dataset.distance = distance;
        this.allowOrderButton.dataset.taxiLat = taxi_lat;
        this.allowOrderButton.dataset.startAddress = start_address;
        this.allowOrderButton.dataset.endAddress = end_address;
        this.allowOrderButton.dataset.taxiLon = taxi_lon;
        this.allowOrderButton.dataset.endLat = end_lat;
        this.allowOrderButton.dataset.endLon = end_lon;
        this.allowOrderButton.dataset.tripId = tripID;
        this.allowOrderButton.dataset.tripId = tripID;
        this.allowOrderButton.dataset.time = time;

        

        // Инициализируем карту
        this.initializeMiniMap(taxi_lat, taxi_lon, start_lat, start_lon, end_lat, end_lon);
        
        this.orderBlock.style.display = 'flex';
        this.notificationBlock.style.display = 'block';
        this.taxiMessageTextBlock.style.display = 'none';
        this.taxiDeclineorderButton.style.display = 'none';
        this.allowOrderButton.style.display = 'flex';
        
        document.querySelector('.order-taxi-end-adderss').textContent = end_address;
        document.querySelector('.order-panel').style.display = 'block';
        document.querySelector('.order-info').style.display = 'none';
        document.getElementById('order-modal').style.display = 'flex';
        document.getElementById('order-modal-taxi-details').style.display = 'none';
        const timeToUser = await window.taxiApp.calculateDrivingTime({lat: taxi_lat, lng: taxi_lon}, {lat: start_lat, lng: start_lon});
        
        const av = document.getElementById('modal-taxi-avatar-order');
        if (av) {
            av.src = clientPhoto
                ? (typeof window.profileAvatarSrc === 'function'
                    ? window.profileAvatarSrc(clientPhoto)
                    : ('data:image/png;base64,' + clientPhoto))
                : '/static/images/user-profile-avatar.png';
        }
        window.taxiApp.safeSetTextContent('client-taxi-go-time-order', timeToUser);
        window.taxiApp.safeSetTextContent('client-taxi-go-time-order-client', timeToUser);
        window.taxiApp.safeSetTextContent('client-taxi-go-time-order-taxi', timeToUser);
        window.taxiApp.safeSetTextContent('order-taxi-progress-title', timeToUser);

        // if (tripData) {
        //     window.taxiApp.safeSetTextContent('modal-taxi-car-number-taxi', tripData.taxi_car_number ?? '');
        //     window.taxiApp.safeSetTextContent('modal-taxi-car-model-taxi', tripData.taxi_car_model ?? '');
        //     window.taxiApp.safeSetTextContent('modal-taxi-car-name-order', tripData.taxi_car_name ?? '');
        //     window.taxiApp.safeSetTextContent('modal-taxi-name-order', tripData.taxi_name ?? '');
        //     window.taxiApp.safeSetTextContent('modal-taxi-rating-order', tripData.taxi_rating ?? '');
        //     window.taxiApp.safeSetTextContent('modal-taxi-car-model-order', tripData.taxi_car_model ?? '');
        //     window.taxiApp.safeSetTextContent('modal-taxi-car-number-order', tripData.taxi_car_number ?? '');
        // }
        
        // await window.appControllers.confirmationTrip({ taxi_lat, taxi_lon, start_lat, start_lon, end_lat, end_lon, time, price, distance, clientName, clientRating, clientID, tripID }, 'driver');
    
    }


}

// Инициализация такси контроллера
window.taxiControlles = new TaxiControlles(window.taxiApp.APP_CONFIG);

