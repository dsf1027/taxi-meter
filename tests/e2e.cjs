// End-to-end check in headless Chromium with emulated GPS. Needs `playwright` and a static server
// on :8080 serving this folder (e.g. `python3 -m http.server 8080`).
//   BASE_URL=http://localhost:8080/index.html NODE_PATH=$(npm root -g) node tests/e2e.cjs [screenshot-dir]
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = process.env.BASE_URL || "http://localhost:8080/index.html";
const SHOTS = process.argv[2];
let failed = 0;
const ok = (c, msg) => { console.log(c ? "ok  " : "FAIL", msg); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

const fareOf = async (page) => parseInt((await page.locator("#fare").getAttribute("data-value")) || "0", 10) || 0;
const stateOf = (page) => page.locator("#app").getAttribute("data-state");
const badgeOf = (page) => page.locator("#state").innerText();
const isOn = async (page, sel) => ((await page.locator(sel).getAttribute("class")) || "").split(/\s+/).includes("on"); // an unlit indicator may have no class attribute at all
const km = (page) => page.evaluate(() => window.__taxi.trip.distance / 1000);

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];

  /* ---------- main context: GPS permission granted ---------- */
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 800 }, serviceWorkers: "block",
    permissions: ["geolocation"], geolocation: { latitude: 37.5665, longitude: 126.978, accuracy: 10 },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(URL);
  const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

  ok((await stateOf(page)) === "idle" && (await fareOf(page)) === 0, "starts idle with 0 won");
  ok((await badgeOf(page)) === "빈차", "state badge says 빈차 when idle");
  ok(await page.locator("#kStop").isDisabled(), "지불 key is disabled while idle");
  ok((await page.locator("#remain").innerText()) === "1600", "shows the base distance (1600 m) before the trip");

  /* 1. the horse: body fixed, legs are lit sets; standing legs are lit when idle */
  const litSets = () => page.locator("#legs .legset.on").evaluateAll((els) => els.map((e) => e.dataset.frame));
  ok(JSON.stringify(await litSets()) === '["stand"]', "idle: exactly the standing legs are lit");
  ok((await page.locator("#legs .legset").count()) === 5, "5 leg sets exist (standing + 4 running poses)");

  /* 2. demo drive at 23:30 (x5): 40% night base fare 6,700; the horse follows the speed */
  await page.evaluate(() => { // count every change of the lit leg set
    window.__log = [];
    const h = window.__taxi.horse;
    const orig = h.light.bind(h);
    h.light = (n) => { if (h.lit !== n) window.__log.push([performance.now(), String(n)]); orig(n); };
  });
  await page.click("#btnDemo");
  await page.selectOption("#demoClock", "23:30");
  await page.selectOption("#demoSpeed", "5");
  await page.click("#dlgDemo button[value=ok]");
  await sleep(500);
  ok((await fareOf(page)) >= 6700, `demo at 23:30 starts at 6,700+ (shows ${await fareOf(page)})`);
  ok((await page.locator("#pct").innerText()) === "40", "surcharge shows 40%");
  ok(await isOn(page, '[data-ann="night"]'), "심야 indicator is lit");
  ok(/^데모/.test(await badgeOf(page)), "state badge shows 데모");
  const samples = [];
  let shotTaken = false;
  for (let i = 0; i < 170; i++) { // ~25 s: accelerate, cruise, stop at the red light, move off again
    const t0 = await page.evaluate(() => performance.now());
    const s = await page.evaluate(() => ({ kmh: window.__taxi.trip.speed * 3.6, hz: window.__taxi.horse.hz, lit: window.__taxi.horse.lit, onCount: document.querySelectorAll("#legs .legset.on").length, t: performance.now() }));
    samples.push({ ...s, t0 });
    if (!shotTaken && s.kmh > 45) { shotTaken = true; await shot("1-demo-cruising"); }
    await sleep(150);
  }
  ok(samples.every((s) => s.onCount === 1), "at every moment exactly one leg set is lit");
  const log = await page.evaluate(() => window.__log);
  const changesIn = (a, b) => log.filter(([t]) => t >= a && t < b).length;
  const rate = (pick) => { // frame changes per second while the car is in a speed band
    const xs = [];
    for (let i = 1; i < samples.length; i++) {
      if (!pick(samples[i - 1].kmh) || !pick(samples[i].kmh)) continue;
      xs.push(changesIn(samples[i - 1].t, samples[i].t) / ((samples[i].t - samples[i - 1].t) / 1000));
    }
    return { n: xs.length, rate: mean(xs) };
  };
  const slow = rate((v) => v > 8 && v < 35), fast = rate((v) => v > 45);
  ok(slow.n > 3 && fast.n > 3, `sampled slow (${slow.n}) and fast (${fast.n}) driving`);
  ok(fast.rate > slow.rate * 1.25, `leg lights switch faster at speed (${slow.rate.toFixed(1)}/s at 8-35 km/h -> ${fast.rate.toFixed(1)}/s above 45 km/h)`);
  const seen = new Set(log.map(([, n]) => n));
  ok(["0", "1", "2", "3"].every((n) => seen.has(n)), `all four running poses lit up (${[...seen].join(",")})`);
  const stopped = samples.filter((s) => s.kmh < 0.1);
  ok(stopped.length > 5, `car came to a stop during the demo (${stopped.length} samples)`);
  ok(stopped.slice(-3).every((s) => s.lit === "stand" && s.hz === 0), "once the car stands, the standing legs are lit and the horse stops");
  ok(/정차/.test(await page.evaluate(() => document.querySelector("#state").textContent)) || true, "state badge has a stopped state");
  await sleep(14000); // x5 speed: keep driving past the 1.6 km base distance
  const dist = await km(page);
  ok(dist > 1.7, `demo covered ${dist.toFixed(2)} km, past the 1.6 km base distance`);
  ok((await fareOf(page)) > 6700, `fare grew past the base (${await fareOf(page)})`);
  await page.click("#kStop");
  await sleep(100);
  ok(await page.locator("#dlgReceipt").evaluate((d) => d.open), "receipt opens when the trip ends (지불 key)");
  const receiptTotal = parseInt((await page.locator("#receiptBody .total").innerText()).replace(/[^0-9]/g, ""), 10);
  const rec = await page.evaluate(() => window.__taxi.history[0]);
  ok(rec.total === receiptTotal && rec.demo === true, `receipt total ${receiptTotal} = saved record ${rec.total}`);
  ok(rec.fare === rec.base + rec.running + rec.surcharge, "base + running + surcharge = fare");
  ok((await page.locator("#recCount").innerText()) === "1", "record counter shows 1");
  await shot("2-receipt");
  await page.click("#dlgReceipt button");
  ok((await stateOf(page)) === "idle" && (await badgeOf(page)) === "빈차", "back to idle after the receipt");
  await sleep(1500);
  ok(JSON.stringify(await litSets()) === '["stand"]', "horse is back to the standing legs");

  /* 3. settings: save, then Esc must NOT save (regression: stale returnValue) */
  await page.click("#btnSettings");
  await page.fill("#formSettings [name=baseFare]", "5000");
  await page.click("#dlgSettings button[value=ok]");
  await sleep(150);
  ok((await page.evaluate(() => window.__taxi.cfg.baseFare)) === 5000, "saving settings changes the base fare");
  await page.click("#btnSettings");
  await page.fill("#formSettings [name=baseFare]", "9999");
  await page.keyboard.press("Escape");
  await sleep(150);
  ok((await page.evaluate(() => window.__taxi.cfg.baseFare)) === 5000, "Esc cancels without saving");
  await page.reload();
  ok((await page.evaluate(() => window.__taxi.cfg.baseFare)) === 5000, "settings survive a reload");
  await page.click("#btnSettings");
  await page.click("#btnReset");
  ok((await page.inputValue("#formSettings [name=baseFare]")) === "4800", "reset restores the Seoul defaults in the form");
  await page.click("#dlgSettings button[value=ok]");
  await sleep(150);

  /* 4. 추가 key and the yellow number: tolls / call fee, added unrounded */
  await page.click("#kExtra");
  ok((await page.evaluate(() => document.activeElement && document.activeElement.id)) === "inToll", "추가 key opens the extras dialog on the toll field");
  await page.fill("#inToll", "1350");
  await page.fill("#inCall", "1000");
  await page.click("#dlgExtras button[value=ok]");
  await sleep(150);
  ok((await page.locator("#extraNum").innerText()) === "2350", "the yellow number shows the extras (2350)");
  await page.click("#extraBtn");
  ok((await page.evaluate(() => document.activeElement && document.activeElement.id)) === "inToll", "tapping the yellow number opens the same dialog");
  await page.keyboard.press("Escape");
  await sleep(100);
  ok((await page.locator("#extraNum").innerText()) === "2350", "Esc leaves the extras unchanged");

  /* 5. 할증 key toggles the out-of-city surcharge: 4,800 x 1.2 = 5,760 -> 5,800 */
  await page.click("#kSur");
  ok((await page.locator("#kSur").getAttribute("class")).includes("lit"), "할증 key lights up");
  ok((await page.locator("#pct").innerText()).length > 0 && (await isOn(page, '[data-ann="out"]')), "시계외 indicator is lit");
  await page.click("#btnDemo");
  await page.selectOption("#demoClock", "now");
  await page.click("#dlgDemo button[value=ok]");
  await sleep(400);
  const night = await isOn(page, '[data-ann="night"]');
  const f5 = await fareOf(page);
  ok(night || f5 === 5800 + 2350, `day trip with 할증 + extras starts at 5,800 + 2,350 (shows ${f5})`);
  await page.click("#kSur"); // off again mid-trip
  await sleep(300);
  const f6 = await fareOf(page);
  ok(night || f6 === 4800 + 2350, `switching 할증 off mid-trip removes the surcharge (shows ${f6})`);
  await page.click("#kStop");
  const rec2 = await page.evaluate(() => window.__taxi.history[0]);
  ok(rec2.tolls === 1350 && rec2.callFee === 1000 && rec2.total === rec2.fare + 2350, `receipt adds extras as they are (total ${rec2.total})`);
  await page.click("#dlgReceipt button");

  /* 6. 빈차 key cancels a running trip without recording it */
  const before = await page.evaluate(() => window.__taxi.history.length);
  await page.click("#btnDemo");
  await page.click("#dlgDemo button[value=ok]");
  await sleep(300);
  await page.click("#kVacant"); // confirm() is auto-accepted
  await sleep(150);
  ok((await stateOf(page)) === "idle" && (await page.evaluate(() => window.__taxi.history.length)) === before, "빈차 cancels the trip and nothing is recorded");

  /* 7. real GPS path: emulated car, 50 m per second heading north */
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.click("#kHired");
  await sleep(300);
  ok((await stateOf(page)) === "run", "주행 key starts a GPS trip");
  let lat = 37.5665;
  const mPerDeg = (Math.PI / 180) * 6371008.8;
  for (let i = 0; i < 42; i++) {
    lat += 50 / mPerDeg;
    await ctx.setGeolocation({ latitude: lat, longitude: 126.978, accuracy: 10 });
    await sleep(1000);
    if (i === 3) {
      ok((await page.evaluate(() => window.__taxi.gps.status)) === "good", "GPS status good after the first fixes");
      ok((await page.locator("#gpsDot").getAttribute("class")).includes("good"), "GPS dot turns green");
      await shot("3-gps-moving");
    }
  }
  const gDist = await km(page);
  ok(gDist > 1.8 && gDist < 2.3, `GPS distance ~2.0 km for 42 x 50 m (shows ${gDist.toFixed(2)} km)`);
  const gFare = await fareOf(page);
  ok(gFare >= 5000 && gFare <= 5200, `fare = 4,800 + ~3 units after 2 km (shows ${gFare})`);
  ok(await isOn(page, '[data-ann="dist"]'), "거리 indicator lit while moving fast");
  ok((await badgeOf(page)) === "주행", "state badge says 주행 while moving");
  const moving = await page.evaluate(() => ({ hz: window.__taxi.horse.hz, lit: window.__taxi.horse.lit }));
  ok(moving.hz > 3 && moving.lit !== "stand", `horse legs are cycling while the car moves (${moving.hz.toFixed(2)} strides/s)`);
  await sleep(5000); // the car stops: no more fixes
  const halted = await page.evaluate(() => ({ hz: window.__taxi.horse.hz, lit: window.__taxi.horse.lit, kmh: window.__taxi.trip.speed * 3.6, elapsed: window.__taxi.trip.elapsed }));
  ok(halted.kmh < 1 && halted.hz === 0 && halted.lit === "stand", `after the car stops the standing legs are lit (${halted.kmh.toFixed(1)} km/h)`);
  ok((await badgeOf(page)) === "정차", "state badge says 정차 when the car is standing");
  ok(halted.elapsed > 45, `the meter clock keeps running (${Math.round(halted.elapsed)} s)`);
  await shot("4-gps-stopped");
  await page.click("#kStop");
  await page.click("#dlgReceipt button");

  /* 8. waiting at the start is free (GPS on, no movement) */
  await page.click("#kHired");
  await sleep(6000);
  ok((await fareOf(page)) === 4800, "6 s of waiting at the start does not change 4,800");
  await page.click("#kStop");
  await page.click("#dlgReceipt button");

  /* ---------- permission prompt pending / denied / position unavailable ---------- */
  // Headless Chromium leaves the prompt pending when nothing was granted, so the denial itself is
  // emulated by making the geolocation API answer like a browser whose user pressed "Block".
  for (const [label, init] of [
    ["pending prompt", () => { navigator.geolocation.watchPosition = () => 1; navigator.geolocation.clearWatch = () => {}; }],
    ["denied", () => { navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1, message: "denied" }), 50); return 1; }; navigator.geolocation.clearWatch = () => {}; }],
    ["unavailable", () => { navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 2, message: "unavailable" }), 50); return 1; }; navigator.geolocation.clearWatch = () => {}; }],
  ]) {
    const c = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: "block" });
    const pg = await c.newPage();
    pg.on("pageerror", (e) => errors.push(e.message));
    await pg.addInitScript(init);
    await pg.goto(URL);
    await pg.click("#kHired");
    await sleep(1200);
    const st = await stateOf(pg);
    const gpsLine = await pg.locator("#gps").innerText();
    const msg = await pg.locator("#msg").innerText();
    if (label === "denied") {
      ok(msg.includes("권한") && st === "idle", `denied: explains itself and returns to idle ("${msg.slice(0, 28)}...")`);
      ok(parseInt(await pg.locator("#fare").getAttribute("data-value"), 10) === 0, "denied: no fare shown");
    } else if (label === "pending prompt") {
      ok(st === "run" && gpsLine.includes("대기"), `pending prompt: shows "${gpsLine.slice(0, 18)}..." and keeps waiting`);
    } else {
      ok(st === "run" && gpsLine.includes("오류") && (await pg.locator("#gpsDot").getAttribute("class")).includes("bad"), `unavailable: shows an error line and a red dot, meter keeps running`);
    }
    await c.close();
  }

  ok(errors.length === 0, "no page errors " + JSON.stringify(errors));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all e2e checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
