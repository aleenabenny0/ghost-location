import { randomUUID } from 'node:crypto';
import { place } from './validation.mjs';

export const ROUTE_SPEED_MPS = 45 * 1609.344 / 3600;
export const TRAIN_MODES = new Set([
  'RAIL', 'HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL',
  'REGIONAL_RAIL', 'REGIONAL_FAST_RAIL', 'SUBURBAN', 'SUBWAY',
]);
const radians = degrees => degrees * Math.PI / 180;
const longitudeDelta = (from, to) => ((to - from + 540) % 360) - 180;

export function distanceBetween(a, b) {
  const dLat = radians(b[1] - a[1]), dLon = radians(longitudeDelta(a[0], b[0]));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function measurePath(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 100000) throw new Error('The routing service returned an invalid or excessively long path.');
  const cumulative = [0];
  coordinates.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new Error('Invalid route coordinates.');
    place({ longitude: p[0], latitude: p[1] });
    if (i) cumulative.push(cumulative[i - 1] + distanceBetween(coordinates[i - 1], p));
  });
  if (cumulative.at(-1) < 1) throw new Error('Choose two different locations at least a metre apart.');
  return { coordinates, cumulative, distanceMeters: cumulative.at(-1) };
}

export function pointAlong(path, distance) {
  const target = Math.min(path.distanceMeters, Math.max(0, distance));
  let lo = 1, hi = path.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (path.cumulative[mid] < target) lo = mid + 1; else hi = mid;
  }
  const a = path.coordinates[lo - 1], b = path.coordinates[lo];
  const length = path.cumulative[lo] - path.cumulative[lo - 1];
  const fraction = length ? (target - path.cumulative[lo - 1]) / length : 0;
  // Spherical interpolation stays on the segment, including across the dateline.
  const angle = distanceBetween(a, b) / 6371008.8;
  let latitude, longitude;
  if (angle < 1e-10) [longitude, latitude] = a;
  else {
    const x = Math.sin((1 - fraction) * angle) / Math.sin(angle), y = Math.sin(fraction * angle) / Math.sin(angle);
    const aLat = radians(a[1]), aLon = radians(a[0]), bLat = radians(b[1]), bLon = radians(b[0]);
    const vx = x * Math.cos(aLat) * Math.cos(aLon) + y * Math.cos(bLat) * Math.cos(bLon);
    const vy = x * Math.cos(aLat) * Math.sin(aLon) + y * Math.cos(bLat) * Math.sin(bLon);
    const vz = x * Math.sin(aLat) + y * Math.sin(bLat);
    latitude = Math.atan2(vz, Math.hypot(vx, vy)) * 180 / Math.PI;
    longitude = Math.atan2(vy, vx) * 180 / Math.PI;
  }
  if (target === path.distanceMeters) [longitude, latitude] = path.coordinates.at(-1);
  return { latitude, longitude };
}

