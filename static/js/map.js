// Конфигурация приложения
const APP_CONFIG = {
  map: {
    defaultView: [41.641219, 48.441872],
    defaultDuration: 0.6,
    defaultZoom: 17,
    defaultMaxZoom: 20,
    tileLayer: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    /** Тёмная подложка (Carto dark_all) — в паре с настройкой darkMode. */
    tileLayerDark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    tileLayerOptions: {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20
    }
  },
  routing: {
    serviceUrl: '/route/v1',
    matrixServiceUrl: '/table/v1/driving' 
  },
  geocoding: {
    // Временно: публичный Nominatim (может 429/CORS — см. reverseGeocode fallback).
    serviceUrl: 'https://nominatim.openstreetmap.org/reverse',
    format: 'jsonv2'
  },
  icons: {
    markerA: {
        iconUrl: '/static/images/marker-icon-A.svg',
        iconSize: [40, 40],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32]
    },
    markerB: {
        iconUrl: '/static/images/marker-icon-B.svg', 
        iconSize: [40, 40],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32]
    },

    taxi: {
      iconUrl: '/static/images/marker-icon-taxi.svg',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -32]
    },
    /** Стрелка навигатора для водителя (нос вверх в SVG). */
    navigation: {
      iconUrl: '/static/images/navigation.svg',
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      popupAnchor: [0, -28]
    },
    /** Булавка в центре экрана при выборе B (карта движется под ней). */
    mapPickPin: {
      iconUrl: '/static/images/map-pick-pin.svg',
      iconSize: [80, 80],
      iconAnchor: [41, 78],
      popupAnchor: [0, -54],
    },
  }
};

/**
 * Тёмная тема карты: те же опции Leaflet, меняется только URL тайлов Carto.
 * taxiServices может ещё не существовать при первом `new TaxiApp()`, поэтому читаем localStorage.
 */
