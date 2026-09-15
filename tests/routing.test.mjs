import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, measurePath, pointAlong, distanceBetween, decodePolyline, ROUTE_SPEED_MPS } from '../backend/routing.mjs';
import { Controller } from '../backend/controller.mjs';
import { defaults } from '../backend/store.mjs';
import { CARY_STATION, stationMatches } from '../src/stations.js';

const close = (a, b, epsilon = 0.001) => assert.ok(Math.abs(a - b) < epsilon, `${a} differs from ${b}`);
const path = measurePath([[0, 0], [0.001, 0], [0.001, 0.001]]);
const plan = { id: 'road', coordinates: path.coordinates, distanceMeters: path.distanceMeters, durationSeconds: path.distanceMeters / ROUTE_SPEED_MPS, waypoints: [{latitude: 0, longitude: 0, label: 'Start'}, {latitude: 0.001, longitude: 0.001, label: 'End'}] };
const speedPlan = { ...plan, id: 'train-speed', mode: 'train', operator: 'Amtrak', service: 'Piedmont', speedMps: 10, speedMph: 10 * 3600 / 1609.344, maximumSpeedMph: 79, durationSeconds: plan.distanceMeters / 10 };

test('CYN and Cary aliases select the Amtrak station, not the city center', () => {
  for (const query of ['CYN', ' cary, NC ', 'Cary station']) assert.deepEqual(stationMatches(query), [CARY_STATION]);
  assert.deepEqual(stationMatches('Cary Illinois'), []);
  assert.equal(CARY_STATION.latitude, 35.788294);
  assert.equal(CARY_STATION.longitude, -78.782246);
});

test('only identified Amtrak Piedmont trips receive the corridor maximum preset', async () => {
  for (const [agencyName, displayName, maximum] of [['Amtrak', 'Piedmont 73', 79], ['Amtrak', 'Carolinian / Piedmont', null], ['Amtrak', 'Floridian', null], ['Other operator', 'Piedmont', null]]) {
    const router = new Router({fetcher: async () => new Response(JSON.stringify({itineraries: [{legs: [{mode: 'RAIL', agencyName, displayName, duration: 600, legGeometry: {points: '??gEgE', precision: 5, length: 2}}]}]}))});
    assert.equal((await router.plan({mode: 'train', waypoints: plan.waypoints})).maximumSpeedMph, maximum);
  }
});

test('train speed can be set before start without phone commands, changed live, and reset to average', async t => {
  const f = await fixture(t, 'ios', 'usb', speedPlan);
  const set = (mode, speedMph) => f.c.setRouteSpeed({routeId: speedPlan.id, mode, speedMph});
  await set('custom', 60);
  assert.equal(f.calls.some(c => ['set', 'update'].includes(c[0])), false);
  await f.start(); f.advance(1000); await f.c.tickRoute();
  close(f.c.state.route.traveledMeters, 26.8224);
  await set('maximum');
  assert.equal(f.c.state.route.speedMph, 79);
  f.advance(1000); await f.c.tickRoute();
  close(f.c.state.route.traveledMeters, 26.8224 + 35.31616);
  await f.c.pauseRoute(); await set('schedule');
  close(f.c.state.route.speedMps, 10);
  assert.equal(f.c.state.route.status, 'paused');
  close(f.c.state.route.remainingSeconds, (plan.distanceMeters - f.c.state.route.traveledMeters) / 10);
});

test('invalid speeds, unknown maxima and stale route ids cannot change playback', async t => {
  const f = await fixture(t, 'ios', 'usb', {...speedPlan, maximumSpeedMph: null});
  for (const speedMph of [0, -1, NaN, Infinity, '60', 501]) await assert.rejects(f.c.setRouteSpeed({routeId: speedPlan.id, mode: 'custom', speedMph}));
  await assert.rejects(f.c.setRouteSpeed({routeId: speedPlan.id, mode: 'maximum'}), /No verified maximum/);
  await assert.rejects(f.c.setRouteSpeed({routeId: 'stale', mode: 'custom', speedMph: 60}));
  assert.equal(f.c.getRoute().speedMps, 10);
  assert.equal(f.calls.some(c => ['set', 'update'].includes(c[0])), false);
});

