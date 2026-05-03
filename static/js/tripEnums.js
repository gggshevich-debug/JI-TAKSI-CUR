/**
 * Единые имена фаз поездки (trips.state), согласованы с backend tools/trip_enums.py.
 * Подключать перед map.js / controllers.js.
 */
(function (global) {
    const LEGACY = {
        waiting: 'driver_arrived',
        progress: 'in_progress',
        arrived: 'at_destination',
        done: 'finished',
    };

    global.normalizeTripLegState = function (s) {
        if (s == null || s === '') return s;
        const v = String(s);
        return LEGACY[v] || v;
    };

    global.TripLegState = {
        PENDING_CONFIRM: 'pending_confirm',
        EN_ROUTE: 'en_route',
        DRIVER_ARRIVED: 'driver_arrived',
        ONBOARD: 'onboard',
        IN_PROGRESS: 'in_progress',
        PAUSED: 'paused',
        AT_DESTINATION: 'at_destination',
        FINISHED: 'finished',
        CANCEL_CLIENT: 'cancel_client',
        CANCEL_DRIVER: 'cancel_driver',
    };
})(typeof window !== 'undefined' ? window : globalThis);