function isTaxiSettingsDarkMode() {
  try {
    const s = window.taxiServices?.settings?.get?.();
    if (s && typeof s.darkMode === 'boolean') return s.darkMode;
  } catch (_) { /* ignore */ }
  try {
    const raw = localStorage.getItem('settings');
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o.darkMode === 'boolean') return o.darkMode;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function getCartoBasemapUrlForDarkMode(dark) {
  return dark ? APP_CONFIG.map.tileLayerDark : APP_CONFIG.map.tileLayer;
}

function applyCartoBasemapThemeToMap(map, dark) {
  if (!map || typeof map.eachLayer !== 'function') return;
  const url = getCartoBasemapUrlForDarkMode(!!dark);
  map.eachLayer(function (ly) {
    if (!(ly instanceof L.TileLayer)) return;
    const u = ly._url || '';
    if (u.indexOf('basemaps.cartocdn.com') === -1 && u.indexOf('cartocdn.com') === -1) return;
    if (typeof ly.setUrl === 'function') ly.setUrl(url);
  });
}

function syncAllTaxiLeafletMapsBasemap(dark) {
  applyCartoBasemapThemeToMap(window.taxiApp?.map, dark);
  applyCartoBasemapThemeToMap(window.appControllers?.mapInstance?.map, dark);
  applyCartoBasemapThemeToMap(window.taxiControlles?.mainMapInstance?.map, dark);
  applyCartoBasemapThemeToMap(window.taxiControlles?.mapInstance?.map, dark);
}

window.JITaxiMapBasemap = {
  isDark: isTaxiSettingsDarkMode,
  getUrl: getCartoBasemapUrlForDarkMode,
  applyToMap: applyCartoBasemapThemeToMap,
  syncAll: syncAllTaxiLeafletMapsBasemap,
};

class Radars {
  constructor(map, cameraLayer) {
    this.map = map;
    this.cameraLayer = cameraLayer;
    this.radars = {}; // сюда загрузим данные с сервера
  }

  setRadars(radars) {
    if (localStorage.getItem("userType") === "driver") {
      this.radars = radars;
    }
    
  }

  toggleSpeedAlert(speedLimit) {
    const alert = document.getElementById('speed-alert-notification');

    if (!alert) return;

    if (speedLimit && speedLimit > 0) {
      alert.textContent = speedLimit;

      // Добавляем класс для плавного появления
      alert.classList.add('active');
    } else {
      // Убираем класс для плавного исчезновения
      alert.classList.remove('active');
    }
  }


  addCameras(cameras) {
    if (!this.cameraLayer) {
      console.error("cameraLayer ещё не создан!");
      return;
    }

    this.cameraLayer.clearLayers();

    // Скрываем уведомление о скорости, если камер нет
    if (!cameras || cameras.length === 0) {
      this.toggleSpeedAlert(null);
      return;
    }

    cameras.forEach((cam, index) => {
      const radarIcon = L.divIcon({
        html: '<span data-id="' + cam.id + '" class="radar-map-icon"><svg width="20px" height="20px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#000000" ><g id="SVGRepo_bgCarrier"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path stroke-width="1" d="M18.15,4.94A2.09,2.09,0,0,0,17,5.2l-8.65,5a2,2,0,0,0-.73,2.74l1.5,2.59a2,2,0,0,0,2.73.74l1.8-1a2.49,2.49,0,0,0,1.16,1V18a2,2,0,0,0,2,2H22V18H16.81V16.27A2.49,2.49,0,0,0,18,12.73l2.53-1.46a2,2,0,0,0,.74-2.74l-1.5-2.59a2,2,0,0,0-1.59-1M6.22,13.17,2,13.87l.75,1.3,2,3.46.75,1.3,2.72-3.3Z"></path> <rect width="24" height="24" fill="none"></rect> </g></svg></span>',
        className: '',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });

      L.marker([cam.lat, cam.lng], { icon: radarIcon }).addTo(this.cameraLayer);

      // Показываем скорость только для **первой камеры**
      if (index === 0) {
        this.toggleSpeedAlert(cam.speedLimit);
      }
    });
  }
  
  // Показываем камеры в радиусе radiusMeters от текущей позиции
  addNearbyCameras(lat, lng, radiusMeters = 600) {
    if (!this.radars || !this.radars.radars) return;

    const R = 6371;
    function distanceKm(lat1, lng1, lat2, lng2) {
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    }

    const radiusKm = radiusMeters / 1000;
    const nearby = [];

    Object.entries(this.radars.radars).forEach(([id, cam]) => {
      const [camLat, camLng] = cam.coordinates;
      if (distanceKm(lat, lng, camLat, camLng) <= radiusKm) {
        nearby.push({
          id,
          lat: camLat,
          lng: camLng,
          speedLimit: cam.speedLimit || null
        });
      }
    });

    this.addCameras(nearby);
  }

}


// Основной класс приложения
class TaxiApp {
  constructor(config) {
    this.APP_CONFIG = config;
    this.map = null;
    this.routeStatus = false;
    this.selectingDestination = false;
    /** Клиент: выбор точки подачи кликом по карте */
    this.selectingPickup = false;
    this.fromMarker = null;
    this.toMarker = null;
    this.routingControl = null;
    this.taxiMarkers = [];
    this.searchTimer = null;
    this.searchStartTime = null;
    this.isInterfaceLocked = false;
    this.activeOrder = null;
    /** trip_id: после своей оценки игнорируем повторные WS в at_destination, пока сервер не пришлёт finished. */
    this._postRatingLocalEndTripIds = new Set();
    this._ratingModalShownForTripId = null;
    this._tripRatingStars = 0;
    /** Последняя длина маршрута заказа в км (для API; не брать из текста «500 m»). */
    this.lastRouteDistanceKm = null;
    this.drivers = [];
    this.userLatLng = null;
    this.driversUpdateHandler = null; // Добавляем обработчик WebSocket
    this.driverMarkers = {}; // Для хранения маркеров водителей
    this.locationUpdateInterval = null;
    this.wsReconnectHandler = null;
    this._routeRecalcDebounceTimer = null;
    /** Клиент: активен режим «точка B на карте» (ожидание клика / правка до «Hazırdır»). */
    this.mapDestinationPickActive = false;
    /** Сохранённая разметка кнопки «на карте» для восстановления. */
    this._pointToMapBtnDefaultHtml = null;
    /** Режим центр=B: при move только маркер; маршрут и геокод — по moveend/zoomend. */
    this._centerPickDuringMove = null;
    this._centerPickOnSettled = null;
    /** Отложенный zoom к линии маршрута после перестановки B (handleRoutesFound). */
    this._routeFitBoundsTimer = null;
    /** Длительность последнего маршрута OSRM (сек) — для тарифа за минуту при заказе. */
    this._lastRouteTimeSeconds = 0;
    /** Reverse geocode (Nominatim) через 5 с после последнего стабильного маршрута — реже 429. */
    this._addressLookupAfterRouteTimer = null;

    this.initializeMap();
    this.setupEventListeners();
    this.initializeUserLocation();
    // this.setupDebugTools();
    // Инициализация системы блокировки
    // this.setupLockSystem();
    
    // Загрузка водителей через WebSocket
    // this.setupWebSocketHandlers();
  }

  

  // Инициализация карты
  initializeMap() {
    // leaflet-rotate требует объект options (иначе o.rotate падает на undefined)
    this.map = L.map('map', {
      rotate: false,
      rotateControl: false,
    }).setView(APP_CONFIG.map.defaultView, APP_CONFIG.map.defaultZoom);

    // Добавление слоя с тайлами (светлая / тёмная подложка по настройке)
    L.tileLayer(
      getCartoBasemapUrlForDarkMode(isTaxiSettingsDarkMode()),
      APP_CONFIG.map.tileLayerOptions
    ).addTo(this.map);

    // Обработчик клика по карте для установки точки назначения
    this.map.on('click', this.handleMapClick.bind(this));

    // Создаём слой для камер
    this.cameraLayer = L.layerGroup().addTo(this.map);

    // ---------------------------
    // Инициализация класса Radars
    // ---------------------------
    this.radarsClass = new Radars(this.map, this.cameraLayer);
  }

  // Сброс карты
  resetMap() {
    if (this._routeRecalcDebounceTimer) {
      clearTimeout(this._routeRecalcDebounceTimer);
      this._routeRecalcDebounceTimer = null;
    }
    this._cancelDeferredRouteZoom();
    this._cancelDeferredAddressLookup();
    if (this.map) {
        this._unbindCenterPickMapListeners();
        try {
            this.clearExistingRoute();
        } catch (_) { /* ignore */ }
        if (this.fromMarker) {
            try {
                this.map.removeLayer(this.fromMarker);
            } catch (_) { /* ignore */ }
        }
        if (this.toMarker) {
            try {
                this.map.removeLayer(this.toMarker);
            } catch (_) { /* ignore */ }
        }
        try {
            this.map.off();
            this.map.remove();
        } catch (_) { /* ignore */ }
    }

    this.map = null;
    this.fromMarker = null;
    this.toMarker = null;
    this.routingControl = null;
    this.routeStatus = false;
    this.selectingDestination = false;
    this.selectingPickup = false;
    this.mapDestinationPickActive = false;
    this._setPointToMapButtonUi('default');
    this.updateCancelRouteMapBtnVisibility();
    this.lastRouteDistanceKm = null;
    if (typeof window !== 'undefined') {
        window.ROUTE_STATUS = false;
    }

    const mapContainer = document.getElementById('map');
    if (mapContainer) {
        mapContainer.innerHTML = '';
    }

    this.initializeMap();
    this.handleMyLocationClick();

    console.log("[resetMap] Карта пересоздана и интерактивна");
  }

  /**
   * Расстояние маршрута для создания заказа, всегда в километрах.
   */
  getOrderDistanceKm() {
      if (this.lastRouteDistanceKm != null && Number.isFinite(this.lastRouteDistanceKm)) {
          return Math.max(0, this.lastRouteDistanceKm);
      }
      const el = document.getElementById('additional-metrs');
      if (el?.dataset?.distanceKm != null && el.dataset.distanceKm !== '') {
          const v = parseFloat(el.dataset.distanceKm);
          if (Number.isFinite(v)) return Math.max(0, v);
      }
      if (this.fromMarker && this.toMarker) {
          const m = this.fromMarker.getLatLng().distanceTo(this.toMarker.getLatLng());
          return Math.max(0, m / 1000);
      }
      return 0;
  }



  // Проверка на мобильное устройство
  isMobileDevice() {
      return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  /** Клиент: точку подачи нельзя тянуть, пока заказ в поиске (pending / offered). */
  _clientPickupFromDraggable() {
    if (localStorage.getItem('userType') === 'driver') return true;
    const ao = this.activeOrder;
    if (!ao) return true;
    const st = String(ao.status || '').toLowerCase().trim();
    if (st === 'pending' || st === 'offered') return false;
    return true;
  }

  syncClientPickupMarkerDrag() {
    if (!this.fromMarker || !this.fromMarker.dragging) return;
    try {
      if (this._clientPickupFromDraggable()) this.fromMarker.dragging.enable();
      else this.fromMarker.dragging.disable();
    } catch (_) { /* ignore */ }
  }

  /** Заказ такси на карте (не режим водителя): пустой userType тоже считаем клиентом. */
  _isBookingMapUser() {
    return localStorage.getItem('userType') !== 'driver';
  }

  /** После «Hazırdır»: обычный маркер B. */
  _finalizeDestinationMarkerToB() {
    if (!this.toMarker) return;
    try {
      this.toMarker.closeTooltip();
      this.toMarker.unbindTooltip();
    } catch (_) { /* ignore */ }
    this.toMarker.setIcon(L.icon(APP_CONFIG.icons.markerB));
    this.toMarker.setZIndexOffset(0);
    if (this.toMarker.dragging) this.toMarker.dragging.enable();
  }

  _unbindCenterPickMapListeners() {
    if (!this.map) return;
    if (this._centerPickDuringMove) {
      this.map.off('move', this._centerPickDuringMove);
      this._centerPickDuringMove = null;
    }
    if (this._centerPickOnSettled) {
      this.map.off('moveend', this._centerPickOnSettled);
      this.map.off('zoomend', this._centerPickOnSettled);
      this._centerPickOnSettled = null;
    }
  }

  /**
   * Центр карты = точка B. При pan: только позиция маркера (без OSRM/Nominatim).
   * @param {{ withRoute?: boolean }} opts — маршрут и адрес только после «отпускания» (moveend/zoomend).
   */
  syncDestinationToMapCenter(opts = {}) {
    const withRoute = !!opts.withRoute;
    if (!this.map || !this.toMarker || !this.mapDestinationPickActive || !this._isBookingMapUser()) return;
    const c = this.map.getCenter();
    this.toMarker.setLatLng(c);
    if (!withRoute) return;
    this.scheduleCalculateRoute(80);
  }

  _bindCenterPickMapListeners() {
    this._unbindCenterPickMapListeners();
    this._centerPickDuringMove = () => this.syncDestinationToMapCenter();
    this._centerPickOnSettled = () => this.syncDestinationToMapCenter({ withRoute: true });
    this.map.on('move', this._centerPickDuringMove);
    this.map.on('moveend', this._centerPickOnSettled);
    this.map.on('zoomend', this._centerPickOnSettled);
  }

  /** Старт выбора B: маркер в центре, движение карты меняет адрес и маршрут. */
  _startDestinationCenterPick() {
    if (!this.map || !this.mapDestinationPickActive) return;
    if (!this._ensureFromMarkerForMapPick()) return;
    this.clearExistingRoute();
    if (this.toMarker) {
      try {
        this.map.removeLayer(this.toMarker);
      } catch (_) { /* ignore */ }
      this.toMarker = null;
    }
    const ll = this.map.getCenter();
    this.createDestinationMarker(ll, { clientPlacementSession: true, centerFixedMode: true });
    this.routeStatus = true;
    this._bindCenterPickMapListeners();
    this.syncDestinationToMapCenter({ withRoute: true });
    this.updateCancelRouteMapBtnVisibility();
  }

  /** Точка A на карте: иначе тап по B не срабатывал (fromMarker отсутствовал). */
  _ensureFromMarkerForMapPick() {
    if (this.fromMarker) return true;
    if (!this.map) return false;
    const c = this.map.getCenter();
    this.fromMarker = L.marker([c.lat, c.lng], {
      icon: L.icon(APP_CONFIG.icons.markerA),
      draggable: this._clientPickupFromDraggable(),
    }).addTo(this.map);
    this.setupFromMarker();
    const fi = document.getElementById('from-input');
    if (fi && !String(fi.value || '').trim()) {
      if (this._isBookingMapUser()) {
        this._scheduleDeferredAddressLookup();
      } else {
        this.reverseGeocode(c, (address) => {
          if (fi) fi.value = address;
        });
      }
    }
    return !!this.fromMarker;
  }

  _collapseBottomNavForMapPick() {
    window.appControllers?.toggleBottomNav?.('closed');
    setTimeout(() => {
      try {
        this.map?.invalidateSize();
      } catch (_) { /* ignore */ }
    }, 420);
  }

  _releaseBottomNavForMapPick() {
    document.querySelector('.bottom-nav')?.classList.remove('closed');
  }

  _syncMapButtonsDestinationPickClass() {
    document.querySelector('.map-buttons')?.classList.toggle(
      'map-buttons--destination-pick',
      !!(this.mapDestinationPickActive && this._isBookingMapUser()),
    );
  }

  updateCancelRouteMapBtnVisibility() {
    const el = document.getElementById('cancel-route-map-btn');
    if (!el) return;
    // В режиме выбора B: «Hazırdır» и «Ləğv» рядом — подтвердить или выйти без фиксации.
    if (this.mapDestinationPickActive && this._isBookingMapUser()) {
      el.style.display = 'flex';
      this._syncMapButtonsDestinationPickClass();
      return;
    }
    // Когда видна панель расстояния/цены (inline none снят) — «×» у карты не показываем: Marşrut/B уже скрыты.
    const addBtns = document.querySelector('.additional-buttons');
    const summaryBarOpen =
      addBtns && typeof getComputedStyle !== 'undefined' && getComputedStyle(addBtns).display !== 'none';
    if (summaryBarOpen) {
      el.style.display = 'none';
      this._syncMapButtonsDestinationPickClass();
      return;
    }
    const show = !!(this.toMarker || this.routingControl);
    el.style.display = show ? 'flex' : 'none';
    this._syncMapButtonsDestinationPickClass();
  }

  /** Сброс маршрута и точки B (карта заказа). */
  cancelRouteFromMapUI() {
    this._unbindCenterPickMapListeners();
    const wasCenterPick = this.mapDestinationPickActive && this._isBookingMapUser();
    this.clearExistingRoute();
    if (this.toMarker && this.map) {
      try {
        this.map.removeLayer(this.toMarker);
      } catch (_) { /* ignore */ }
    }
    this.toMarker = null;
    const ti = document.getElementById('to-input');
    if (ti) ti.value = '';
    this.routeStatus = false;
    this.lastRouteDistanceKm = null;
    if (typeof window !== 'undefined') window.ROUTE_STATUS = false;

    const addBtns = document.querySelector('.additional-buttons');
    if (addBtns) addBtns.style.display = 'none';
    const met = document.getElementById('additional-metrs');
    if (met) {
      met.textContent = '0m';
      delete met.dataset.distanceKm;
    }

    const pointBtn = document.getElementById('point-to-map-btn');
    const routeBtn = document.getElementById('set-route-btn');
    if (wasCenterPick) {
      this.mapDestinationPickActive = false;
      this.selectingDestination = false;
      this._setPointToMapButtonUi('default');
    }
    if (wasCenterPick) {
      if (pointBtn) pointBtn.style.display = 'flex';
      if (routeBtn) routeBtn.style.display = 'flex';
    } else if (this.mapDestinationPickActive && this._isBookingMapUser()) {
      if (pointBtn) pointBtn.style.display = 'flex';
      if (routeBtn) routeBtn.style.display = 'none';
    } else {
      if (pointBtn) pointBtn.style.display = 'flex';
      if (routeBtn) routeBtn.style.display = 'flex';
    }
    if (this._isBookingMapUser()) this._releaseBottomNavForMapPick();
    this.updateCancelRouteMapBtnVisibility();
  }

  // Настройка обработчиков событий
  setupEventListeners() {
    const pointBtn = document.getElementById("point-to-map-btn");
    if (pointBtn && !this._pointToMapBtnDefaultHtml) {
      this._pointToMapBtnDefaultHtml = pointBtn.innerHTML;
    }
    if (pointBtn) {
      pointBtn.addEventListener('click', this.handlePointToMapBtnClick.bind(this));
    }

    const cancelRouteBtn = document.getElementById('cancel-route-map-btn');
    if (cancelRouteBtn) {
      cancelRouteBtn.addEventListener('click', () => this.cancelRouteFromMapUI());
    }
    
    const searchCancelBtn = document.getElementById("searching-cancel-button");
    if (searchCancelBtn) {searchCancelBtn.addEventListener('click', this.closeTaxiSearchingModal.bind(this));}

    const orderBtn = document.getElementById('order-btn');
    if (orderBtn) {orderBtn.addEventListener('click', this.handleOrderClick.bind(this));}

    // Обработчик для кнопки "Мои местоположения"
    const myLocationsBtn = document.getElementById("my-locations-btn");
    if (myLocationsBtn) {
        myLocationsBtn.addEventListener('click', this.handleMyLocationClick.bind(this));
    }
  }

  // Инициализация местоположения пользователя
  initializeUserLocation() {
    console.log(`[Location Update] Driver location initialized`);
    this.startLocationUpdates();
    if (navigator.geolocation) {
      console.log(`[Location Update] Check geolocation..`);
      navigator.geolocation.getCurrentPosition(
        this.handleGeolocationSuccess.bind(this),
        this.handleGeolocationError.bind(this),
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
      );
    } else {
      this.enableManualFromSelection();
    }
  }

  // Метод для периодического обновления локации
  startLocationUpdates() {
      if (!this.fromMarker) return;

      let lastSent = 0;
      const INTERVAL = 3000;

      this.fromMarker.on('move', (e) => {
          const now = performance.now();
          if (now - lastSent < INTERVAL) return;

          lastSent = now;

          const { lat, lng } = e.latlng;
          window.taxiServices?.updateDriverLocation(lat, lng);
      });

      this.fromMarker.on('dragend', (e) => {
          const { lat, lng } = e.target.getLatLng();
          window.taxiServices?.updateDriverLocation(lat, lng);
        });
      }




  // Останавливаем обновления при уничтожении
  stopLocationUpdates() {
      if (this.locationUpdateInterval) {
          clearInterval(this.locationUpdateInterval);
          this.locationUpdateInterval = null;
      }
  }

//   setupLockSystem() {
//     // Обработчик для кнопки отмены в модальном окне
//     const cancelOrderBtn = document.getElementById('order-taxi-cancel-button');
//     if (cancelOrderBtn) {
//         cancelOrderBtn.addEventListener('click', () => {
//             if (this.isInterfaceLocked) {
//                 this.cancelActiveOrder();
//             }
//         });
//     }
    
//     // Обработчик закрытия страницы
//     window.addEventListener('beforeunload', (e) => {
//         if (this.isInterfaceLocked) {
//             e.preventDefault();
//             e.returnValue = 'У вас есть активный заказ. Вы уверены, что хотите уйти?';
//             return e.returnValue;
//         }
//     });
//   }


  // Обработка успешного получения геолокации
  handleGeolocationSuccess(position) {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    this.userLatLng = { lat, lng };
    console.log("User location:", this.userLatLng);

    const custom_icon = localStorage.getItem("taxiNotificationStatus") === "available" ? APP_CONFIG.icons.taxi : APP_CONFIG.icons.markerA;
    this.fromMarker = L.marker([lat, lng], {
      icon: L.icon(custom_icon),
      draggable: this._clientPickupFromDraggable(),
    }).addTo(this.map);


    this.map.flyTo([lat, lng], APP_CONFIG.map.defaultMaxZoom, { animate: true, duration: APP_CONFIG.map.defaultDuration });
    this.setupFromMarker();
    
    // Обновляем локацию через WebSocket
    window.taxiServices?.updateDriverLocation(lat, lng);
    
    // Загружаем водителей
    // this.loadDrivers();
  }


  // Блокировка интерфейса
  // lockInterface(orderData = null) {
  //     this.isInterfaceLocked = true;
  //     this.activeOrder = orderData;
      
  //     // Блокируем маркеры
  //     this.lockMarkers();
      
  //     // Блокируем кнопки
  //     this.lockButtons();
      
  //     // Блокируем карту
  //     this.lockMap();
      
  //     console.log('Interface locked for order:', orderData);
  // }

  // Разблокировка интерфейса
  // unlockInterface() {
  //     this.isInterfaceLocked = false;
  //     this.activeOrder = null;
      
  //     // Разблокируем маркеры
  //     this.unlockMarkers();
      
  //     // Разблокируем кнопки
  //     this.unlockButtons();
      
  //     // Разблокируем карту
  //     this.unlockMap();
      
  //     console.log('Interface unlocked');
  // }

  // Блокировка маркеров
  // lockMarkers() {
  //     // Блокируем маркер отправления
  //     if (this.fromMarker) {
  //         this.fromMarker.dragging.disable();
  //         // this.fromMarker.setOpacity(0.6);
  //     }
      
  //     // Блокируем маркер назначения
  //     if (this.toMarker) {
  //         this.toMarker.dragging.disable();
  //         // this.toMarker.setOpacity(0.6);
  //     }
      
  // }

  // Разблокировка маркеров
  // unlockMarkers() {
  //     // Разблокируем маркер отправления
  //     if (this.fromMarker) {
  //         this.fromMarker.dragging.enable();
  //     }
      
  //     // Разблокируем маркер назначения
  //     if (this.toMarker) {
  //         this.toMarker.dragging.enable();
  //     }
      
  //     // Разблокируем маркеры таксистов
  //     this.driverMarkers.forEach(marker => {
  //         marker.dragging && marker.dragging.enable();
  //     });
  // }

  // Блокировка кнопок
  // lockButtons() {
  //     const buttonsToLock = [
  //         'point-to-map-btn',
  //         'set-route-btn',
  //         'order-btn',
  //         'my-locations-btn'
  //     ];
      
  //     buttonsToLock.forEach(id => {
  //         const btn = document.getElementById(id);
  //         if (btn) {
  //             btn.disabled = true;
  //             btn.style.opacity = '0.5';
  //         }
  //     });
      
  // }

  // // Разблокировка кнопок
  // unlockButtons() {
  //     const buttonsToUnlock = [
  //         'point-to-map-btn',
  //         'set-route-btn',
  //         'order-btn',
  //         'my-locations-btn'
  //     ];
      
  //     buttonsToUnlock.forEach(id => {
  //         const btn = document.getElementById(id);
  //         if (btn) {
  //             btn.disabled = false;
  //             btn.style.opacity = '1';
  //             btn.style.cursor = 'pointer';
  //         }
  //     });
  // }

  // Блокировка карты
  // lockMap() {
  //     // Отключаем обработчики кликов
  //     this.map.off('click', this.handleMapClick.bind(this));
      
  // }

  // // Разблокировка карты
  // unlockMap() {
  //     // Включаем обработчики кликов
  //     this.map.on('click', this.handleMapClick.bind(this));
      
  //     // Восстанавливаем курсор
  //     this.map.getContainer().style.cursor = '';
  // }



  // Обработка ошибки геолокации
  handleGeolocationError(error) {
    // console.warn("Геолокация недоступна:", error.message);
    this.enableManualFromSelection();
    document.getElementById("notification-location-error").style.display = "flex"; 
    
  }

  // Ручная установка точки отправления
  enableManualFromSelection(defaultLat = 41.607609, defaultLng = 48.481897) {
      this.map.flyTo([defaultLat, defaultLng], APP_CONFIG.map.defaultMaxZoom, { animate: true, duration: APP_CONFIG.map.defaultDuration });
      
      const custom_icon = localStorage.getItem("taxiNotificationStatus") === "available" ? APP_CONFIG.icons.taxi : APP_CONFIG.icons.markerA;
      this.fromMarker = L.marker([defaultLat, defaultLng], {
          icon: L.icon(custom_icon),
          draggable: this._clientPickupFromDraggable(),
      }).addTo(this.map);
      
      this.setupFromMarker(); // Используем общий метод
      this.setupFromMarkerPopup(); // Добавляем специальное всплывающее окно
  }

  // Настройка всплывающего окна для точки отправления
  setupFromMarkerPopup() {
    this.fromMarker.bindPopup(`
      <div style="text-align:center">
        <p style="color: #3e3e3e;font-size:15px;display: flex;align-items: center;justify-content: center;gap: 5px;">
          <svg width="30px" height="30px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path fill-rule="evenodd" clip-rule="evenodd" d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM12 7.75C11.3787 7.75 10.875 8.25368 10.875 8.875C10.875 9.28921 10.5392 9.625 10.125 9.625C9.71079 9.625 9.375 9.28921 9.375 8.875C9.375 7.42525 10.5503 6.25 12 6.25C13.4497 6.25 14.625 7.42525 14.625 8.875C14.625 9.58584 14.3415 10.232 13.883 10.704C13.7907 10.7989 13.7027 10.8869 13.6187 10.9708C13.4029 11.1864 13.2138 11.3753 13.0479 11.5885C12.8289 11.8699 12.75 12.0768 12.75 12.25V13C12.75 13.4142 12.4142 13.75 12 13.75C11.5858 13.75 11.25 13.4142 11.25 13V12.25C11.25 11.5948 11.555 11.0644 11.8642 10.6672C12.0929 10.3733 12.3804 10.0863 12.6138 9.85346C12.6842 9.78321 12.7496 9.71789 12.807 9.65877C13.0046 9.45543 13.125 9.18004 13.125 8.875C13.125 8.25368 12.6213 7.75 12 7.75ZM12 17C12.5523 17 13 16.5523 13 16C13 15.4477 12.5523 15 12 15C11.4477 15 11 15.4477 11 16C11 16.5523 11.4477 17 12 17Z" fill="#20bc32"></path> </g></svg>
          Bu sizin hazırkı mövqeyinizdir?
        </p>
      </div>    
    `).openPopup();
  }

  /** Клиент: выбрать точку подачи на карте (клик). */
  enablePickupSelection() {
    if (localStorage.getItem('userType') !== 'client') return;
    if (!this.map) return;
    this.selectingPickup = true;
    this.selectingDestination = false;
    const mapEl = document.getElementById('map');
    const pointBtn = document.getElementById('point-to-map-btn');
    const routeBtn = document.getElementById('set-route-btn');
    if (pointBtn) pointBtn.style.display = 'none';
    if (routeBtn) routeBtn.style.display = 'none';
  }

  _applyPickupFromMapClick(latlng) {
    if (!this.fromMarker) return;
    this.fromMarker.setLatLng(latlng);
    if (this._isBookingMapUser()) {
      this._scheduleDeferredAddressLookup();
    } else {
      this.reverseGeocode(latlng, (address) => {
        const fi = document.getElementById('from-input');
        if (fi) fi.value = address;
      });
    }
    if (this.toMarker) {
      this.routeStatus = true;
      this.scheduleCalculateRoute();
    }
    this.selectingPickup = false;
    const mapEl = document.getElementById('map');
    const pointBtn = document.getElementById('point-to-map-btn');
    const routeBtn = document.getElementById('set-route-btn');
    const addBtns = document.querySelector('.additional-buttons');
    if (this.routeStatus) {
      if (pointBtn) pointBtn.style.display = 'none';
      if (routeBtn) routeBtn.style.display = 'none';
      if (addBtns) addBtns.style.display = 'flex';
    } else {
      if (pointBtn) pointBtn.style.display = 'flex';
      if (routeBtn) routeBtn.style.display = 'flex';
    }
    if (this.map) {
      this.map.flyTo(latlng, APP_CONFIG.map.defaultMaxZoom, {
        animate: true,
        duration: APP_CONFIG.map.defaultDuration,
      });
    }
  }

  /**
   * Восстановить маркеры A/B и маршрут после /api/trip/active (клиент, поиск).
   */
  async restoreRouteFromActivePayload(p) {
    if (!this.map || !p) return;
    const sl = parseFloat(p.start_lat);
    const sn = parseFloat(p.start_lon);
    const el = parseFloat(p.end_lat);
    const en = parseFloat(p.end_lon);
    if (Number.isNaN(sl) || Number.isNaN(sn)) return;
    if (this.fromMarker) {
      this.map.removeLayer(this.fromMarker);
      this.fromMarker = null;
    }
    this.fromMarker = L.marker([sl, sn], {
      icon: L.icon(APP_CONFIG.icons.markerA),
      draggable: this._clientPickupFromDraggable(),
    }).addTo(this.map);
    this.setupFromMarker();
    this.syncClientPickupMarkerDrag();
    if (!Number.isNaN(el) && !Number.isNaN(en)) {
      this.createDestinationMarker(L.latLng(el, en));
      this.routeStatus = true;
      this.updateUIForRoute();
      await this.calculateRouteWithOSRM();
    }
  }

  /** Клик по кнопке «на карте»: старт режима или «Hazırdır» у клиента. */
  handlePointToMapBtnClick() {
    if (this._isBookingMapUser() && this.mapDestinationPickActive) {
      this.finishDestinationMapPick();
      return;
    }
    this.enableDestinationSelection();
  }

  _setPointToMapButtonUi(mode) {
    const btn = document.getElementById('point-to-map-btn');
    if (!btn) return;
    if (mode === 'confirm') {
      btn.classList.add('point-to-map--confirm');
      btn.innerHTML = `
        <svg class="point-to-map__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="point-to-map__label">Hazırdır</span>`;
      return;
    }
    btn.classList.remove('point-to-map--confirm');
    if (this._pointToMapBtnDefaultHtml) {
      btn.innerHTML = this._pointToMapBtnDefaultHtml;
    }
  }

  /**
   * Завершить режим выбора B на карте (клиент): курсор, кнопки, при наличии маршрута — панель итогов.
   */
  finishDestinationMapPick() {
    if (!this._isBookingMapUser()) return;
    this._unbindCenterPickMapListeners();
    this.mapDestinationPickActive = false;
    this.selectingDestination = false;
    document.getElementById('map')?.classList.remove('cursor-marker');
    this._setPointToMapButtonUi('default');
    this._releaseBottomNavForMapPick();

    const pointBtn = document.getElementById('point-to-map-btn');
    const routeBtn = document.getElementById('set-route-btn');

    if (this.toMarker) this._finalizeDestinationMarkerToB();

    if (this.toMarker && this.fromMarker && this.routeStatus) {
      this.updateUIForRoute();
    } else {
      if (pointBtn) pointBtn.style.display = 'flex';
      if (routeBtn) routeBtn.style.display = 'flex';
      const addBtns = document.querySelector('.additional-buttons');
      if (addBtns && !this.routeStatus) addBtns.style.display = 'none';
    }
    this.updateCancelRouteMapBtnVisibility();
  }

  // Включение режима выбора точки назначения
  enableDestinationSelection() {
    this.selectingPickup = false;
    this.selectingDestination = true;
    const pointBtn = document.getElementById("point-to-map-btn");
    const RouteBtn = document.getElementById("set-route-btn");
    const isDriver = localStorage.getItem('userType') === 'driver';

    if (!isDriver) {
      this.mapDestinationPickActive = true;
      if (!this._pointToMapBtnDefaultHtml && pointBtn) {
        this._pointToMapBtnDefaultHtml = pointBtn.innerHTML;
      }
      this._setPointToMapButtonUi('confirm');
      if (pointBtn) pointBtn.style.display = 'flex';
      if (RouteBtn) RouteBtn.style.display = 'none';
      this._collapseBottomNavForMapPick();
      setTimeout(() => this._startDestinationCenterPick(), 450);
    } else {
      this.mapDestinationPickActive = false;
      if (pointBtn) pointBtn.style.display = "none";
      if (RouteBtn) RouteBtn.style.display = "none";
    }

    document.getElementById('map')?.classList.add('cursor-marker');
    this.updateCancelRouteMapBtnVisibility();
  }
  
  // Настройка обработчиков WebSocket
  // setupWebSocketHandlers() {
      // Обработчик для обновлений водителей
    //   this.driversUpdateHandler = (data) => {
    //       console.log('WebSocket drivers update:', data);
    //       if (data && data.type === 'nearby_drivers' && Array.isArray(data.drivers)) {
    //           this.handleDriversUpdate(data.drivers);
    //       } else {
    //           console.error('Invalid WebSocket data format:', data);
    //       }
    //   };
      
      // Обработчик подключения WebSocket
    //   this.wsConnectHandler = () => {
    //       console.log('WebSocket connected, stopping HTTP polling');
    //       // Останавливаем HTTP polling когда WebSocket подключен
    //       if (window.taxiServices) {
    //           window.taxiServices.stopDriversUpdates();
    //       }
          
          // Загружаем водителей через WebSocket
        //   const userLatLng = this.fromMarker ? this.fromMarker.getLatLng() : this.map.getCenter();
        //   window.taxiServices.wsService.getNearbyDrivers(
        //       userLatLng.lat, 
        //       userLatLng.lng, 
        //       5.0
        //   );
    //   };
      
      // Обработчик отключения WebSocket
    //   this.wsDisconnectHandler = () => {
    //       console.log('WebSocket disconnected, starting HTTP polling');
    //       // Запускаем HTTP polling когда WebSocket отключается
    //       const userLatLng = this.fromMarker ? this.fromMarker.getLatLng() : this.map.getCenter();
    //       if (window.taxiServices) {
    //           window.taxiServices.startDriversUpdates(userLatLng, (drivers) => {
    //               if (drivers && Array.isArray(drivers)) {
    //                   this.handleDriversUpdate(drivers);
    //               }
    //           });
    //       }
    //   };

      // Регистрируем обработчики
  //     if (window.taxiServices && window.taxiServices.wsService) {
  //         window.taxiServices.wsService.on('nearby_drivers', this.driversUpdateHandler);
  //         window.taxiServices.wsService.on('connected', this.wsConnectHandler);
  //         window.taxiServices.wsService.on('close', this.wsDisconnectHandler);
  //     }
  // }

  // Обработка обновления списка водителей
//   handleDriversUpdate(drivers) {
//       if (!drivers || !Array.isArray(drivers)) {
//           console.warn('Invalid drivers data received, skipping update');
//           return;
//       }
      
//       console.log('Drivers received:', drivers.length, 'drivers');
//       this.drivers = drivers;
    //   this.showDriversOnMap();
    //   this.renderDriversList();
        
      
      // Если есть активный маршрут, пересчитываем ближайшего водителя
    //   if (this.fromMarker && this.routeStatus) {
    //       this.highlightNearestDriver(this.fromMarker.getLatLng());
    //   }
//   }

  // Обновление UI статуса такси (источник правды — сервер: available / offline / busy)
  updateTaxiStatusUI(status) {
      const taxiNotificationButton = document.querySelector('.taxi-notification-button');
      if (!taxiNotificationButton) return;

      const isDriver = (localStorage.getItem("userType") || "") === "driver";
      if (!isDriver) {
          taxiNotificationButton.classList.remove('spinner');
          return;
      }

      const raw = String(status ?? "").trim().toLowerCase();

      if (raw === "spinner" || raw === "loading") {
          taxiNotificationButton.classList.remove('offline', 'available');
          taxiNotificationButton.classList.add('spinner');
          return;
      }

      let serverPresence;
      if (raw === "offline") {
          serverPresence = "offline";
      } else if (raw === "busy" || raw === "available") {
          serverPresence = raw === "busy" ? "busy" : "available";
      } else {
          serverPresence = "offline";
      }

      const uiClass = serverPresence === "offline" ? "offline" : "available";
      taxiNotificationButton.classList.remove('offline', 'available', 'spinner');
      taxiNotificationButton.classList.add(uiClass);
      taxiNotificationButton.dataset.driverPresence = serverPresence;
      localStorage.setItem("taxiNotificationStatus", uiClass);
  }

  /** Актуальный статус водителя с API (кнопка без «пустого» состояния). */
  async refreshDriverNotificationFromServer() {
      if ((localStorage.getItem("userType") || "") !== "driver") return;
      try {
          const res = await fetch("/api/taxi-status", { credentials: "include" });
          const data = await res.json().catch(() => ({}));
          if (data.success && data.status) {
              this.updateTaxiStatusUI(data.status);
          } else {
              const ls = localStorage.getItem("taxiNotificationStatus");
              this.updateTaxiStatusUI(ls === "available" || ls === "offline" ? ls : "offline");
          }
      } catch (e) {
          console.warn("[map] refreshDriverNotificationFromServer", e);
          const ls = localStorage.getItem("taxiNotificationStatus");
          this.updateTaxiStatusUI(ls === "available" || ls === "offline" ? ls : "offline");
      }
  }

  // Расчет времени между точками через ваш сервер
  async calculateDrivingTime(sourceLatLng, destinationLatLng) {
      try {
          // Форматируем координаты для вашего эндпоинта
          const coords = `${sourceLatLng.lng},${sourceLatLng.lat};${destinationLatLng.lng},${destinationLatLng.lat}`;
          const url = `${APP_CONFIG.routing.matrixServiceUrl}/${coords}?annotations=duration`;
          
          const response = await fetch(url);
          
          if (!response.ok) {
              throw new Error('Matrix request failed');
          }
          
          const data = await response.json();
          
          if (data && data.durations && data.durations[0] && data.durations[0][1]) {
              const durationSeconds = data.durations[0][1];
              return this.formatTime(durationSeconds);
          }
          return '0 dəq';
      } catch (error) {
          console.error('Matrix calculation error:', error);
          return '0 dəq';
      }
  }

  // Форматирование времени
  formatTime(seconds) {
      const minutes = Math.round(seconds / 60);
      if (minutes < 1) return '1 dəq';
      return `${minutes} dəq`;
  }

  // Обработка клика по карте (обработчик построения маршрута)
  async handleMapClick(e) {
    if (this.selectingPickup) {
      this._applyPickupFromMapClick(e.latlng);
      return;
    }

    // Если режим выбора назначения не активен - выходим

    if (!this.selectingDestination) return;

    // Заказчик: конец маршрута — центр карты (панорама), тап по карте не двигает B
    if (this._isBookingMapUser() && this.mapDestinationPickActive) {
      return;
    }

    this.routeStatus = true;
    this.clearExistingRoute();
    this.createDestinationMarker(e.latlng);
    this.updateUIForRoute();

    await this.calculateRouteWithOSRM();

    this.selectingDestination = false;
    document.getElementById('map')?.classList.remove('cursor-marker');
    this.updateCancelRouteMapBtnVisibility();
  }

  // Уведомление о блокировке
  showLockNotification() {
      // Временное уведомление
      const notification = document.createElement('div');
      notification.innerHTML = `
          <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                      background: #ff6b6b; color: white; padding: 15px 20px; border-radius: 8px; 
                      z-index: 10000; font-size: 16px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">
              🚫 Интерфейс заблокирован во время выполнения заказа
          </div>
      `;
      document.body.appendChild(notification);
      
      setTimeout(() => {
          notification.remove();
      }, 2000);
  }

  // Добавьте новый метод для построения маршрута через OSRM
  async calculateRouteWithOSRM() {
    if (!this.fromMarker || !this.toMarker) return;
    
    this.clearExistingRoute();
    
    const self = this;
    const createMarker = (waypointIndex, waypoint, numberOfWaypoints) => {
        if (waypointIndex === 0 && self.fromMarker) return null;
        if (waypointIndex === 1 && self.toMarker) return null;

        const custom_icon = localStorage.getItem("taxiNotificationStatus") === "available" ? APP_CONFIG.icons.taxi : APP_CONFIG.icons.markerA;
        return L.marker(waypoint.latLng, {
            icon: L.icon(custom_icon),
            draggable: self._clientPickupFromDraggable(),
        });
    };

    this.routingControl = L.Routing.control({
        waypoints: [this.fromMarker.getLatLng(), this.toMarker.getLatLng()],
        router: L.Routing.osrmv1({serviceUrl: APP_CONFIG.routing.serviceUrl}),
        routeWhileDragging: true,
        fitSelectedRoutes: false,
        createMarker: createMarker,
        lineOptions: {styles: [{color: '#007ccfff', weight: 4}]},
        addWaypoints: false
    }).on("routesfound", this.handleRoutesFound.bind(this)).addTo(this.map);
    
    // Ищем таксистов для маршрута
    // const drivers = await window.taxiServices.findDriversForRoute(
    //     this.fromMarker.getLatLng(),
    //     this.toMarker.getLatLng()
    // );
    
    // this.drivers = drivers;
    // this.showDriversOnMap();
    // this.highlightNearestDriver(this.fromMarker.getLatLng());
  }

  // Удаление существующего маршрута
  clearExistingRoute() {
    this._cancelDeferredRouteZoom();
    this._cancelDeferredAddressLookup();
    if (this.routingControl) {
      this.map.removeControl(this.routingControl);
      this.routingControl = null;
    }
    // if (this.toMarker) {
    //   this.map.removeLayer(this.toMarker);
    //   this.toMarker = null;
    // }
    
    // if (this.routingControl) {
    //   this.map.removeControl(this.routingControl);
    //   this.routingControl = null;
    // }
  }

  // Создание маркера точки назначения
  createDestinationMarker(latlng, options = {}) {
    const clientPlacement = !!options.clientPlacementSession;
    const centerFixedMode = !!options.centerFixedMode;
    // Удаляем предыдущий маркер назначения, если он существует
    if (this.toMarker) {
      this.map.removeLayer(this.toMarker);
      this.toMarker = null;
    }

    const icon = clientPlacement
      ? L.icon(APP_CONFIG.icons.mapPickPin)
      : L.icon(APP_CONFIG.icons.markerB);
    const zIndexOffset = clientPlacement ? 8000 : 0;

    this.toMarker = L.marker([latlng.lat, latlng.lng], {
      icon,
      draggable: !centerFixedMode,
      riseOnHover: true,
      zIndexOffset,
    }).addTo(this.map);

    if (centerFixedMode && this.toMarker.dragging) {
      this.toMarker.dragging.disable();
    }

    if (clientPlacement) {} else {
      this.toMarker.bindPopup(`
        <div style="text-align:center">
            <p style="color: #3e3e3e;font-size:16px;display: flex;align-items: center;justify-content: center;gap: 10px;">
                <svg width="30px" height="30px" viewBox="0 0 48 48" version="1" xmlns="http://www.w3.org/2000/svg" enable-background="new 0 0 48 48" fill="#000000"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <circle fill="#22bc33" cx="24" cy="24" r="21"></circle> <polygon fill="#CCFF90" points="34.6,14.6 21,28.2 15.4,22.6 12.6,25.4 21,33.8 37.4,17.4"></polygon> </g></svg>    
                Marşrut tikilib!
            </p>
        </div>    
    `).openPopup();
    }
    
    // Автозаполнение «Куда»: у клиента — после стабилизации маршрута (handleRoutesFound + 5 с).
    if (!this._isBookingMapUser()) {
      this.reverseGeocode(this.toMarker.getLatLng(), address => {
        const ti = document.getElementById('to-input');
        if (ti) ti.value = address;
      });
    }

    if (!centerFixedMode) {
      let dragRouteRaf = null;
      this.toMarker.on('dragstart', () => {
        this._cancelDeferredRouteZoom();
      });
      this.toMarker.on('drag', () => {
        if (dragRouteRaf != null) return;
        dragRouteRaf = requestAnimationFrame(() => {
          dragRouteRaf = null;
          if (this.toMarker) this.scheduleCalculateRoute(240);
        });
      });

      this.toMarker.on('dragend', e => {
        if (this._isBookingMapUser()) {
          this.scheduleCalculateRoute(140);
        } else {
          this.reverseGeocode(e.target.getLatLng(), address => {
            const ti = document.getElementById('to-input');
            if (ti) ti.value = address;
            this.scheduleCalculateRoute(140);
          });
        }
      });
    }
  }

  // Обновление интерфейса при построении маршрута
  updateUIForRoute() {
    const additionalButtons = document.querySelector('.additional-buttons');
    const pointBtn = document.getElementById("point-to-map-btn");
    const RouteBtn = document.getElementById("set-route-btn");
    
    if (pointBtn) pointBtn.style.display = "none";
    if (RouteBtn) RouteBtn.style.display = "none";
    if (additionalButtons) additionalButtons.style.display = "flex";
    this.updateCancelRouteMapBtnVisibility();
  }

  /** Один пересчёт маршрута после серии drag/гео-событий (debounce ~500 ms). */
  scheduleCalculateRoute(delayMs = 520) {
    if (this._routeRecalcDebounceTimer) clearTimeout(this._routeRecalcDebounceTimer);
    this._routeRecalcDebounceTimer = setTimeout(() => {
      this._routeRecalcDebounceTimer = null;
      this.calculateRoute();
    }, delayMs);
  }

  _cancelDeferredRouteZoom() {
    if (this._routeFitBoundsTimer) {
      clearTimeout(this._routeFitBoundsTimer);
      this._routeFitBoundsTimer = null;
    }
  }

  _cancelDeferredAddressLookup() {
    if (this._addressLookupAfterRouteTimer) {
      clearTimeout(this._addressLookupAfterRouteTimer);
      this._addressLookupAfterRouteTimer = null;
    }
  }

  /**
   * Через 5 с после последнего вызова обновить подписи A/B из reverseGeocode (только клиент).
   * Сбрасывается при каждом новом маршруте / clearExistingRoute — меньше запросов к Nominatim (429).
   */
  _scheduleDeferredAddressLookup() {
    if (!this._isBookingMapUser()) return;
    this._cancelDeferredAddressLookup();
    this._addressLookupAfterRouteTimer = setTimeout(() => {
      this._addressLookupAfterRouteTimer = null;
      const fi = document.getElementById('from-input');
      const ti = document.getElementById('to-input');
      if (this.fromMarker && fi) {
        this.reverseGeocode(this.fromMarker.getLatLng(), (addr) => {
          fi.value = addr;
        });
      }
      if (this.toMarker && ti) {
        this.reverseGeocode(this.toMarker.getLatLng(), (addr) => {
          ti.value = addr;
        });
      }
    }, 2000);
  }

  /**
   * Через 6 с после последнего найденного маршрута подогнать карту под линию (клиент, A+B).
   * Пока пользователь двигает B, таймер сбрасывается на каждом routesfound.
   */
  _scheduleDeferredRouteZoom(route) {
    this._cancelDeferredRouteZoom();
    if (!this._isBookingMapUser() || !this.map || !route || !route.coordinates || !route.coordinates.length) {
      return;
    }
    const coords = route.coordinates;
    this._routeFitBoundsTimer = setTimeout(() => {
      this._routeFitBoundsTimer = null;
      if (!this.map) return;
      try {
        const bounds = L.latLngBounds(coords);
        if (bounds.isValid()) {
          this.map.fitBounds(bounds, {
            padding: [48, 48],
            animate: true,
            maxZoom: APP_CONFIG.map.defaultMaxZoom,
          });
        }
      } catch (e) {
        console.warn('[map] deferred route fitBounds', e);
      }
    }, 6000);
  }

  _mapAnimOpts() {
    const low = document.documentElement?.dataset?.jiBatteryLow === '1';
    return low
      ? { animate: false, duration: 0 }
      : { animate: true, duration: APP_CONFIG.map.defaultDuration };
  }

  /** Серверный предпросмотр цены (ступени км, минуты, спрос, волна 1). */
  async refreshPricingQuotePreview(distanceKm, durationMinutes) {
    try {
      const km = Number(distanceKm);
      const min = Math.max(0, Number(durationMinutes) || 0);
      if (!Number.isFinite(km)) return;
      const r = await fetch(
        '/api/pricing/quote?km=' +
          encodeURIComponent(String(km)) +
          '&minutes=' +
          encodeURIComponent(String(min)) +
          '&wave=1',
        { credentials: 'same-origin' }
      );
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.price != null && Number.isFinite(Number(j.price))) {
        const price = Number(j.price).toFixed(2);
        this.safeSetTextContent('additional-price', price + ' ₼');
        this.safeSetTextContent('client-totla-price', price + ' ₼');
        this.safeSetTextContent('additional-price-order', price + ' ₼');
        this.safeSetTextContent('client-totla-price-order', price + ' ₼');
      }
    } catch (e) {
      console.warn('[map] pricing quote', e);
    }
  }

  // Расчет маршрута
  async calculateRoute() {
    if (!this.fromMarker || !this.toMarker) return;
    this.clearExistingRoute();
    
    const self = this;
    const createMarker = (waypointIndex, waypoint, numberOfWaypoints) => {
        if (waypointIndex === 0 && self.fromMarker) return null;
        if (waypointIndex === 1 && self.toMarker) return null;
        return L.marker(waypoint.latLng, {
          icon: L.icon(APP_CONFIG.icons.markerA),
          draggable: self._clientPickupFromDraggable(),
        });
    };
    this.routingControl = L.Routing.control({
        waypoints: [this.fromMarker.getLatLng(), this.toMarker.getLatLng()],
        router: L.Routing.osrmv1({serviceUrl: APP_CONFIG.routing.serviceUrl}),
        routeWhileDragging: true,
        fitSelectedRoutes: false,
        createMarker: createMarker,
        lineOptions: {styles: [{color: '#007ccfff', weight: 4}]},
        addWaypoints: false
    }).on("routesfound", this.handleRoutesFound.bind(this)).addTo(this.map);
    // Ищем таксистов для маршрута
    // const drivers = await window.taxiServices.findDriversForRoute(
    //     this.fromMarker.getLatLng(),
    //     this.toMarker.getLatLng()
    // );
    
    // this.drivers = drivers;
    // this.showDriversOnMap();
    // this.highlightNearestDriver(this.fromMarker.getLatLng());
  }

  // Обработка найденных маршрутов
  async handleRoutesFound(e) {
      if (!e.routes || e.routes.length === 0) return;
      
      const route = e.routes[0];
      const distanceMeters = route.summary.totalDistance;
      const distanceKm = distanceMeters / 1000;
      this.lastRouteDistanceKm = distanceKm;
      const timeSeconds = route.summary.totalTime;
      this._lastRouteTimeSeconds = timeSeconds;
      
      // Форматирование расстояния
      const distanceText = distanceMeters > 1000 
          ? distanceKm.toFixed(1) + ' km' 
          : Math.round(distanceMeters) + ' m';
      
      // Форматирование времени
      const hours = Math.floor(timeSeconds / 3600);
      const minutes = Math.floor((timeSeconds % 3600) / 60);
      const timeText = hours > 0 ? `${hours}s ${minutes} dəq` : `${minutes} dəq`;
      
      // Расчет цены
      // const nearestDriver = window.appControllers.findNearestDriver(this.fromMarker.getLatLng());
      
      // Безопасная установка значений
      this.safeSetTextContent('additional-metrs', distanceText);
      const addMetrsEl = document.getElementById('additional-metrs');
      if (addMetrsEl) {
          addMetrsEl.dataset.distanceKm = String(distanceKm);
      }
      this.safeSetTextContent('additional-timer', timeText);
      this.safeSetTextContent('additional-metrs-order', distanceText);
      this.safeSetTextContent('additional-timer-order', timeText);
    this.safeSetTextContent('client-taxi-go-distance-driving', distanceText);
    this.safeSetTextContent('client-taxi-go-time-order-driving', timeText);

    // this._scheduleDeferredRouteZoom(route);

    if (this._isBookingMapUser() && this.fromMarker && this.toMarker) {
      this._scheduleDeferredAddressLookup();
    }

    const dm = Math.max(1, Math.ceil(timeSeconds / 60));
    void this.refreshPricingQuotePreview(distanceKm, dm);

    //   if (nearestDriver) {
    //   } 
    //   else {
    //       this.safeSetTextContent('additional-price', '0.00 ₼');
    //       this.safeSetTextContent('client-totla-price', '0.00 ₼');
    //       this.safeSetTextContent('additional-price-order', '0.00 ₼');
    //       this.safeSetTextContent('client-totla-price-order', '0.00 ₼');
    //   }

  }
  

  // Добавьте этот вспомогательный метод
  safeSetTextContent(elementId, text) {
      const element = document.getElementById(elementId);
      if (element) {element.textContent = text;}
  }


//   // Поиск ближайщих водителей
//   async highlightNearestDriver(userLatLng) {
//     if (!this.taxiMarkers.length) return;

//     let nearestMarker = null;
//     let minDistance = Infinity;

//     this.taxiMarkers.forEach(marker => {
//         const distance = userLatLng.distanceTo(marker.getLatLng());
//         if (distance < minDistance) {
//             minDistance = distance;
//             nearestMarker = marker;
//         }
//         // Сбрасываем предыдущую подсветку
//         marker.setIcon(L.icon(APP_CONFIG.icons.taxi));
//     });

//     // Добавляем маркер на таксиста которыйсейчас рядом
//     if (nearestMarker) {
//         const highlightedIcon = L.divIcon({
//             ...APP_CONFIG.icons.taxi,
//             className: 'taxi-marker-nearest',
//             html: `<div class="nearest-taxi-custom-marker"><i class="fas fa-taxi"></i></div>`
//         });
//         nearestMarker.setIcon(highlightedIcon);
        
//         // Выводим информацию о ближайшем водителе в консоль
//         await this.addNearestDriverInfo(nearestMarker.driverData, minDistance);
//     }

//     return nearestMarker;
//   }

  // Вывод информации о ближайшем водителе в консоль
  async addNearestDriverInfo(driver, distance) {
    if (!window.taxiApp.fromMarker) {return;}

    // Получаем координаты
    const userLatLng = window.taxiApp.fromMarker.getLatLng();
    const driverLatLng = L.latLng(driver.location);
    
    // Рассчитываем время от водителя к пользователю
    const timeToUser = await this.calculateDrivingTime(driverLatLng, userLatLng);
    
    // Обновляем UI с информацией о водителе
    // document.getElementById('modal-taxi-avatar').src = "data:image/png;base64," + driver.photo;
    // this.safeSetTextContent('taxi-id', driver.id);
    // this.safeSetTextContent('client-taxi-go-distance', this.formatDistance(distance));
    // this.safeSetTextContent('client-taxi-go-time', timeToUser);
    // this.safeSetTextContent('modal-taxi-name', driver.name);
    // this.safeSetTextContent('modal-taxi-rating', driver.rating);
    // this.safeSetTextContent('modal-taxi-car-model', driver.carModel);
    // this.safeSetTextContent('modal-taxi-car-number', driver.carNumber);

    // document.getElementById('modal-taxi-avatar-order').src = "data:image/png;base64," + driver.photo;
    // this.safeSetTextContent('client-taxi-go-distance-order', this.formatDistance(distance));
    // this.safeSetTextContent('client-taxi-go-time-order', timeToUser);
    // this.safeSetTextContent('modal-taxi-name-order', driver.name);
    // this.safeSetTextContent('modal-taxi-rating-order', driver.rating);
    // this.safeSetTextContent('modal-taxi-car-model-order', driver.carModel);
    // this.safeSetTextContent('modal-taxi-car-number-order', driver.carNumber);
  }
  
  // Форматирование расстояния
  formatDistance(meters) {
      if (meters >= 1000) {
          // Для расстояний больше 1 км показываем в км с одной decimal
          return (meters / 1000).toFixed(1) + 'km';
      } else {
          // Для коротких расстояний показываем в метрах
          return Math.round(meters) + 'm';
      }
  }



  // Обработка клика по кнопке заказа
  async handleOrderClick() {
    // Web Push: до первого await сохраняется пользовательский жест для requestPermission.
    if (
      window.JIPWA &&
      typeof window.JIPWA.subscribePush === 'function' &&
      window.JIPWA.isPushLikelySupported &&
      window.JIPWA.isPushLikelySupported()
    ) {
      void window.JIPWA.subscribePush().catch((e) =>
        console.warn('[PWA] subscribePush (client order):', e)
      );
    }
    const from = document.getElementById('from-input').value;
    const to = document.getElementById('to-input').value;
    
    if (!from || !to) {await window.appControllers.validateAndBuild(); return;}

    const fromWrapper = document.getElementById("from-input-location");
    const toWrapper = document.getElementById("to-input-location");
    
    // Сбрасываем ошибки
    fromWrapper.classList.remove("error");
    toWrapper.classList.remove("error");

    if (this.routeStatus) {
        try {

            const client_data = await window.taxiServices.loadUserProfile();            
            if (client_data && client_data.success) {
                // Создаем заказ на сервере
                this.openTaxiSearchingModal();
                const rts = Number(this._lastRouteTimeSeconds) || 0;
                const orderData = {
                    clientID: client_data.user.id, // В реальном приложении здесь будет ID пользователя
                    fromLocation: [this.fromMarker.getLatLng().lat, this.fromMarker.getLatLng().lng],
                    toLocation: [this.toMarker.getLatLng().lat, this.toMarker.getLatLng().lng],
                    distance: this.getOrderDistanceKm(),
                    clientName: client_data.user.surname[0] + ". " + client_data.user.name,
                    clientRating: client_data.user.rating,
                    startAddress: document.getElementById('from-input').value,
                    endAddress: document.getElementById('to-input').value,
                    drivingTime: document.getElementById('additional-timer').textContent,
                    routeDurationMinutes: Math.max(1, Math.ceil(rts / 60)),
                };

                const orderResult = await window.taxiServices.createOrder(orderData);
                
                if (orderResult) {
                    console.log('Order created successfully:', orderResult);
                    const sc = document.getElementById('searching-cancel-button-client');
                    if (sc && orderResult.trip_id != null) {
                        sc.dataset.tripId = String(orderResult.trip_id);
                    }
                    if (orderResult.trip_id != null && window.taxiApp) {
                        window.taxiApp.activeOrder = {
                            trip_id: Number(orderResult.trip_id),
                            client_id: Number(client_data.user.id),
                            start_lat: orderData.fromLocation[0],
                            start_lon: orderData.fromLocation[1],
                            end_lat: orderData.toLocation[0],
                            end_lon: orderData.toLocation[1],
                            start_address: orderData.startAddress,
                            end_address: orderData.endAddress,
                            distance: orderData.distance,
                            driving_time: orderData.drivingTime,
                            status: orderResult.status || 'pending',
                        };
                        window.taxiApp.syncClientPickupMarkerDrag?.();
                    }
                    // Цена после первой волны диспетчеризации (волна/спрос могут отличаться от предпросмотра quote).
                    if (
                        orderResult.price != null &&
                        Number.isFinite(Number(orderResult.price))
                    ) {
                        const price = Number(orderResult.price).toFixed(2);
                        this.safeSetTextContent('additional-price', price + ' ₼');
                        this.safeSetTextContent('client-totla-price', price + ' ₼');
                        this.safeSetTextContent('additional-price-order', price + ' ₼');
                        this.safeSetTextContent('client-totla-price-order', price + ' ₼');
                    }
                } else {
                    throw new Error('Failed to create order');
                }
            }

            else {
                console.log('Failed to load user profile');
                await window.profileManager.showProfile();

                // alert('Ошибка при загрузке профиля пользователя');
                // this.unlockInterface(); // Разблокируем при ошибке
            }

                
        } catch (error) {
            console.error('Error creating order:', error);
            // alert('Ошибка при создании заказа');
            // this.unlockInterface(); // Разблокируем при ошибке
        }
    
    }
    else {document.getElementById("set-route-btn").click();}
  }

  // Открытие модального окна с информацией о поездке и о таксисте
  openTaxiDetailsModal() {
    document.getElementById('order-modal').style.display = 'flex';
    document.getElementById('order-modal-taxi-details').style.display = 'block';
  }

  openTaxiReasonsModal() {
    document.getElementById('order-modal').style.display = 'flex';
    document.getElementById('order-cancel-reasons-modal').style.display = 'block';
    document.querySelector('#order-cancel-reasons-modal .taxi-reasons').style.display = 'flex';
  }

  openClientReasonsModal() {
    document.getElementById('order-modal').style.display = 'flex';
    document.getElementById('order-cancel-reasons-modal').style.display = 'block';
    document.querySelector('#order-cancel-reasons-modal .client-reasons').style.display = 'flex';
  }

  closeTaxiReasonsModal() {
    document.getElementById('order-modal').style.display = 'none';
    document.getElementById('order-cancel-reasons-modal').style.display = 'none';
    document.querySelector('#order-cancel-reasons-modal .taxi-reasons').style.display = 'none';
  }

  closeClientReasonsModal() {
    document.getElementById('order-modal').style.display = 'none';
    document.getElementById('order-cancel-reasons-modal').style.display = 'none';
    document.querySelector('#order-cancel-reasons-modal .client-reasons').style.display = 'none';
  }

  // Открытие модального окна с ожиданием таксиста
  openTaxiSearchingModal() {
    document.getElementById('order-modal').style.display = 'flex';
    document.getElementById('order-modal-taxi-searching').style.display = 'block';
    const hintRow = document.getElementById('dispatch-wait-hint-row');
    const hintBtn = document.getElementById('dispatch-wait-boost-btn');
    if (hintRow) hintRow.style.display = 'none';
    if (hintBtn) {
      hintBtn.disabled = false;
      hintBtn.onclick = null;
    }
    this.syncClientPickupMarkerDrag();
    this.startSearchTimer();
  }

  /**
   * После отказа водителя ждать клиента: снова показать поиск (тот же trip_id).
   */
  resumeClientTripSearchUi(tripId) {
    const tid = tripId != null ? String(tripId) : '';
    const cb = document.getElementById('searching-cancel-button-client');
    if (cb && tid) cb.dataset.tripId = String(tid);
    const det = document.getElementById('order-modal-taxi-details');
    const sea = document.getElementById('order-modal-taxi-searching');
    const om = document.getElementById('order-modal');
    if (det) det.style.display = 'none';
    if (om) om.style.display = 'flex';
    if (sea) sea.style.display = 'block';
    this.syncClientPickupMarkerDrag();
    this.startSearchTimer();
  }

  // Закрытие модального окна с информацией о поездке и о таксисте
  closeTaxiDetailsModal() {
    document.getElementById('order-modal').style.display = 'none';
    document.getElementById('order-modal-taxi-details').style.display = 'none';
  }

  // Закрытие модального окна с ожиданием таксиста
  closeTaxiSearchingModal() {
    document.getElementById('order-modal').style.display = 'none';
    document.getElementById('order-modal-taxi-searching').style.display = 'none';
    this.stopSearchTimer();
    this.syncClientPickupMarkerDrag();
  }

  // Закрытие всех модальных окон   
  closeMainModal() {
    document.getElementById('order-modal').style.display = 'none';
  }

  /** Сброс строк расстояния/цены/времени в панели адреса после поездки или отмены. */
  resetAddressInputsAdditionalSummary() {
    const ab = document.querySelector('.address-inputs > .additional-buttons');
    if (!ab) return;
    const m = ab.querySelector('#additional-metrs');
    const p = ab.querySelector('#additional-price');
    const t = ab.querySelector('#additional-timer');
    if (m) {
      m.textContent = '0m';
      m.removeAttribute('data-distance-km');
    }
    if (p) p.textContent = '0.00 ₼';
    if (t) t.textContent = '0 dəq';
    ab.style.display = 'none';
  }

  /** Убрать подсветку этапа у всех блоков прогресса заказа. */
  clearAllOrderTaxiProgressActive() {
    document.querySelectorAll('.order-taxi-progress-container').forEach((el) => {
      el.classList.remove('active');
    });
  }

  // Обновление состоянии поездки (trips.state, выровнено с backend)
  updateTripStateUI(state = 'driver_arrived') {
    const leg =
      typeof window.normalizeTripLegState === 'function'
        ? window.normalizeTripLegState(state)
        : state;

    const drivingContainer = document.querySelector('.order-taxi-progress-container.state-driving');
    const arrivedContainer = document.querySelector('.order-taxi-progress-container.state-arrived');
    const startedContainer = document.querySelector('.order-taxi-progress-container.state-onboard');
    const completedContainer = document.querySelector('.order-taxi-progress-container.state-completed');

    if (drivingContainer) drivingContainer.classList.remove('active');
    if (arrivedContainer) arrivedContainer.classList.remove('active');
    if (startedContainer) startedContainer.classList.remove('active');
    if (completedContainer) completedContainer.classList.remove('active');

    switch (leg) {
      case 'driving':
      case 'en_route':
      case 'pending_confirm':
        if (drivingContainer) drivingContainer.classList.add('active');
        break;
      case 'driver_arrived':
      case 'waiting':
        if (arrivedContainer) arrivedContainer.classList.add('active');
        break;
      case 'onboard':
        if (startedContainer) startedContainer.classList.add('active');
        break;
      case 'in_progress':
      case 'progress':
      case 'paused':
        if (drivingContainer) drivingContainer.classList.add('active');
        break;
      case 'at_destination':
      case 'arrived':
        if (arrivedContainer) arrivedContainer.classList.add('active');
        break;
      case 'finished':
      case 'done':
      case 'completed':
        // Поездка завершена — ни один этап не подсвечиваем (сброс в applyPostTripCancelNav).
        break;
      default:
        if (!String(leg || '').startsWith('cancel_')) {
          console.warn('Неизвестное состояние поездки:', leg);
        }
    }

    const ac = window.appControllers;
    if (
      ac &&
      typeof ac.applyTripLegMapFromState === 'function' &&
      leg &&
      !String(leg).startsWith('cancel_')
    ) {
      try {
        ac.applyTripLegMapFromState(leg);
      } catch (e) {
        console.warn('[map] applyTripLegMapFromState', e);
      }
    }
    if (ac?.showDestinationArrivedButton) {
      if (leg !== 'in_progress' && leg !== 'progress' && leg !== 'paused') {
        ac.showDestinationArrivedButton(false);
      }
    }

    // При переходе в in_progress перезапускаем watch с меньшим maximumAge (опции watchPosition не меняются «на лету»).
    if (
      localStorage.getItem('userType') === 'driver' &&
      this.activeOrder?.trip_id &&
      this.watchId != null &&
      (leg === 'in_progress' || leg === 'progress' || leg === 'paused')
    ) {
      const prevLeg = this._geoWatchLegForDriver;
      this._geoWatchLegForDriver = leg;
      if (prevLeg !== leg && leg === 'in_progress') {
        this.stopDriverLocationTracking();
        this.startDriverLocationTracking();
      }
    } else if (localStorage.getItem('userType') !== 'driver') {
      this._geoWatchLegForDriver = undefined;
    }
  }

  _setBottomNavRatingModalClosed(on) {
    const nav = document.querySelector('.bottom-nav');
    if (nav) nav.classList.toggle('closed', !!on);
  }

  closeTripRatingModal() {
    const m = document.getElementById('trip-rating-modal');
    if (m) m.style.display = 'none';
    this._setBottomNavRatingModalClosed(false);
    this._tripRatingStars = 0;
    this._tripRatingReasonKeys = new Set();
    const wrap = document.getElementById('trip-rating-reasons-wrap');
    const rc = document.getElementById('trip-rating-reasons');
    if (wrap) wrap.hidden = true;
    if (rc) {
      rc.innerHTML = '';
      rc.onclick = null;
    }
  }

  openTripRatingModalIfNeeded() {
    const order = this.activeOrder;
    if (!order?.trip_id) return;
    const tid = Number(order.trip_id);
    const leg =
      typeof window.normalizeTripLegState === 'function'
        ? window.normalizeTripLegState(order.state || '')
        : String(order.state || '');
    if (leg !== 'at_destination') return;
    if (this._ratingModalShownForTripId === tid) return;
    this._ratingModalShownForTripId = tid;

    const modal = document.getElementById('trip-rating-modal');
    if (!modal) return;

    const role = localStorage.getItem('userType');
    const TR = window.TripRatingShared;
    if (!TR) return;

    const titleEl = document.getElementById('trip-rating-title');
    const nameEl = document.getElementById('trip-rating-peer-name');
    const ratingEl = document.getElementById('trip-rating-peer-rating');
    const photoEl = document.getElementById('trip-rating-peer-photo');
    const starsRow = document.getElementById('trip-rating-stars');
    const reasonsWrap = document.getElementById('trip-rating-reasons-wrap');
    const reasonsEl = document.getElementById('trip-rating-reasons');
    const reasonsHint = document.getElementById('trip-rating-reasons-hint');
    const submitBtn = document.getElementById('trip-rating-submit');
    if (
      !titleEl ||
      !nameEl ||
      !ratingEl ||
      !photoEl ||
      !starsRow ||
      !reasonsWrap ||
      !reasonsEl ||
      !reasonsHint ||
      !submitBtn
    ) {
      return;
    }

    const setPeerRatingEl = (ratingVal) => {
      const n = Number(ratingVal);
      ratingEl.classList.remove('trip-rating-peer__rating--empty');
      if (Number.isFinite(n)) {
        ratingEl.innerHTML = `<i class="fas fa-star" aria-hidden="true"></i> ${n.toFixed(1)}`;
        ratingEl.setAttribute('aria-label', `Reytinq ${n.toFixed(1)}`);
      } else {
        ratingEl.classList.add('trip-rating-peer__rating--empty');
        ratingEl.textContent = 'Reytinq —';
        ratingEl.setAttribute('aria-label', 'Reytinq yoxdur');
      }
    };

    if (role === 'client') {
      titleEl.textContent = 'Sürücünü qiymətləndirin';
      nameEl.textContent = order.taxi_name || 'Sürücü';
      setPeerRatingEl(order.taxi_rating);
      photoEl.src =
        typeof window.profileAvatarSrc === 'function'
          ? window.profileAvatarSrc(order.taxi_avatar)
          : '/static/images/user-profile-avatar.png';
    } else if (role === 'driver') {
      titleEl.textContent = 'Müştərini qiymətləndirin';
      nameEl.textContent = order.client_name || 'Müştəri';
      setPeerRatingEl(order.client_rating);
      photoEl.src =
        typeof window.profileAvatarSrc === 'function'
          ? window.profileAvatarSrc(order.client_avatar)
          : '/static/images/user-profile-avatar.png';
    } else {
      return;
    }

    this._tripRatingStars = 0;
    this._tripRatingReasonKeys = new Set();
    reasonsWrap.hidden = true;
    reasonsEl.innerHTML = '';
    reasonsEl.onclick = null;

    starsRow.innerHTML = '';
    for (let i = 1; i <= 5; i += 1) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'trip-rating-star-btn';
      b.dataset.star = String(i);
      b.innerHTML = '<i class="far fa-star"></i>';
      starsRow.appendChild(b);
    }
    const paintStars = (n) => {
      starsRow.querySelectorAll('.trip-rating-star-btn').forEach((btn) => {
        const sn = Number(btn.dataset.star);
        btn.innerHTML =
          sn <= n ? '<i class="fas fa-star"></i>' : '<i class="far fa-star"></i>';
      });
    };

    const syncReasonChips = () => {
      const n = this._tripRatingStars;
      if (!n) {
        reasonsWrap.hidden = true;
        reasonsEl.innerHTML = '';
        reasonsEl.onclick = null;
        return;
      }
      reasonsWrap.hidden = false;
      this._tripRatingReasonKeys = new Set();
      const opts = TR.getReasonOptionsForRole(role === 'driver' ? 'driver' : 'client', n);
      reasonsHint.textContent =
        n >= 4
          ? 'Nə xoşunuza gəldi? (bir neçə seçə bilərsiniz)'
          : 'Nə yaxşı olmadı? (bir neçə seçə bilərsiniz)';
      reasonsEl.innerHTML = '';
      opts.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'trip-rating-reason-chip';
        b.dataset.reason = o.id;
        b.textContent = o.label;
        reasonsEl.appendChild(b);
      });
      reasonsEl.onclick = (ev) => {
        const btn = ev.target.closest('.trip-rating-reason-chip');
        if (!btn) return;
        const id = btn.dataset.reason;
        if (!id) return;
        if (this._tripRatingReasonKeys.has(id)) {
          this._tripRatingReasonKeys.delete(id);
          btn.classList.remove('is-selected');
        } else {
          this._tripRatingReasonKeys.add(id);
          btn.classList.add('is-selected');
        }
      };
    };

    starsRow.onclick = (ev) => {
      const btn = ev.target.closest('.trip-rating-star-btn');
      if (!btn) return;
      const n = Number(btn.dataset.star);
      if (!Number.isFinite(n)) return;
      this._tripRatingStars = n;
      paintStars(n);
      syncReasonChips();
    };

    submitBtn.onclick = async () => {
      if (!this._tripRatingStars) {
        return;
      }
      submitBtn.disabled = true;
      try {
        const reasonList = Array.from(this._tripRatingReasonKeys);
        await window.taxiServices.submitTripPeerRating(tid, this._tripRatingStars, reasonList);
        this.closeTripRatingModal();
      } catch (e) {
        console.error('[trip rating]', e);
      } finally {
        submitBtn.disabled = false;
      }
    };

    this._setBottomNavRatingModalClosed(true);
    modal.style.display = 'flex';
  }

  




  // Обратный геокодинг
  reverseGeocode(latlng, callback) {
    const url = `${APP_CONFIG.geocoding.serviceUrl}?format=${APP_CONFIG.geocoding.format}&lat=${latlng.lat}&lon=${latlng.lng}`;
    const fallback = "";
    
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (data && data.display_name) {
          callback(this.shortenAddress(data.display_name));
        } else {
          callback(fallback);
        }
      })
      .catch(err => {
        // console.log('GeoCoding error:', err);
        callback(fallback);
      });
  }

  // Получение адреса по координатам
  async getAddressFromCoordinates(lat, lon) {
    const url = `${APP_CONFIG.geocoding.serviceUrl}?format=${APP_CONFIG.geocoding.format}&lat=${lat}&lon=${lon}`;
    const fallback = "Son nöqtə";
    
    try {
      const response = await fetch(url);
      if (!response.ok) return fallback;
      const data = await response.json();
      
      if (data && data.display_name) {
        return this.shortenAddress(data.display_name);
      }
      return fallback;
    } catch (error) {
      return fallback;
    }
  }

  // Сокращение адреса
  shortenAddress(fullAddress) {
    if (!fullAddress) return '';
    const parts = fullAddress.split(',');
    return parts.slice(0, 2).join(','); // улица, дом
  }

  // Загрузка данных о водителях