for (const paused of [false, true]) test(`forward jump follows corners and preserves ${paused ? 'paused' : 'running'} state`, async t => {
  const f = await fixture(t, 'ios', 'usb', speedPlan); await f.start();
  if (paused) await f.c.pauseRoute();
  const id = f.c.state.session.id;
  await f.c.seekRoute({routeId: speedPlan.id, seconds: 15});
  close(f.c.state.route.traveledMeters, 150);
  assert.deepEqual(f.c.state.route.point, pointAlong(path, 150));
  assert.equal(f.c.state.route.status, paused ? 'paused' : 'running');
  const updates = f.calls.filter(c => c[0] === 'update');
  assert.equal(updates.length, 1); assert.equal(updates[0][1], f.phone.id); assert.equal(updates[0][2].sessionId, id);
  assert.equal(f.data.session.latitude, f.c.state.route.point.latitude, 'Jump is journaled for recovery');
});

for (const platform of ['ios', 'android']) for (const input of [{toEnd: true}, {seconds: 86400}]) test(`${platform} skip or oversized forward distance holds exact endpoint`, async t => {
  const f = await fixture(t, platform); await f.start();
  await f.c.seekRoute({routeId: plan.id, ...input});
  assert.deepEqual(f.c.state.route.point, {latitude: 0.001, longitude: 0.001});
  assert.equal(f.c.state.route.status, 'completed'); assert.equal(f.c.state.route.remainingSeconds, 0);
  assert.equal(f.c.routeTimer, null); assert.equal(f.c.state.session.status, 'active');
  f.advance(1000); await f.c.tickRoute();
  assert.equal(f.calls.filter(c => c[0] === 'update').length, 1);
  await f.c.stopLocation(); assert.equal(f.c.state.session, null);
});

test('seek rejects malformed requests, stale routes, and disconnected phones without updates', async t => {
  const f = await fixture(t); await f.start();
  for (const input of [{seconds: 0}, {seconds: -1}, {seconds: Infinity}, {seconds: '5'}, {seconds: 86401}, {toEnd: true, seconds: 1}, {toEnd: false}, {}]) await assert.rejects(f.c.seekRoute({routeId: plan.id, ...input}));
  await assert.rejects(f.c.seekRoute({routeId: 'old', toEnd: true}));
  await f.c.sessionEnded({deviceId: f.phone.id, error: 'Disconnected'});
  await assert.rejects(f.c.seekRoute({routeId: plan.id, toEnd: true}), /Reconnect/);
  assert.equal(f.calls.filter(c => c[0] === 'update').length, 0);
});

test('seek waits for an in-flight tick, and cannot race a restore command', async t => {
  const f = await fixture(t); await f.start();
  let release;
  f.adapter.update = async () => new Promise(resolve => { release = resolve; });
  f.advance(1000); const tick = f.c.tickRoute();
  const seek = f.c.seekRoute({routeId: plan.id, toEnd: true});
  await assert.rejects(f.c.stopLocation(), /Wait/);
  f.adapter.update = async (_device, point) => { f.calls.push(['jump', point]); return {}; };
  release({}); await tick; await seek;
  assert.equal(f.calls.filter(c => c[0] === 'jump').length, 1);
  assert.equal(f.c.state.route.status, 'completed');
  await f.c.stopLocation(); assert.equal(f.c.state.route, null);
});

test('failed jump retains attempted point for recovery and never claims arrival', async t => {
  const f = await fixture(t); await f.start();
  f.adapter.update = async () => { throw new Error('Acknowledgement lost'); };
  await assert.rejects(f.c.seekRoute({routeId: plan.id, toEnd: true}), /Acknowledgement lost/);
  assert.equal(f.c.state.route.status, 'paused');
  assert.notEqual(f.c.state.session.status, 'active');
  assert.equal(f.data.session.latitude, 0.001);
  assert.equal(f.data.session.longitude, 0.001);
  assert.equal(f.c.routeTimer, null);
});