export function decodePolyline(encoded, precision = 6) {
  if (typeof encoded !== 'string' || !encoded.length || !Number.isInteger(precision) || precision < 0 || precision > 10) {
    throw new Error('The transit service returned invalid train geometry.');
  }
  const coordinates = [];
  const factor = 10 ** precision;
  let index = 0, latitude = 0, longitude = 0;
  const readValue = () => {
    let result = 0, shift = 0, byte;
    do {
      if (index >= encoded.length || shift > 30) throw new Error('The transit service returned invalid train geometry.');
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error('The transit service returned invalid train geometry.');
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    latitude += readValue();
    longitude += readValue();
    coordinates.push([longitude / factor, latitude / factor]);
  }
  return coordinates;
}

function joinTrainGeometry(legs) {
  const coordinates = [];
  for (const leg of legs) {
    const geometry = leg?.legGeometry;
    const decoded = decodePolyline(geometry?.points, geometry?.precision);
    if (geometry.length != null && geometry.length !== decoded.length) throw new Error('The transit service returned incomplete train geometry.');
    if (coordinates.length && decoded.length) {
      const previous = coordinates.at(-1), next = decoded[0];
      if (previous[0] === next[0] && previous[1] === next[1]) decoded.shift();
    }
    coordinates.push(...decoded);
  }
  return coordinates;
}

export class Router {
  constructor({ fetcher = fetch, now = Date.now, transitUrl = 'https://api.transitous.org/api/v6/plan' } = {}) {
    this.fetcher = fetcher; this.now = now; this.transitUrl = transitUrl; this.lastRequest = -Infinity;
  }
  async request(url, failurePrefix) {
    let data;
    try {
      const response = await this.fetcher(url, {
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent': 'GhostLocationTrain/0.1.7 (https://github.com/aleenabenny0/ghost-location)',
          Accept: 'application/json',
        },
      });
      if (!response.ok) throw new Error(`Routing service returned HTTP ${response.status}.`);
      const body = await response.text();
      if (body.length > 8_000_000) throw new Error('Route is too large. Choose a shorter path.');
      data = JSON.parse(body);
    } catch (error) {
      throw new Error(`${failurePrefix} Check your internet connection and try again. ${error.message}`);
    }
    return data;
  }
  async plan(input) {
    const mode = Array.isArray(input) ? 'road' : input?.mode || 'road';
    const rawWaypoints = Array.isArray(input) ? input : input?.waypoints;
    if (!['road', 'train'].includes(mode)) throw new Error('Choose road or train routing.');
    const maximum = mode === 'train' ? 2 : 12;
    if (!Array.isArray(rawWaypoints) || rawWaypoints.length < 2 || rawWaypoints.length > maximum) {
      throw new Error(mode === 'train' ? 'Train routes need exactly one start and one destination.' : 'Add between 2 and 12 route stops.');
    }
    const waypoints = rawWaypoints.map(p => place(p));
    if (this.now() - this.lastRequest < 1000) throw new Error('Wait a second before planning another route.');
    this.lastRequest = this.now();
    return mode === 'train' ? this.planTrain(waypoints) : this.planRoad(waypoints);
  }
  async planRoad(waypoints) {
    const coordinates = waypoints.map(p => `${p.longitude},${p.latitude}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false&radiuses=${waypoints.map(() => 1000).join(';')}`;
    const data = await this.request(url, 'Could not plan the road route.');
    if (data.code !== 'Ok' || data.routes?.[0]?.geometry?.type !== 'LineString') throw new Error('No drivable route found. Move the pins closer to connected roads and try again.');
    const path = measurePath(data.routes[0].geometry.coordinates);
    return {
      id: randomUUID(), mode: 'road', provider: 'OSRM', waypoints,
      coordinates: path.coordinates, distanceMeters: path.distanceMeters,
      durationSeconds: path.distanceMeters / ROUTE_SPEED_MPS,
      speedMps: ROUTE_SPEED_MPS, speedMph: 45,
    };
  }
  async planTrain(waypoints) {
    const url = new URL(this.transitUrl);
    url.searchParams.set('fromPlace', `${waypoints[0].latitude},${waypoints[0].longitude}`);
    url.searchParams.set('toPlace', `${waypoints[1].latitude},${waypoints[1].longitude}`);
    url.searchParams.set('radius', '2000');
    url.searchParams.set('transitModes', 'RAIL');
    url.searchParams.set('directModes', '');
    url.searchParams.set('preTransitModes', '');
    url.searchParams.set('postTransitModes', '');
    url.searchParams.set('maxTransfers', '0');
    url.searchParams.set('detailedLegs', 'true');
    const data = await this.request(url, 'Could not plan the train route.');
    const candidates = Array.isArray(data.itineraries) ? data.itineraries : [];
    const itinerary = candidates.find(item => item?.legs?.some(leg => TRAIN_MODES.has(leg.mode) && !leg.cancelled));
    if (!itinerary) throw new Error('No direct train trip was found near those points. Choose pins within 2 km of stations on the same service.');
    const legs = itinerary.legs.filter(leg => TRAIN_MODES.has(leg.mode) && !leg.cancelled);
    const coordinates = joinTrainGeometry(legs);
    const path = measurePath(coordinates);
    const durationSeconds = legs.reduce((sum, leg) => sum + (Number.isFinite(leg.duration) ? leg.duration : 0), 0);
    if (durationSeconds < 1) throw new Error('The transit service returned invalid train timing.');
    const speedMps = path.distanceMeters / durationSeconds;
    const services = [...new Set(legs.map(leg => leg.displayName || leg.routeShortName || leg.routeLongName).filter(Boolean))];
    return {
      id: randomUUID(), mode: 'train', provider: 'Transitous', waypoints,
      coordinates: path.coordinates, distanceMeters: path.distanceMeters,
      durationSeconds, speedMps, speedMph: speedMps * 3600 / 1609.344,
      service: services.join(' → ') || 'Train',
      scheduledStartTime: legs[0]?.scheduledStartTime || legs[0]?.startTime || null,
      scheduledEndTime: legs.at(-1)?.scheduledEndTime || legs.at(-1)?.endTime || null,
      realTime: legs.some(leg => leg.realTime),
    };
  }
}