//   async loadDrivers() {
//     try {
//         const userLatLng = this.fromMarker ? this.fromMarker.getLatLng() : this.map.getCenter();
        
//         console.log('Loading drivers for location:', userLatLng);
        
//         const wsStatus = this.checkWebSocketStatus();
//         console.log('WebSocket status:', wsStatus);
        
//         if (wsStatus === 'connected') {
//             // Используем WebSocket
//             console.log('Using WebSocket for drivers');
//             window.taxiServices.wsService.getNearbyDrivers(
//                 userLatLng.lat, 
//                 userLatLng.lng, 
//                 5.0
//             );
            
//             // НЕ запускаем периодическое обновление для WebSocket
//             // WebSocket будет отправлять данные автоматически
            
//         } else {
//             // Fallback к HTTP
//             console.log('Using HTTP fallback for drivers');
//             // this.drivers = await window.taxiServices.getNearbyDriversHTTP(userLatLng);
//             // console.log('HTTP drivers response:', this.drivers);
//             // this.showDriversOnMap();
//             // this.renderDriversList();
            
//             // Запускаем периодическое обновление только для HTTP
//             // if (window.taxiServices) {
//             //     window.taxiServices.startDriversUpdates(userLatLng, (drivers) => {
//             //         console.log('Periodic drivers update:', drivers);
//             //         if (drivers && Array.isArray(drivers)) {
//             //             this.handleDriversUpdate(drivers);
//             //         } else {
//             //             console.warn('Invalid drivers data received:', drivers);
//             //         }
//             //     });
//             // }
//         }
        