test('45 mph advances 20.1168 metres each second along segments, including corners', () => {
  close(ROUTE_SPEED_MPS, 20.1168, 1e-12);
  const before = pointAlong(path, ROUTE_SPEED_MPS * 5);
  assert.equal(before.latitude, 0);
  close(distanceBetween([0, 0], [before.longitude, before.latitude]), 100.584);
  const after = pointAlong(path, ROUTE_SPEED_MPS * 6);
  close(after.longitude, 0.001, 1e-9);
  close(path.cumulative[1] + distanceBetween([0.001, 0], [after.longitude, after.latitude]), 120.7008);
  assert.deepEqual(pointAlong(path, 10000), {latitude: 0.001, longitude: 0.001});
});
test('duplicate points, start clamp, and dateline crossing do not create jumps', () => {
  const repeated = measurePath([[0, 0], [0, 0], [0.001, 0]]);
  assert.deepEqual(pointAlong(repeated, -100), {latitude: 0, longitude: 0});
  close(pointAlong(repeated, repeated.distanceMeters / 2).longitude, 0.0005, 1e-9);
  const dateline = measurePath([[179.999, 0], [-179.999, 0]]);
  close(Math.abs(pointAlong(dateline, dateline.distanceMeters / 2).longitude), 180, 1e-9);
  assert.throws(() => measurePath([[0, 0], [0, 0]]), /different/);
  for (const coordinates of [[], [[0, 0], [181, 0]], [[0, 0], [0, NaN]], [[0, 0], ['1', 0]]]) assert.throws(() => measurePath(coordinates));
});
test('OSRM requests ordered driving stops and full geometry only on explicit planning', async () => {
  const calls = [];
  const router = new Router({now: () => 1000, fetcher: async (...args) => { calls.push(args); return new Response(JSON.stringify({code: 'Ok', routes: [{geometry: {type: 'LineString', coordinates: path.coordinates}}]})); }});
  const result = await router.plan(plan.waypoints);
  const url = new URL(calls[0][0]);
  assert.match(url.pathname, /driving\/0,0;0.001,0.001/);
  assert.equal(url.searchParams.get('overview'), 'full');
  assert.equal(url.searchParams.get('geometries'), 'geojson');
  assert.equal(result.distanceMeters, path.distanceMeters);
  close(result.durationSeconds, path.distanceMeters / ROUTE_SPEED_MPS);
  await assert.rejects(router.plan(plan.waypoints), /Wait a second/);
  assert.equal(calls.length, 1);
});
test('no-route, HTTP, malformed response and invalid stops fail without a straight-line fallback', async () => {
  for (const response of [new Response('', {status: 503}), new Response('{'), new Response(JSON.stringify({code: 'NoRoute'})), new Response(JSON.stringify({code: 'Ok', routes: [{geometry: {type: 'LineString', coordinates: [[0, 0], [0, 91]]}}]}))]) {
    await assert.rejects(new Router({fetcher: async () => response}).plan(plan.waypoints));
  }
  const router = new Router({fetcher: () => assert.fail('Invalid stops reached the network')});
  for (const stops of [null, [], [plan.waypoints[0]], Array(13).fill(plan.waypoints[0]), [{latitude: 91, longitude: 0}, plan.waypoints[1]]]) await assert.rejects(router.plan(stops));
});

test('Transitous train planning decodes rail geometry and uses scheduled duration', async () => {
  assert.deepEqual(decodePolyline('??gEgE', 5), [[0, 0], [0.001, 0.001]]);
  const calls = [];
  const response = {
    itineraries: [{
      legs: [{
        mode: 'REGIONAL_RAIL',
        duration: 600,
        displayName: 'Northeast Regional',
        agencyName: 'Amtrak',
        scheduledStartTime: '2026-09-14T12:00:00Z',
        scheduledEndTime: '2026-09-14T12:10:00Z',
        realTime: true,
        cancelled: false,
        legGeometry: {points: '??gEgE', precision: 5, length: 2},
      }],
    }],
  };
  const router = new Router({now: () => 1000, fetcher: async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify(response));
  }});
  const result = await router.plan({mode: 'train', waypoints: [
    {latitude: 0, longitude: 0, label: 'Station A'},
    {latitude: 0.001, longitude: 0.001, label: 'Station B'},
  ]});
  const url = new URL(calls[0][0]);
  assert.equal(url.hostname, 'api.transitous.org');
  assert.equal(url.searchParams.get('transitModes'), 'RAIL');
  assert.equal(url.searchParams.get('maxTransfers'), '0');
  assert.equal(result.mode, 'train');
  assert.equal(result.provider, 'Transitous');
  assert.equal(result.service, 'Northeast Regional');
  assert.equal(result.operator, 'Amtrak');
  assert.equal(result.durationSeconds, 600);
  assert.deepEqual(result.coordinates, [[0, 0], [0.001, 0.001]]);
  close(result.speedMps, result.distanceMeters / 600);
  assert.match(calls[0][1].headers['User-Agent'], /aleenabenny0\/ghost-location/);
});

