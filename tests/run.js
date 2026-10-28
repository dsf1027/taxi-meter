// Run with: node tests/run.js
import assert from "node:assert";
import {
  SEOUL_DEFAULTS, sanitizeConfig, minutesOf, nightPct, thresholdMps, startTrip, advance, breakdown, total,
  haversine, FixTracker, won, clock,
} from "../meter.js";
import { demoSpeed, DEMO_PERIOD } from "../sim.js";
import { strideHz, pose, legPath, framePaths, frameAt, FRAMES, HIPS } from "../horse.js";

const cfg = sanitizeConfig(SEOUL_DEFAULTS);
const at = (h, m = 0) => new Date(2026, 9, 28, h, m, 0); // local time; the date does not matter

// deterministic noise
function rng(seed) { let a = seed >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

/* ---- config ---- */
{
  assert.deepStrictEqual(sanitizeConfig(undefined), sanitizeConfig(SEOUL_DEFAULTS));
  const c = sanitizeConfig({ baseFare: "5000", unitTime: -3, night: [{ from: "25:00", to: "01:00", pct: 20 }, { from: "20:00", to: "21:30", pct: "15" }] });
  assert.strictEqual(c.baseFare, 5000, "numeric strings are accepted");
  assert.strictEqual(c.unitTime, SEOUL_DEFAULTS.unitTime, "invalid value falls back to the default");
  assert.deepStrictEqual(c.night, [{ from: "20:00", to: "21:30", pct: 15 }], "invalid bands are dropped");
  assert.ok(Math.abs(thresholdMps(cfg) * 3.6 - 15.72) < 0.01, "131 m / 30 s is about 15.7 km/h");
  assert.strictEqual(minutesOf("07:05"), 425);
  assert.ok(Number.isNaN(minutesOf("7pm")));
}

/* ---- night bands (22-23: 20%, 23-02: 40%, 02-04: 20%) ---- */
{
  const cases = [[12, 0, 0], [21, 59, 0], [22, 0, 20], [22, 59, 20], [23, 0, 40], [23, 59, 40], [0, 30, 40], [1, 59, 40], [2, 0, 20], [3, 59, 20], [4, 0, 0]];
  for (const [h, m, want] of cases) assert.strictEqual(nightPct(cfg, at(h, m)), want, `${h}:${m}`);
}

/* ---- starting fare: the night base fares reported for Seoul are 5,800 (20%) and 6,700 (40%) ---- */
{
  assert.strictEqual(total(startTrip(cfg, at(14))), 4800);
  assert.strictEqual(total(startTrip(cfg, at(22, 30))), 5800, "4800 x 1.2 = 5760 -> 5800");
  assert.strictEqual(total(startTrip(cfg, at(23, 30))), 6700, "4800 x 1.4 = 6720 -> 6700");
  assert.strictEqual(total(startTrip(cfg, at(3))), 5800);
}

/* ---- base distance and distance units ---- */
{
  const t = startTrip(cfg, at(14));
  const v = 50 / 3.6; // 50 km/h
  let steps = 0, firstChange = null;
  while (t.distance < 1900) {
    advance(t, 1, v, at(14));
    steps++;
    if (firstChange === null && total(t) > 4800) firstChange = t.distance;
  }
  assert.ok(firstChange >= 1731 - 1e-6 && firstChange < 1731 + v + 1e-6, `first unit after 1600+131 m (was ${firstChange})`);
  assert.strictEqual(t.mode, "distance");
  assert.strictEqual(total(t), 4800 + 100 * Math.floor((t.distance - 1600 + 1e-6) / 131));
}

/* ---- time counting: waiting is free until the base distance is used, then 1 unit / 30 s ---- */
{
  const t = startTrip(cfg, at(14));
  for (let i = 0; i < 600; i++) advance(t, 1, 0, at(14));
  assert.strictEqual(total(t), 4800, "10 minutes of waiting at the start costs nothing");
  assert.strictEqual(t.mode, "base");
  advance(t, 1, 1600, at(14), 1600); // drive off: uses up the base distance in one go
  assert.strictEqual(t.baseLeft, 0);
  for (let i = 0; i < 300; i++) advance(t, 1, 0, at(14)); // 5 min stopped in traffic
  assert.strictEqual(total(t), 4800 + 1000, "300 s / 30 s = 10 units");
  assert.strictEqual(t.mode, "time");
}

/* ---- slow driving is billed by time, fast driving by distance ---- */
{
  const t = startTrip(cfg, at(14));
  advance(t, 1, 1600, at(14), 20);
  for (let i = 0; i < 60; i++) advance(t, 1, 2, at(14)); // 2 m/s for 60 s (120 m) -> time: 60 s = 2 units
  assert.strictEqual(total(t), 4800 + 200, "slow: counted as time, not as 120 m");
  const u = startTrip(cfg, at(14));
  advance(u, 1, 1600, at(14), 20);
  for (let i = 0; i < 10; i++) advance(u, 1, 20, at(14)); // 20 m/s for 10 s = 200 m -> 1 unit
  assert.strictEqual(total(u), 4800 + 100, "fast: 200 m = 1 unit");
}

/* ---- surcharges ---- */
{
  // 10 units driven at 22:30 -> everything x1.2
  const t = startTrip(cfg, at(22, 30));
  advance(t, 1, 1600, at(22, 30), 20);
  for (let i = 0; i < 10; i++) advance(t, 1, 131, at(22, 30), 20);
  const b = breakdown(t);
  assert.deepStrictEqual([b.base, b.running, b.fare, b.surcharge], [4800, 1000, 7000, 1200], "5800 x 1.2 = 6960 -> 7000");

  // the percentage that applies is the one at the moment the units are incurred
  const m = startTrip(cfg, at(22, 59));
  advance(m, 1, 1600, at(22, 59), 20);
  advance(m, 1, 131, at(22, 59), 20); // +100 at 20%
  advance(m, 1, 131, at(23, 0), 20); // +100 at 40%
  assert.strictEqual(total(m), 6000, "5760 + 120 + 140 = 6020 -> 6000");

  // out-of-city surcharge is a % of the whole fare and stacks with night
  const o = startTrip(cfg, at(23, 30), true);
  assert.strictEqual(total(o), 7700, "4800 x (1 + 0.4 + 0.2) = 7680 -> 7700");
  o.outside = false;
  assert.strictEqual(total(o), 6700, "switching it off again restores the fare");

  // tolls and call fee are added as they are (no rounding to 100)
  const f = startTrip(cfg, at(14));
  f.tolls = 1350; f.callFee = 1000;
  const bb = breakdown(f);
  assert.deepStrictEqual([bb.fare, bb.tolls, bb.callFee, bb.total], [4800, 1350, 1000, 7150]);
}

/* ---- GPS fixes -> distance ---- */
{
  const M_PER_DEG_LAT = (Math.PI / 180) * 6371008.8;
  const north = (metres) => 37.5 + metres / M_PER_DEG_LAT;
  assert.ok(Math.abs(haversine(37.5, 127, north(1000), 127) - 1000) < 0.01);

  // 10 m/s for 100 s, 1 Hz, position only (no speed), 5 m accuracy noise
  const r = rng(1);
  const tr = new FixTracker();
  let sum = 0;
  for (let i = 0; i <= 100; i++) {
    const noise = (r() - 0.5) * 6;
    const dd = tr.ingest({ t: i * 1000, lat: north(i * 10 + noise), lon: 127, accuracy: 5, speed: null });
    sum += dd || 0;
  }
  assert.ok(sum > 940 && sum < 1060, `position-only distance ~1000 m (was ${sum.toFixed(0)})`);

  // with Doppler speed the distance is exact, and jitter is ignored when stopped
  const t2 = new FixTracker();
  let s2 = 0;
  for (let i = 0; i <= 100; i++) s2 += t2.ingest({ t: i * 1000, lat: north(i * 10), lon: 127, accuracy: 5, speed: 10 }) || 0;
  assert.ok(Math.abs(s2 - 1000) < 1e-6, `speed-based distance (was ${s2})`);
  const t3 = new FixTracker();
  let s3 = 0;
  const r3 = rng(7);
  for (let i = 0; i < 120; i++) s3 += t3.ingest({ t: i * 1000, lat: north((r3() - 0.5) * 12), lon: 127 + (r3() - 0.5) * 1e-4, accuracy: 8, speed: 0 }) || 0;
  assert.strictEqual(s3, 0, "stopped with GPS drift and speed 0 -> no distance");

  // stopped, drifting, and no speed reported: filtered by the accuracy-based dead zone
  const t4 = new FixTracker();
  let s4 = 0;
  const r4 = rng(11);
  for (let i = 0; i < 120; i++) s4 += t4.ingest({ t: i * 1000, lat: north((r4() - 0.5) * 8), lon: 127, accuracy: 10, speed: null }) || 0;
  assert.ok(s4 < 40, `drift without speed adds little (was ${s4.toFixed(0)} m over 2 minutes)`);

  // bad fixes
  const t5 = new FixTracker();
  assert.strictEqual(t5.ingest({ t: 0, lat: 37.5, lon: 127, accuracy: 120, speed: null }), null, "poor accuracy rejected");
  assert.strictEqual(t5.ingest({ t: 0, lat: 37.5, lon: 127, accuracy: 5, speed: null }), 0, "first good fix only sets the anchor");
  assert.strictEqual(t5.ingest({ t: 1000, lat: north(5000), lon: 127, accuracy: 5, speed: null }), null, "5 km in 1 s is a teleport");
  assert.strictEqual(t5.ingest({ t: 0, lat: 37.5, lon: 127, accuracy: 5, speed: null }), null, "same timestamp as the last accepted fix is ignored");
  assert.strictEqual(t5.ingest({ t: 1000, lat: 37.5, lon: 127, accuracy: 5, speed: null }), 0, "a rejected fix does not move the clock: this one is a normal 1 s step");
  assert.ok(t5.ingest({ t: 3000, lat: north(30), lon: 127, accuracy: 5, speed: null }) > 29, "a sane fix still works after the bad ones");
}

/* ---- a whole trip: ~8 km at ~50 km/h with three 30 s stops ---- */
{
  const t = startTrip(cfg, at(14));
  const v = 50 / 3.6;
  let d = 0;
  while (d < 8000) {
    advance(t, 1, v, at(14), v);
    d += v;
    const stopAt = [2000, 4000, 6000];
    if (stopAt.some((s) => d >= s && d < s + v)) for (let i = 0; i < 30; i++) advance(t, 1, 0, at(14), 0);
  }
  const fare = total(t);
  assert.ok(fare > 9500 && fare < 10500, `8 km with stops should cost about 10,000 won (was ${fare})`);
}

/* ---- demo drive ---- */
{
  assert.strictEqual(demoSpeed(0), 0, "starts standing");
  assert.ok(Math.abs(demoSpeed(40) * 3.6 - 50) < 1e-9, "cruises at 50 km/h");
  assert.strictEqual(demoSpeed(95), 0, "stopped at the red light");
  assert.strictEqual(demoSpeed(DEMO_PERIOD + 40), demoSpeed(40), "loops");
  let d = 0, stopped = 0;
  for (let s = 0; s < DEMO_PERIOD; s++) { const v = demoSpeed(s + 0.5); d += v; if (v < 0.1) stopped++; }
  assert.ok(d > 3000 && d < 5000, `one lap is a few km (was ${d.toFixed(0)} m)`);
  assert.ok(stopped > 60, "has real stops");
}

/* ---- horse: faster with speed, still when stopped ---- */
{
  assert.strictEqual(strideHz(0), 0);
  assert.strictEqual(strideHz(0.4), 0, "creeping below 0.5 km/h counts as stopped");
  let prev = 0;
  for (const kmh of [1, 5, 10, 20, 30, 50, 70]) {
    const hz = strideHz(kmh);
    assert.ok(hz > prev, `stride rate rises with speed (${kmh} km/h -> ${hz.toFixed(2)} Hz)`);
    prev = hz;
  }
  assert.ok(strideHz(300) <= 5, "stride rate is capped");

  const still = pose(0.37, 0);
  const z = (v) => v + 0; // -0 and 0 are the same standing pose
  for (const k of ["rl", "rr", "fl", "fr"]) assert.deepStrictEqual({ thigh: z(still[k].thigh), shin: z(still[k].shin) }, { thigh: 0, shin: 0 }, `${k} stands straight at amp 0`);

  let thighMax = 0, differs = false;
  for (let i = 0; i < 200; i++) {
    const ph = i / 200;
    const a = pose(ph, 1), b = pose(ph + 1, 1);
    assert.ok(Math.abs(a.rl.thigh - b.rl.thigh) < 1e-9 && Math.abs(a.fr.shin - b.fr.shin) < 1e-9, "periodic: one stride later is the same pose");
    for (const k of ["rl", "rr", "fl", "fr"]) {
      thighMax = Math.max(thighMax, Math.abs(a[k].thigh));
      assert.ok(a[k].shin <= 0 && a[k].shin >= -62.0001, "knees only fold backwards, within limits");
    }
    if (Math.abs(a.rl.thigh - a.fl.thigh) > 5) differs = true;
  }
  assert.ok(thighMax > 30 && thighMax <= 40.0001, `legs swing about 30-40 degrees (max ${thighMax.toFixed(1)})`);
  assert.ok(differs, "front and hind legs are out of phase");
}

/* ---- horse legs are fixed "segments" that light up one set at a time ---- */
{
  assert.strictEqual(legPath([38, 37], 0, 0), "M38.0 37.0 L38.0 52.0 L38.0 69.0 L42.5 69.0", "a straight leg: hip, knee, foot, hoof");
  const fwd = legPath([38, 37], 30, 0);
  assert.ok(parseFloat(fwd.split(" L")[1].split(" ")[0]) > 38, "a positive thigh angle swings the knee forward (+x)");

  assert.strictEqual(FRAMES, 4);
  const sets = [...Array(FRAMES).keys()].map((i) => framePaths(i));
  const stand = framePaths("stand");
  for (const s of [...sets, stand]) assert.strictEqual(s.length, 4, "four legs per set");
  const keys = new Set([...sets, stand].map((s) => s.join("|")));
  assert.strictEqual(keys.size, FRAMES + 1, "every running pose and the standing pose are all different");
  assert.ok(stand.every((d, i) => d.startsWith(`M${HIPS[["rl", "rr", "fl", "fr"][i]][0].toFixed(1)} 37.0 L`)), "legs hang from the hips");
  for (const s of [...sets, stand]) for (const d of s) {
    const ys = [...d.matchAll(/(-?\d+\.\d) (-?\d+\.\d)/g)].map((m) => parseFloat(m[2]));
    assert.ok(Math.max(...ys) <= 70 && Math.min(...ys) >= 37, "every leg stays inside the 70-unit-high icon, below the hips");
  }

  // the lit set advances with the phase: 0,1,2,3,0,... and wraps (also for negative phases)
  assert.deepStrictEqual([0, 0.26, 0.51, 0.76, 1.01, -0.1].map(frameAt), [0, 1, 2, 3, 0, 3]);
}

/* ---- formatting ---- */
{
  assert.strictEqual(won(4800), "4,800");
  assert.strictEqual(clock(125), "02:05");
  assert.strictEqual(clock(3725), "1:02:05");
  assert.strictEqual(clock(-5), "00:00");
}

console.log("all tests passed");
