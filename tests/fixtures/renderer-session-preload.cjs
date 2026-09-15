// Test data only. This preload has no device, network, or IPC command handlers.
const { contextBridge } = require('electron');
const listeners = new Set();
const calls = [];
let plannedRoute;
let state = {
  devices: [{
    id: 'ios:renderer-fixture',
    serial: 'renderer-fixture',
    platform: 'ios',
    name: 'Renderer fixture (no phone)',
    osVersion: '18.0',
    connection: 'usb',
    state: 'ready',
  }],
  runtime: { ios: { available: true }, android: { available: true } },
  savedPlaces: [],
  recentPlaces: [],
  preferences: { restoreOnQuit: true, onboardingComplete: true, hostPlatform: 'mac', phonePlatform: 'ios' },
  busy: false,
  session: {
    id: 'renderer-session',
    deviceId: 'ios:renderer-fixture',
    platform: 'ios',
    latitude: 41.8827,
    longitude: -87.6233,
    label: 'Initial fixture target',
    status: 'active',
    message: 'Fixture command acknowledged; no phone is connected.',
    autoReconnect: true,
    lastRefreshAt: new Date().toISOString(),
    refreshCount: 1,
    refreshSource: 'command-ack',
  },
};

const snapshot = () => JSON.parse(JSON.stringify(state));
function publish() {
  for (const listener of listeners) listener(snapshot());
  return snapshot();
}
const unexpected = method => async () => {
  calls.push({ method });
  throw new Error(`Unexpected fixture call: ${method}`);
};

contextBridge.exposeInMainWorld('ghost', {
  getState: async () => snapshot(),
  setConnection: async connection => { calls.push({method: 'setConnection', connection}); state.preferences.connection = connection; return publish(); },
  switchToWifi: async deviceId => { calls.push({method: 'switchToWifi', deviceId}); state.preferences.connection = 'wifi'; state.devices = state.devices.map(d => ({...d, connection: 'wifi'})); if (state.session) state.session.connection = 'wifi'; return publish(); },
  connectWifi: async value => { calls.push({method: 'connectWifi', ...value}); return publish(); },
  getRoute: async () => plannedRoute || null,
  planRoute: async input => {
    const mode = Array.isArray(input) ? 'road' : input.mode;
    const stops = Array.isArray(input) ? input : input.waypoints;
    calls.push({method: 'planRoute', mode, stops});
    plannedRoute = {
      id: 'test-route', mode, waypoints: stops,
      coordinates: [[-87.6233, 41.8827], [-87.6233, 41.89], [-87.63, 41.89]],
      distanceMeters: 1400,
      ...(mode === 'train'
        ? {durationSeconds: 34.79, speedMps: 40.24, speedMph: 90, provider: 'Transitous', operator: 'Amtrak', service: 'Northeast Regional'}
        : {durationSeconds: 69.59, speedMps: 20.1168, speedMph: 45, provider: 'OSRM'}),
    };
    return plannedRoute;
  },
  startRoute: async value => {
    calls.push({method: 'startRoute', ...value});
    state.route = {id: plannedRoute.id, mode: plannedRoute.mode, speedMps: plannedRoute.speedMps, speedMph: plannedRoute.speedMph, status: 'running', distanceMeters: 1400, traveledMeters: 0, remainingSeconds: 69.59, point: {latitude: 41.8827, longitude: -87.6233}, message: 'Following the road at 45 mph.'};
    state.session = {...state.session, status: 'active'};
    return publish();
  },
  pauseRoute: async () => { calls.push({method: 'pauseRoute'}); state.route.status = 'paused'; return publish(); },
  resumeRoute: async () => { calls.push({method: 'resumeRoute'}); state.route.status = 'running'; return publish(); },
  onState: listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  applyLocation: async point => {
    calls.push({ method: 'applyLocation', ...point });
    state.session = {
      ...state.session,
      ...point,
      status: 'active',
      autoReconnect: true,
      lastRefreshAt: new Date().toISOString(),
      refreshCount: 1,
    };
    return publish();
  },
  scanDevices: unexpected('scanDevices'),
  prepareDevice: unexpected('prepareDevice'),
  stopLocation: unexpected('stopLocation'),
  searchPlaces: unexpected('searchPlaces'),
  savePlace: unexpected('savePlace'),
  deletePlace: unexpected('deletePlace'),
  updatePreferences: unexpected('updatePreferences'),
  installRuntime: unexpected('installRuntime'),
});

contextBridge.exposeInMainWorld('ghostFixture', {
  setState: async patch => {
    state = { ...state, ...patch };
    return publish();
  },
  getCalls: async () => JSON.parse(JSON.stringify(calls)),
});