test('train planning rejects extra stops, missing trips, and malformed geometry', async () => {
  const points = [{latitude: 0, longitude: 0}, {latitude: 1, longitude: 1}];
  const never = new Router({fetcher: () => assert.fail('Invalid train request reached the network')});
  await assert.rejects(never.plan({mode: 'train', waypoints: [...points, points[0]]}), /exactly one start/);
  const noTrip = new Router({fetcher: async () => new Response(JSON.stringify({itineraries: []}))});
  await assert.rejects(noTrip.plan({mode: 'train', waypoints: points}), /No direct train trip/);
  const transfer = new Router({fetcher: async () => new Response(JSON.stringify({itineraries: [{legs: [
    {mode: 'RAIL', duration: 60}, {mode: 'RAIL', duration: 60},
  ]}]}))});
  await assert.rejects(transfer.plan({mode: 'train', waypoints: points}), /No direct train trip/);
  const malformed = new Router({fetcher: async () => new Response(JSON.stringify({itineraries: [{legs: [{
    mode: 'RAIL', duration: 60, legGeometry: {points: '!', precision: 6, length: 1},
  }]}]}))});
  await assert.rejects(malformed.plan({mode: 'train', waypoints: points}), /geometry/);
});

async function fixture(t, platform = 'ios', connection = 'usb', routePlan = plan) {
  const phone = { id: `${platform}:USB123`, serial: 'USB123', platform, name: 'Test phone', connection, state: 'ready' };
  let timestamp = 0, devices = [phone];
  const calls = [], data = defaults(); data.preferences.connection = connection;
  const store = {load: async () => structuredClone(data), save: async value => { calls.push(['persist']); Object.assign(data, structuredClone(value)); }};
  const adapter = {status: async () => ({available: true}), list: async () => devices,
    set: async (device, point) => { calls.push(['set', device.id, {...point}]); return {}; },
    update: async (device, point) => { calls.push(['update', device.id, {...point}]); return {}; },
    clear: async () => calls.push(['clear']), reset: async () => calls.push(['reset']), dispose: async () => {}};
  const c = new Controller({adapters: {[platform]: adapter}, store, router: {plan: async () => structuredClone(routePlan)}, clock: () => timestamp, now: () => Date.parse('2026-09-13T12:00:00Z') + timestamp});
  await c.init(); await c.planRoute(routePlan.waypoints);
  t.after(() => c.dispose({restore: false}));
  const start = () => c.startRoute({deviceId: phone.id, routeId: routePlan.id});
  return {c, phone, adapter, calls, data, start, advance: ms => { timestamp += ms; }, disconnect: () => {devices = [];}, reconnect: () => {devices = [phone];}, replace: () => {devices = [{...phone, id: `${platform}:SECOND`, serial: 'SECOND'}];}};
}

test('controller advances train routes using the plan speed instead of road speed', async t => {
  const trainPlan = {...plan, id: 'train', mode: 'train', operator: 'Amtrak', service: 'Test Rail', speedMps: 10, speedMph: 22.3694, durationSeconds: plan.distanceMeters / 10};
  const f = await fixture(t, 'ios', 'usb', trainPlan);
  await f.start();
  f.calls.length = 0;
  f.advance(1000);
  await f.c.tickRoute();
  const update = f.calls.find(call => call[0] === 'update');
  close(distanceBetween([0, 0], [update[2].longitude, update[2].latitude]), 10);
  assert.equal(f.c.state.route.mode, 'train');
  assert.equal(f.c.state.route.operator, 'Amtrak');
  assert.equal(f.c.state.route.service, 'Test Rail');
  assert.match(f.c.state.route.message, /Amtrak.*Test Rail/);
});