//     } catch (error) {
//         console.error('Error loading drivers:', error);
//         this.drivers = this.getFallbackDrivers();
//         this.showDriversOnMap();
//         this.renderDriversList();
//     }
//   }

  // Заглушка для тестирования -- TEST
  // getFallbackDrivers() {
  //     console.log('[!] Сервер не доступен, используется локальная база!');
  //     return [
  //         {
  //             id: 1,
  //             name: "Slavik Velibeyov",
  //             photo: "https://randomuser.me/api/portraits/men/32.jpg",
  //             carModel: "Daewoo Nexia",
  //             carYear: 2010,
  //             carColor: "Черный",
  //             carNumber: "10 DX 602",
  //             pricePerKm: 0.45,
  //             location: [41.630496, 48.442119],
  //             rating: 4.8,
  //             status: "available",
  //             currentLocation: [41.630496, 48.442119]
  //         }
  //         // ... остальные водители
  //     ];
  // }

  // Отображение водителей на карте
  // showDriversOnMap() {
  //     // Очистка предыдущих маркеров - ИСПРАВЛЕННЫЙ КОД
  //     Object.values(this.driverMarkers).forEach(marker => {
  //         if (marker && this.map.hasLayer(marker)) {
  //             this.map.removeLayer(marker);
  //         }
  //     });
  //     this.driverMarkers = {};
  //     this.taxiMarkers = [];
      
  //     // ДОБАВЛЕНИ новых маркеров на карте
  //     this.drivers.forEach(driver => {
  //       if (!driver || !driver.location) {
  //           console.error('Invalid driver data:', driver);
  //           return;
  //       }
        
  //       // Проверяем координаты
  //       const lat = driver.location[0];
  //       const lng = driver.location[1];
        
  //       if (typeof lat !== 'number' || typeof lng !== 'number' || 
  //           isNaN(lat) || isNaN(lng) || 
  //           lat < -90 || lat > 90 || lng < -180 || lng > 180) {
  //           console.error('Invalid driver coordinates:', driver.id, driver.location);
  //           return;
  //       }
        
  //       // Создаем маркер
  //       const taxiIcon = L.icon(APP_CONFIG.icons.taxi);
  //       const marker = L.marker([lat, lng], {icon: taxiIcon})
  //           .addTo(this.map)
  //           .bindPopup(this.createDriverPopupContent(driver));
        
  //       // Сохраняем данные водителя в маркере
  //       marker.driverData = driver;
        
  //       this.taxiMarkers.push(marker);
  //       this.driverMarkers[driver.id] = marker;
  //     });
      
  //     console.log('Total drivers on map:', this.taxiMarkers.length);
  // }

  // Очистка при уничтожении приложения
  // destroy() {
  //     // Удаляем обработчики WebSocket
  //     if (this.driversUpdateHandler && window.taxiServices && window.taxiServices.wsService) {
  //         window.taxiServices.wsService.off('nearby_drivers', this.driversUpdateHandler);
  //         window.taxiServices.wsService.off('connected', this.wsConnectHandler);
  //         window.taxiServices.wsService.off('close', this.wsDisconnectHandler);
  //     }
      
  //     // Останавливаем периодические обновления
  //   //   if (window.taxiServices) {
  //   //       window.taxiServices.stopDriversUpdates();
  //   //   }
      
  //     // Останавливаем обновления локации
  //     this.stopLocationUpdates();
      
  //     // Очищаем маркеры
  //     Object.values(this.driverMarkers).forEach(marker => {
  //         if (marker && this.map.hasLayer(marker)) {
  //             this.map.removeLayer(marker);
  //         }
  //     });
  //     this.driverMarkers = {};
  //     this.taxiMarkers = [];
      
  //     // Очищаем таймеры
  //     this.stopSearchTimer();
      
  //     console.log('TaxiApp destroyed');
  // }

  // Создание содержимого всплывающего окна для водителя
  // createDriverPopupContent(driver) {
    
  //   return `
  //     <input type="hidden" id="driver-id" value="${driver.id}">
  //     <div style="min-width: 220px; display: flex; flex-direction: column;">
  //       <div style="padding-bottom: 10px;border-bottom: 1px dashed #0000001c; margin-bottom: 10px;">
  //         <img src="data:image/png;base64,${driver.photo}" alt="${driver.name}" style="width: 50px; height: 50px; border-radius: 50%; float: left; margin-right: 10px;">
  //         <b id="driver-name">${driver.name}</b><br>
  //         <div style="display: flex; align-items: center; margin: 5px 0;">
  //           <span id="driver-rating" style="color: gold; margin-right: 5px;">
  //             <i class="fas fa-star"></i> ${driver.rating}
  //           </span>
  //         </div>
  //       </div>
  //       <div>
  //         <span style="gap: 5px; display: flex; align-items: flex-end;"><i class="fas fa-car nav-icon"></i> <b id="driver-car-model">${driver.carModel}</b> <span id="driver-car-year" style="padding: 1px 10px;border-left: 3px solid #ccc;border-radius: 3px;background: #1a2c3e12;fo;margin-left: 6px;t;">${driver.carYear}</span> </span> 
  //         <div style="display: flex;align-items: center;justify-content: space-between;margin-top: 10px;flex-direction: row-reverse;">
  //           <span id="driver-price-per-km" style="font-size: 14px;font-weight: normal;"><i class="fas fa-road"></i> ${window.taxiServices.pricePerKm} ₼ / km</span>
  //           <span id="driver-car-number" style="padding: 5px 10px;border-radius: 6px;background: #1a2c3e;font-weight: bold;color: white;display: flex;align-items: center;">
  //             <svg style="margin-right: 5px;" width="15px" height="15px" viewBox="0 -4 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <g clip-path="url(#clip0_503_4502)"> <rect width="28" height="20" rx="2" fill="white"></rect> <mask id="mask0_503_4502" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="28" height="20"> <rect width="28" height="20" rx="2" fill="white"></rect> </mask> <g mask="url(#mask0_503_4502)"> <path fill-rule="evenodd" clip-rule="evenodd" d="M0 6.66667H28V0H0V6.66667Z" fill="#24AAD5"></path> <path fill-rule="evenodd" clip-rule="evenodd" d="M0 20H28V13.3333H0V20Z" fill="#21BF75"></path> <path fill-rule="evenodd" clip-rule="evenodd" d="M0 13.3333H28V6.66666H0V13.3333Z" fill="#ED1845"></path> <g filter="url(#filter0_d_503_4502)"> <path fill-rule="evenodd" clip-rule="evenodd" d="M14 12C14.4113 12 14.7936 11.8759 15.1114 11.663C15.0747 11.6654 15.0376 11.6666 15.0002 11.6666C14.0797 11.6666 13.3335 10.9205 13.3335 9.99998C13.3335 9.0795 14.0797 8.33331 15.0002 8.33331C15.0375 8.33331 15.0746 8.33454 15.1114 8.33696C14.7935 8.12413 14.4113 8 14 8C12.8954 8 12 8.89543 12 10C12 11.1046 12.8954 12 14 12ZM15.9998 9.99998C15.9998 10.3682 15.7014 10.6666 15.3332 10.6666C14.965 10.6666 14.6665 10.3682 14.6665 9.99998C14.6665 9.63179 14.965 9.33331 15.3332 9.33331C15.7014 9.33331 15.9998 9.63179 15.9998 9.99998Z" fill="white"></path> </g> </g> </g> <defs> <filter id="filter0_d_503_4502" x="12" y="8" width="3.99988" height="5" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"> <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix> <feOffset dy="1"></feOffset> <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.06 0"></feColorMatrix> <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_503_4502"></feBlend> <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_503_4502" result="shape"></feBlend> </filter> <clipPath id="clip0_503_4502"> <rect width="28" height="20" rx="2" fill="white"></rect> </clipPath> </defs> </g></svg>
  //             ${driver.carNumber}
  //           </span>
  //         </div>
  //       </div>
        
  //     </div>
  //   `;
  // }

  // Отображение списка водителей
  // renderDriversList() {
  //   const driversList = document.getElementById('drivers-list');
  //   if (!driversList) return;
    
  //   driversList.innerHTML = '';
    
  //   this.drivers.forEach(driver => {
  //     const driverCard = document.createElement('div');
  //     driverCard.className = 'driver-card';
      
  //     driverCard.innerHTML = `
  //       <div class="driver-header">
  //         <img src="data:image/png;base64,${driver.photo}" alt="${driver.name}" class="driver-avatar">
  //         <div class="driver-info">
  //           <h3>${driver.name}</h3>
  //           <div class="driver-car">${driver.carModel} · ${driver.carColor} · ${driver.carNumber}</div>
  //           <div style="color: gold;">
  //             <i class="fas fa-star"></i> ${driver.rating}
  //           </div>
  //         </div>
  //       </div>
  //       <div class="driver-price">Тариф: ${window.taxiServices.pricePerKm} руб/км</div>
  //     `;
      
  //     driversList.appendChild(driverCard);
  //   });
  // }

  // Обработка клика по кнопке "Мои местоположения"
  handleMyLocationClick() {
      if (navigator.geolocation) {
          // Показываем индикатор загрузки
          this.showLocationLoading(true);
          
          navigator.geolocation.getCurrentPosition(
              this.handleMyLocationSuccess.bind(this),
              this.handleMyLocationError.bind(this),
              { 
                  enableHighAccuracy: true, 
                  timeout: 10000, 
                  maximumAge: 60000 
              }
          );
      } else {
      }
  }

  // Обработка успешного получения геолокации для "Мои местоположения"
  handleMyLocationSuccess(position) {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      // Во время активной поездки маркер и карта живут в mapInstance (AppControllers), а не в taxiApp.map
      if (
          localStorage.getItem('userType') === 'driver' &&
          window.taxiApp?.activeOrder?.trip_id &&
          window.taxiServices
      ) {
          window.taxiServices.updateDriverLocation(lat, lng);
          this.showLocationLoading(false);
          if (window.appControllers?.mapInstance?.map) {
              return;
          }
      }

      if (!this.map) {
          this.showLocationLoading(false);
          return;
      }
      
      // Удаляем предыдущую метку fromMarker, если она есть
      if (this.fromMarker) {
          this.map.removeLayer(this.fromMarker);
      }
      
      // Создаем новую метку fromMarker
      const custom_icon = localStorage.getItem("taxiNotificationStatus") === "available" ? APP_CONFIG.icons.taxi : APP_CONFIG.icons.markerA;
      this.fromMarker = L.marker([lat, lng], {
          icon: L.icon(custom_icon),
          draggable: this._clientPickupFromDraggable(),
      }).addTo(this.map);
      
      this.setupFromMarker();
      
      // Центрируем карту на местоположении
      this.map.flyTo([lat, lng], APP_CONFIG.map.defaultZoom, this._mapAnimOpts());
      
      // Обновляем локацию через WebSocket
      if (window.taxiServices) {
          window.taxiServices.updateDriverLocation(lat, lng);
          console.log('[handleMyLocationSuccess] УСПЕШНО')
      } 

      else {
        console.log('[handleMyLocationSuccess] НЕ ДОСТУПЕН')

      }
      
      // Скрываем индикатор загрузки
      this.showLocationLoading(false);
      
      // Если есть маршрут, пересчитываем его
      if (this.toMarker) {
          this.scheduleCalculateRoute();
      }
  }

  // Запуск отслеживании локации водителя
  startDriverLocationTracking() {
    if (!navigator.geolocation) {
      console.warn('[startDriverLocationTracking] Геолокация не поддерживается');
      return;
    }

    let maximumAge = 5000;
    let geoTimeoutMs = 15000;
    if (localStorage.getItem('userType') === 'driver' && this.activeOrder?.trip_id) {
      const leg =
        typeof window.normalizeTripLegState === 'function'
          ? window.normalizeTripLegState(this.activeOrder.state || '')
          : String(this.activeOrder.state || '');
      // Частый опрос, но не слишком агрессивный — иначе code 3 TIMEOUT при enableHighAccuracy.
      if (leg === 'in_progress' || leg === 'progress' || leg === 'paused') {
        maximumAge = 1200;
        geoTimeoutMs = 28000;
      } else if (
        leg === 'onboard' ||
        leg === 'driver_arrived' ||
        leg === 'waiting' ||
        leg === 'en_route' ||
        leg === 'driving' ||
        leg === 'pending_confirm'
      ) {
        maximumAge = 2000;
        geoTimeoutMs = 22000;
      } else {
        maximumAge = 3000;
        geoTimeoutMs = 20000;
      }
    }

    // В фоне (заблокированный экран / свёрнутое приложение) watchPosition может не выдавать новые точки,
    // особенно на iOS; TaxiServicesAdapter шлёт heartbeat с последней известной позицией.
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        this.handleMyLocationSuccess(position);
      },
      (error) => {
        console.warn('[startDriverLocationTracking] Геолокация:', error?.code, error?.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge,
        timeout: geoTimeoutMs
      }
    );

    console.log('[startDriverLocationTracking] Отслеживание водителя запущено', { maximumAge, timeout: geoTimeoutMs });
    if (window.taxiServices && typeof window.taxiServices.startDriverLocationHeartbeat === 'function') {
      window.taxiServices.startDriverLocationHeartbeat();
    }
  }

  // Остановка отслеживания локации водителя
  stopDriverLocationTracking() {
    if (this.watchId) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
      console.log('[stopDriverLocationTracking] Отслеживание остановлено');
    }
    if (window.taxiServices && typeof window.taxiServices.stopDriverLocationHeartbeat === 'function') {
      window.taxiServices.stopDriverLocationHeartbeat();
    }
  }

  // Настройка метки fromMarker
  setupFromMarker() {
      if (this._isBookingMapUser()) {
        this._scheduleDeferredAddressLookup();
      } else {
        this.reverseGeocode(this.fromMarker.getLatLng(), address => {
          const el = document.getElementById('from-input');
          if (el) el.value = address;
        });
      }

      this.fromMarker.off('dragend');
      this.fromMarker.on('dragend', e => {
          const newLatLng = e.target.getLatLng();
          if (this._isBookingMapUser()) {
            this._scheduleDeferredAddressLookup();
          } else {
            this.reverseGeocode(newLatLng, address => {
              const el = document.getElementById('from-input');
              if (el) el.value = address;
            });
          }
          
          // Обновляем локацию через WebSocket
          if (window.taxiServices) {
              window.taxiServices.updateDriverLocation(newLatLng.lat, newLatLng.lng);
              console.log('[setupFromMarker] УСПЕШНО')
          }

          else {
            console.log('[setupFromMarker] НЕ ДОСТУПЕН')

          }
          
          // Добавляем пересчет маршрута при перемещении fromMarker
          if (this.toMarker) {
              this.scheduleCalculateRoute();
          }

          // 🔹 Приближение карты к метке
          if (this.map) {
            // this.map.setView(newLatLng, 15); // мгновенно 
            this.map.flyTo(newLatLng, APP_CONFIG.map.defaultMaxZoom, this._mapAnimOpts());
          }
          
      });
      
      // Добавляем стандартное всплывающее окно
      // this.fromMarker.bindPopup(`
      //     <div style="text-align:center">
      //         <p style="color: #3e3e3e;font-size:15px;">
      //             Точка отправления
      //         </p>
      //     </div>
      // `);
      this.syncClientPickupMarkerDrag();
  }


  // Обработка ошибки геолокации
  handleMyLocationError(error) {
      this.showLocationLoading(false);
      
      switch(error.code) {
          case error.PERMISSION_DENIED:
              document.getElementById("notification-location-error").style.display = "flex";
              break;
          case error.POSITION_UNAVAILABLE:
              document.getElementById("notification-location-error").style.display = "flex";

              break;
          case error.TIMEOUT:
              document.getElementById("notification-location-error").style.display = "flex";
              break;
          default:
              document.getElementById("notification-location-error").style.display = "flex";
              break;
      }
  }


  // Показать/скрыть индикатор загрузки
  showLocationLoading(show) {
    const button = document.getElementById("my-locations-btn");
    if (button) {
      if (show) {
        document.querySelector('.geocoding-loader').style.display = 'flex';
        document.getElementById('geocoding-loader-text').textContent = "Yer axtarışı..";
        button.disabled = true;
      } 
      
      else {button.disabled = false;
        document.querySelector('.geocoding-loader').style.display = 'none';
      }
    }
  }

  showBusyTripLoading(show) {
    const button = document.getElementById("my-locations-btn");
    if (button) {
      if (show) {
        document.querySelector('.geocoding-loader').style.display = 'flex';
        document.getElementById('geocoding-loader-text').textContent = "Əvvəlki sifarişi yükləyin..";
        button.disabled = true;
      } 
      
      else {button.disabled = false;
        document.querySelector('.geocoding-loader').style.display = 'none';
      }
    }
  }


  // Переключение экранов
  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.remove('active');
    });
    
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });
    
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
      targetScreen.classList.add('active');
    }
    
    // Обновление активной кнопки в навигации
    const navItems = document.querySelectorAll('.nav-item');
    if (screenId === 'main-screen' && navItems[0]) {
      navItems[0].classList.add('active');
    } else if (screenId === 'drivers-screen' && navItems[1]) {
      navItems[1].classList.add('active');
    } else if (screenId === 'register-screen' && navItems[2]) {
      navItems[2].classList.add('active');
    }
    
    // Если показываем карту, обновляем её размер
    if (screenId === 'main-screen') {
      setTimeout(() => {
        this.map.invalidateSize();
      }, 300);
    }

    if (screenId === 'settings-screen' && typeof window.refreshSettingsScreenFromSession === 'function') {
      void window.refreshSettingsScreenFromSession();
    }
  }

  // Запуск секундомера
  startSearchTimer() {
      // Сбрасываем предыдущий таймер
      this.stopSearchTimer();
      
      // Запоминаем время старта
      this.searchStartTime = Date.now();
      
      // Обновляем сразу
      this.updateTimer();
      
      // Запускаем интервал
      this.searchTimer = setInterval(() => {
          this.updateTimer();
      }, 1000);

    //   // Случайное действие через 2-5 секунд
    //   const randomTime = Math.floor(Math.random() * 10000); // 2000-5000ms
    //   setTimeout(() => {
    //     this.closeTaxiSearchingModal();
    //     this.openTaxiDetailsModal();

    //   }, 1000);
  }

  // Обработка подтверждения заказа такси
  // async handleTaxiOrderConfirmation() {
  //   // Получаем ID водителя из скрытого поля
  //   const driverId = document.getElementById('taxi-id')?.textContent;
  //   if (!driverId) {return;}

  //   // Находим водителя по ID
  //   const selectedDriver = this.drivers.find(driver => driver.id.toString() === driverId);
  //   if (!selectedDriver) {return;}

  //   // Блокируем интерфейс перед созданием заказа
  //   this.lockInterface({
  //       driverId: selectedDriver.id,
  //       driverName: selectedDriver.name,
  //       timestamp: new Date().toISOString()
  //   });

  //   try {
  //     // Создаем заказ на сервере
  //     const orderData = {
  //         clientID: localStorage.getItem('userID'), // В реальном приложении здесь будет ID пользователя
  //         driverId: selectedDriver.id,
  //         fromLocation: [this.fromMarker.getLatLng().lat, this.fromMarker.getLatLng().lng],
  //         toLocation: [this.toMarker.getLatLng().lat, this.toMarker.getLatLng().lng],
  //         price: parseFloat(document.getElementById('additional-price').textContent),
  //         distance: parseFloat(document.getElementById('additional-metrs').textContent),
  //         drivingTime: document.getElementById('additional-timer').textContent
  //     };

  //     const orderResult = await window.taxiServices.createOrder(orderData);
      
  //     if (orderResult) {
  //         console.log('Order created successfully:', orderResult);
          
  //         this.fixSelectedDriver(selectedDriver);

  //     } else {
  //         throw new Error('Failed to create order');
  //     }
          
  //     } catch (error) {
  //         console.error('Error creating order:', error);
  //         alert('Ошибка при создании заказа');
  //         this.unlockInterface(); // Разблокируем при ошибке
  //     }

  //   // // Фиксируем водителя и строим маршрут
  //   // this.fixSelectedDriver(selectedDriver);
  // }

  // Добавляем метод для отмены заказа
