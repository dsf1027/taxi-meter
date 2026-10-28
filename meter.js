// Taxi-fare engine. Pure functions: no DOM, no Geolocation, so it can be unit-tested.
//
// Model (a simulator, not a certified meter):
//  - the base fare covers the first `baseDistance` metres (waiting is free until they are used up);
//  - then one `unitFare` is added for every `unitDistance` metres driven;
//  - below the speed `unitDistance / unitTime` the meter counts time instead of distance
//    (one unit per `unitTime` seconds), the usual "time-distance combined" scheme;
//  - night surcharge bands multiply every amount at the moment it is incurred;
//  - the out-of-city surcharge is a percentage of the whole fare, switched on/off by hand;
//  - the shown fare is rounded to the nearest `roundTo` won; tolls and call fee are added as is.

export const SEOUL_DEFAULTS = Object.freeze({
  baseFare: 4800,
  baseDistance: 1600, // m
  unitFare: 100,
  unitDistance: 131, // m per unit
  unitTime: 30, // s per unit (sources disagree: 30 vs 31 s - see README)
  night: [
    { from: "22:00", to: "23:00", pct: 20 },
    { from: "23:00", to: "02:00", pct: 40 },
    { from: "02:00", to: "04:00", pct: 20 },
  ],
  outsidePct: 20,
  roundTo: 100,
});

const EPS = 1e-6;
const num = (v, fallback, min = 0) => (Number.isFinite(+v) && +v >= min ? +v : fallback);

export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return NaN;
  const h = +m[1], mi = +m[2];
  return h > 24 || mi > 59 ? NaN : h * 60 + mi;
}

// Accepts anything (e.g. parsed localStorage JSON) and returns a complete, valid config.
export function sanitizeConfig(raw) {
  const d = SEOUL_DEFAULTS;
  const r = raw && typeof raw === "object" ? raw : {};
  const night = Array.isArray(r.night)
    ? r.night
        .map((b) => ({ from: String(b && b.from), to: String(b && b.to), pct: num(b && b.pct, NaN, 0) }))
        .filter((b) => Number.isFinite(minutesOf(b.from)) && Number.isFinite(minutesOf(b.to)) && Number.isFinite(b.pct) && b.from !== b.to)
    : d.night.map((b) => ({ ...b }));
  return {
    baseFare: num(r.baseFare, d.baseFare),
    baseDistance: num(r.baseDistance, d.baseDistance),
    unitFare: num(r.unitFare, d.unitFare, 1),
    unitDistance: num(r.unitDistance, d.unitDistance, 1),
    unitTime: num(r.unitTime, d.unitTime, 1),
    night,
    outsidePct: num(r.outsidePct, d.outsidePct),
    roundTo: num(r.roundTo, d.roundTo, 1),
  };
}

// Surcharge percentage that applies at `date` (local time). Bands may wrap past midnight.
export function nightPct(cfg, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  let best = 0;
  for (const b of cfg.night) {
    const a = minutesOf(b.from), z = minutesOf(b.to);
    const inside = a < z ? now >= a && now < z : now >= a || now < z;
    if (inside) best = Math.max(best, b.pct);
  }
  return best;
}

// Speed (m/s) below which time is counted instead of distance.
export const thresholdMps = (cfg) => cfg.unitDistance / cfg.unitTime;

export function startTrip(cfg, now, outside = false) {
  const pct = nightPct(cfg, now);
  return {
    cfg,
    startedMs: now.getTime(),
    elapsed: 0, // s
    distance: 0, // m driven (real distance, for display)
    speed: 0, // m/s, last value used to pick the counting mode
    mode: "base", // "base" | "distance" | "time"
    baseLeft: cfg.baseDistance, // equivalent metres of base distance still to consume
    accum: 0, // equivalent metres since the last unit was added
    units: 0,
    fareBase: cfg.baseFare, // fare without any surcharge
    fareRun: 0,
    fareNight: cfg.baseFare * (1 + pct / 100), // night-adjusted, without the out-of-city part
    outside,
    tolls: 0,
    callFee: 0,
  };
}