for (const connection of ['usb', 'wifi']) for (const platform of ['ios', 'android']) test(`${platform} ${connection} route sends one point per second, preserves session, and holds exact endpoint`, async t => {
  const f = await fixture(t, platform, connection); await f.start();
  const id = f.c.state.session.id; f.calls.length = 0;
  for (let second = 1; second <= 12; second++) { f.advance(1000); await f.c.tickRoute(); }
  assert.equal(f.c.state.route.status, 'completed');
  const updates = f.calls.filter(c => c[0] === 'update');
  assert.equal(updates.length, 12);
  assert.ok(updates.every(c => c[1] === f.phone.id && c[2].sessionId === id));
  close(distanceBetween([0, 0], [updates[0][2].longitude, updates[0][2].latitude]), ROUTE_SPEED_MPS);
  assert.equal(f.c.state.session.latitude, 0.001); assert.equal(f.c.state.session.longitude, 0.001);
  assert.equal(f.c.state.busy, false); assert.equal(f.c.state.session.status, 'active');
  assert.equal(f.calls.filter(c => c[0] === 'persist').length, 1, 'Only arrival journals, not every tick');
  await f.c.tickRoute(); assert.equal(f.calls.filter(c => c[0] === 'update').length, 12);
  await f.c.stopLocation(); assert.equal(f.c.state.route, null); assert.equal(f.c.state.session, null);
});
test('backend timer sends updates independently of renderer events', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t); await f.start();
  for (let i = 0; i < 6; i++) { f.advance(1000); t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.calls.filter(c => c[0] === 'update').length, 6);
});
test('pause holds location and resume excludes paused time from speed', async t => {
  const f = await fixture(t); await f.start();
  f.advance(1000); await f.c.tickRoute();
  await f.c.pauseRoute(); const point = {...f.c.state.route.point};
  f.advance(60000); await f.c.tickRoute(); assert.deepEqual(f.c.state.route.point, point);
  await f.c.resumeRoute(); f.advance(1000); await f.c.tickRoute();
  close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS * 2);
});
test('disconnect and sleep pause progress; reconnect holds the last point until explicit resume', async t => {
  const f = await fixture(t); await f.start(); f.advance(1000); await f.c.tickRoute();
  await f.c.sessionEnded({deviceId: f.phone.id, error: 'Cable removed'});
  f.disconnect(); f.advance(30000); await f.c.scanDevices(); await f.c.tickRoute();
  assert.equal(f.c.state.route.status, 'paused'); close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS);
  f.reconnect(); await f.c.scanDevices();
  assert.equal(f.c.state.session.status, 'active'); assert.equal(f.c.state.route.status, 'paused');
  await f.c.resumeRoute(); f.advance(1000); await f.c.tickRoute(); close(f.c.state.route.traveledMeters, 2 * ROUTE_SPEED_MPS);
  await f.c.suspend(); f.advance(30000); await f.c.resume();
  assert.equal(f.c.state.route.status, 'paused'); close(f.c.state.route.traveledMeters, 2 * ROUTE_SPEED_MPS);
});
test('failed initial route can resume through manual reconnect, without getting stuck', async t => {
  const f = await fixture(t); const set = f.adapter.set;
  f.adapter.set = async () => {throw new Error('USB lost');};
  await assert.rejects(f.start()); assert.equal(f.c.state.route.status, 'paused');
  f.adapter.set = set; await f.c.resumeRoute(); assert.equal(f.c.state.route.status, 'running');
});
test('slow transport and long scheduling stalls pause instead of queueing or jumping', async t => {
  const f = await fixture(t); await f.start();
  let finish; f.adapter.update = () => new Promise(resolve => {finish = resolve;});
  f.advance(1000); const tick = f.c.tickRoute();
  await f.c.tickRoute(); // No concurrent write.
  f.advance(1500); finish({}); await tick;
  assert.equal(f.c.state.route.status, 'paused'); close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS);
  await f.c.resumeRoute(); f.advance(60000); await f.c.tickRoute();
  assert.equal(f.c.state.route.status, 'paused'); close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS);
});
test('Restore waits for an in-flight update, then clears without a late restart', async t => {
  const f = await fixture(t); await f.start(); let finish;
  f.adapter.update = () => new Promise(resolve => {finish = resolve;});
  f.advance(1000); const tick = f.c.tickRoute(); const stop = f.c.stopLocation();
  assert.ok(!f.calls.some(c => c[0] === 'clear')); finish({});
  await Promise.all([tick, stop]);
  assert.equal(f.c.state.session, null); assert.equal(f.c.state.route, null); assert.equal(f.c.routeTimer, null);
});
test('failed update or late acknowledgement cannot hide transport loss, and a new phone never receives the route', async t => {
  const f = await fixture(t); await f.start();
  f.adapter.update = async () => {await f.c.sessionEnded({deviceId: f.phone.id, error: 'Lost USB'}); return {};};
  f.advance(1000); await f.c.tickRoute();
  assert.equal(f.c.state.session.status, 'waiting'); assert.equal(f.c.state.route.status, 'paused');
  f.replace(); await f.c.scanDevices();
  assert.equal(f.c.state.route, null); assert.equal(f.c.state.session, null);
  assert.equal(f.calls.filter(c => c[0] === 'set').length, 1);
});
test('unplanned routes and changed endpoints cannot bypass route planning', async t => {
  const f = await fixture(t);
  await assert.rejects(f.c.startRoute({deviceId: f.phone.id, routeId: 'other'}), /Plan the route/);
  await f.start(); await assert.rejects(f.c.planRoute(plan.waypoints), /restore real location/);
  await assert.rejects(f.start(), /Restore real location/);
});