//   async cancelActiveOrder() {
//       if (!this.activeOrder || !this.activeOrder.orderId) {
//           return;
//       }

//       try {
//           const result = await window.taxiServices.cancelOrder(this.activeOrder.orderId);
//           if (result) {
//               this.unlockInterface();
//               this.closeTaxiDetailsModal();
//               alert('Заказ отменен');
//           }
//       } catch (error) {
//           console.error('Error canceling order:', error);
//           alert('Ошибка при отмене заказа');
//       }
//   }

  // Убираем кнопку отмены
  removeCancelButton() {
      const cancelBtn = document.getElementById('cancel-order-btn');
      if (cancelBtn) {
          cancelBtn.remove();
      }
  }

  // Фиксация выбранного водителя
  // fixSelectedDriver(driver) {
  //     // Сохраняем выбранного водителя
  //     this.selectedDriver = driver;

  //     // Очищаем других таксистов
  //     // this.clearOtherTaxis(driver);

  //     // Строим маршрут от таксиста к клиенту
  //     this.buildTaxiToClientRoute(driver);

  //     // Обновляем UI
  //     this.updateUIAfterConfirmation(driver);

  //     // Закрываем модальные окна
  //     this.closeTaxiDetailsModal();

  //     // Добавляем информацию о заказе
  //     this.activeOrder = {
  //         ...this.activeOrder,
  //         orderId: driver.current_order,
  //         status: 'accepted'
  //     };
  // }

  // Очистка других таксистов
  clearOtherTaxis(selectedDriver) {
      // Удаляем все маркеры таксистов кроме выбранного
      this.taxiMarkers.forEach(marker => {
          const driverData = marker.driverData;
          if (driverData && driverData.id !== selectedDriver.id) {
              this.map.removeLayer(marker);
          }
      });

      // Фильтруем массив taxiMarkers
      this.taxiMarkers = this.taxiMarkers.filter(marker => {
          const driverData = marker.driverData;
          return driverData && driverData.id === selectedDriver.id;
      });
  }

  // Построение маршрута от таксиста к клиенту
  buildTaxiToClientRoute(driver) {
      // Удаляем предыдущий маршрут если есть
      if (this.taxiRouteControl) {
          this.map.removeControl(this.taxiRouteControl);
      }

      const driverLatLng = L.latLng(driver.location);
      const clientLatLng = this.fromMarker.getLatLng();

      // Создаем специальный маркер для выбранного таксиста
      if (this.selectedTaxiMarker) {
          this.map.removeLayer(this.selectedTaxiMarker);
      }
      


      // Строим маршрут
      this.taxiRouteControl = L.Routing.control({
          waypoints: [driverLatLng, clientLatLng],
          router: L.Routing.osrmv1({ serviceUrl: APP_CONFIG.routing.serviceUrl }),
          routeWhileDragging: false,
          createMarker: () => null, // Не создаем маркеры
          lineOptions: {
              styles: [{color: 'var(--primary)', weight: 4, opacity: 1, zIndex: 99999}]
          },
          addWaypoints: false,
          showAlternatives: false
      }).addTo(this.map);

      // Центрируем карту на маршруте
      const bounds = L.latLngBounds([driverLatLng, clientLatLng]);
      this.map.fitBounds(bounds, { padding: [50, 50] });
  }

  // Обновление UI после подтверждения
  updateUIAfterConfirmation(driver) {
      // Показываем информацию о принятом заказе
      // this.showOrderAcceptedInfo(driver);

      document.querySelector('.order-panel').style.display = 'none';
      document.querySelector('.order-info').style.display = 'block';

      // Можно добавить дополнительные действия
      console.log('Заказ подтвержден с водителем:', driver.name);
  }


  // Обновление отображения таймера
  updateTimer() {
      const timerElement = document.getElementById('taxi-searching-timer');
      if (!timerElement) return;
      
      const elapsedSeconds = Math.floor((Date.now() - this.searchStartTime) / 1000);
      const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = elapsedSeconds % 60;
      
      timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // Остановка секундомера
  stopSearchTimer() {
      if (this.searchTimer) {
          clearInterval(this.searchTimer);
          this.searchTimer = null;
      }
  }

  // Сброс секундомера
  resetSearchTimer() {
      this.stopSearchTimer();
      const timerElement = document.getElementById('taxi-searching-timer');
      if (timerElement) {
          timerElement.textContent = '0:00';
      }
  }

  // Получение времени в секундах
  getSearchTime() {
      if (!this.searchStartTime) return 0;
      return Math.floor((Date.now() - this.searchStartTime) / 1000);
  }

  // Вместо этого добавить метод для проверки статуса WebSocket:
  checkWebSocketStatus() {
      if (window.taxiServices && window.taxiServices.wsService) {
          const status = window.taxiServices.wsService.isConnected ? 
              'connected' : 'disconnected';
          console.log('WebSocket status:', status);
          return status;
      }
      return 'not_available';
  }
}