// Advance the meter by `dt` seconds in which the car moved `dd` metres.
// `speed` (m/s) decides distance- vs time-counting; it defaults to dd/dt.
export function advance(t, dt, dd, now, speed = dd / dt) {
  if (!(dt > 0)) return t;
  const thr = thresholdMps(t.cfg);
  const fast = speed >= thr;
  t.elapsed += dt;
  t.distance += Math.max(0, dd);
  t.speed = speed;
  t.mode = fast ? "distance" : "time";
  // "Equivalent metres" to charge this step: real distance when fast, time converted at the
  // threshold speed when slow. The base distance is only used up by real distance driven, so
  // waiting at the start is free until the car has moved `baseDistance`.
  let eq;
  if (t.baseLeft > EPS) {
    const use = Math.min(t.baseLeft, Math.max(0, dd));
    t.baseLeft -= use;
    if (t.baseLeft > EPS) {
      t.mode = "base";
      eq = 0;
    } else {
      t.baseLeft = 0;
      eq = fast ? Math.max(0, dd) - use : thr * dt;
    }
  } else {
    eq = fast ? Math.max(0, dd) : thr * dt;
  }
  if (eq > 0) {
    t.accum += eq;
    const n = Math.floor((t.accum + EPS) / t.cfg.unitDistance);
    if (n > 0) {
      t.accum = Math.max(0, t.accum - n * t.cfg.unitDistance);
      const add = n * t.cfg.unitFare;
      t.fareRun += add;
      t.fareNight += add * (1 + nightPct(t.cfg, now) / 100);
      t.units += n;
    }
  }
  return t;
}

const roundTo = (v, step) => Math.round(v / step + EPS) * step;

export function breakdown(t) {
  const raw = t.fareNight + (t.outside ? ((t.fareBase + t.fareRun) * t.cfg.outsidePct) / 100 : 0);
  const fare = roundTo(raw, t.cfg.roundTo);
  return {
    base: t.fareBase,
    running: t.fareRun,
    surcharge: fare - t.fareBase - t.fareRun,
    fare,
    tolls: t.tolls,
    callFee: t.callFee,
    total: fare + t.tolls + t.callFee,
  };
}
export const total = (t) => breakdown(t).total;

/* ---------- GPS fixes -> driven distance ---------- */

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Turns noisy position fixes into driven metres. Time is NOT handled here (the app ticks once a
// second), so a phone that stops reporting while stationary still gets billed for waiting.
export class FixTracker {
  constructor({ maxAccuracy = 50, maxSpeed = 70, minMoveFloor = 3 } = {}) {
    Object.assign(this, { maxAccuracy, maxSpeed, minMoveFloor });
    this.lastT = null;
    this.anchor = null;
  }
  reset() { this.lastT = null; this.anchor = null; }

  // fix: { t (ms), lat, lon, accuracy (m), speed (m/s | null) }  ->  metres to add (>= 0), or null if the fix was unusable
  ingest(f) {
    if (!(f.accuracy <= this.maxAccuracy)) return null; // also rejects NaN/undefined
    if (!this.anchor) {
      this.anchor = { lat: f.lat, lon: f.lon };
      this.lastT = f.t;
      return 0;
    }
    const dt = (f.t - this.lastT) / 1000;
    if (!(dt > 0)) return null;
    const d = haversine(this.anchor.lat, this.anchor.lon, f.lat, f.lon);
    if (d / dt > this.maxSpeed) return null; // teleport: keep the old anchor and wait for a sane fix

    let dd = 0;
    if (f.speed != null && f.speed >= 0 && dt <= 5) {
      // Doppler speed is far more reliable than position jitter, especially when stopped.
      dd = f.speed < 0.5 ? 0 : f.speed * dt;
      this.anchor = { lat: f.lat, lon: f.lon };
    } else {
      const minMove = Math.max(this.minMoveFloor, f.accuracy * 0.75);
      if (d >= minMove) {
        dd = d;
        this.anchor = { lat: f.lat, lon: f.lon };
      }
    }
    this.lastT = f.t;
    return dd;
  }
}

/* ---------- formatting ---------- */

export const won = (n) => Math.round(n).toLocaleString("ko-KR");
export function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