// Инициализация приложения после загрузки DOM
document.addEventListener('DOMContentLoaded', async () => {
    const lsStatus = localStorage.getItem("taxiNotificationStatus");
    if (lsStatus && lsStatus !== "available" && lsStatus !== "offline") {
        localStorage.removeItem("taxiNotificationStatus");
    }
    const custom_icon = localStorage.getItem("taxiNotificationStatus") === "available" ? APP_CONFIG.icons.taxi : APP_CONFIG.icons.markerA;
    window.customIcon = L.icon(custom_icon);

    const waitForAppControllers = () =>
        new Promise(resolve => {
            const interval = setInterval(() => {
                if (window.appControllers?.toggleBottomNav) {
                    clearInterval(interval);
                    resolve();
                }
            }, 50);
        });

    await waitForAppControllers();

    if (localStorage.getItem("taxiNotificationStatus") === "available") {
        await window.appControllers.toggleBottomNav('taxi');
    }
    if ((localStorage.getItem("userType") || "") === "driver") {
        await window.taxiApp.refreshDriverNotificationFromServer();
    } else {
        const v = localStorage.getItem("taxiNotificationStatus");
        if (v === "available" || v === "offline") {
            window.taxiApp.updateTaxiStatusUI(v);
        }
    }

    // Обработка кликов вне модального окна для его закрытия
    // window.addEventListener('click', function(event) {
    //   if (event.target === document.getElementById('order-modal')) {
    //     window.taxiApp.closeMainModal();
    //   }
    // });

    window.taxiApp.showBusyTripLoading(true);
    try {
      if (window.taxiServices?.restoreActiveOrderIfAny) {
        await window.taxiServices.restoreActiveOrderIfAny();
      }
    } catch (e) {
      console.warn('[map] restore active trip', e);
    }
    window.taxiApp.showBusyTripLoading(false);

    // Предотвращение масштабирования на iOS при двойном тапе
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (event) {
        const now = (new Date()).getTime();
        if (now - lastTouchEnd <= 300) {
        event.preventDefault();
        }
        lastTouchEnd = now;
    }, false);

  
});



window.taxiApp = new TaxiApp(APP_CONFIG);
window.radars = new Radars(APP_CONFIG);