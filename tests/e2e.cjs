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

// Helpers that read what the LCD currently shows.
const lcdValue = (page, id) => page.locator(id).getAttribute("data-value");
const fareOf = async (page) => parseInt(((await lcdValue(page, "#lcdFare")) || "0").trim(), 10) || 0;
const stateOf = (page) => page.locator("#app").getAttribute("data-state");

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
  ok(await page.locator('.lamps li[data-lamp="vacant"].on').count() === 1, "VACANT lamp is lit when idle");
  ok(await page.locator("#kStop").isDisabled(), "STOP key is disabled while idle");

  /* 1. the horse stands still when idle */
  const idleHorse = await page.evaluate(() => ({ hz: window.__taxi.horse.hz, raf: window.__taxi.horse.raf }));
  ok(idleHorse.hz === 0, "horse stands still when the meter is idle");

  /* 2. demo drive at 23:30 (x5): 40% night base fare 6,700; the horse follows the speed */
  await page.click("#btnDemo");
  await page.selectOption("#demoClock", "23:30");
  await page.selectOption("#demoSpeed", "5");
  await page.click("#dlgDemo button[value=ok]");
  await sleep(500);
  ok((await fareOf(page)) >= 6700, `demo at 23:30 starts at 6,700+ (shows ${await fareOf(page)})`);
  ok(await page.locator('.lamps li[data-lamp="night"].on').count() === 1, "NIGHT lamp lit during the night band");
  ok(await page.locator('.lamps li[data-lamp="hired"].on').count() === 1, "HIRED lamp lit while running");
  const samples = [];
  let shotTaken = false;
  for (let i = 0; i < 170; i++) { // ~25 s: accelerate, cruise, stop at the red light, move off again
    const s = await page.evaluate(() => ({ kmh: window.__taxi.trip.speed * 3.6, hz: window.__taxi.horse.hz, amp: window.__taxi.horse.amp, raf: window.__taxi.horse.raf }));
    samples.push(s);
    if (!shotTaken && s.kmh > 45) { shotTaken = true; await shot("1-demo-cruising"); }
    await sleep(150);
  }
  const slow = samples.filter((s) => s.kmh > 5 && s.kmh < 35).map((s) => s.hz);
  const fast = samples.filter((s) => s.kmh > 45).map((s) => s.hz);
  ok(slow.length > 3 && fast.length > 3, `sampled slow (${slow.length}) and fast (${fast.length}) driving`);
  ok(mean(fast) > mean(slow) * 1.25, `horse gallops faster at speed (${mean(slow).toFixed(2)} Hz at 5-35 km/h -> ${mean(fast).toFixed(2)} Hz above 45 km/h)`);
  const stopped = samples.filter((s) => s.kmh < 0.1);
  ok(stopped.length > 5, `car came to a stop during the demo (${stopped.length} samples)`);
  ok(stopped.slice(-3).every((s) => s.hz < 0.3 && s.amp < 0.1), "horse has nearly stopped once the car has been standing a moment");
  ok(stopped.slice(-1)[0].raf === 0 || stopped.slice(-1)[0].hz < 0.05, "and its animation loop winds down");
  ok(await page.locator('.lamps li[data-lamp="stop"].on').count() >= 0, "STOP lamp is part of the display");
  await sleep(14000); // x5 speed: 25 s of sampling is only ~1.1 km, so keep driving past the 1.6 km base distance
  const dist = parseFloat(await lcdValue(page, "#lcdDist"));
  ok(dist > 1.7, `demo covered ${dist} km, past the 1.6 km base distance`);
  ok((await fareOf(page)) > 6700, `fare grew past the base (${await fareOf(page)})`);
  await page.click("#kStop");
  await sleep(100);
  ok(await page.locator("#dlgReceipt").evaluate((d) => d.open), "receipt opens when the trip ends (STOP key)");
  const receiptTotal = parseInt((await page.locator("#receiptBody .total").innerText()).replace(/[^0-9]/g, ""), 10);
  const rec = await page.evaluate(() => window.__taxi.history[0]);
  ok(rec.total === receiptTotal && rec.demo === true, `receipt total ${receiptTotal} = saved record ${rec.total}`);
  ok(rec.fare === rec.base + rec.running + rec.surcharge, "base + running + surcharge = fare");
  ok((await page.locator("#recCount").innerText()) === "1", "RECORDS counter shows 1");
  await shot("2-receipt");
  await page.click("#dlgReceipt button");
  ok((await stateOf(page)) === "idle", "back to idle after the receipt");

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

  /* 4. TOLL / CALL keys; amounts are added unrounded */
  await page.click("#kToll");
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === "inToll", "TOLL key opens the extras dialog on the toll field");
  await page.fill("#inToll", "1350");
  await page.fill("#inCall", "1000");
  await page.click("#dlgExtras button[value=ok]");
  await sleep(150);
  ok((await page.locator("#extrasSum").innerText()).includes("2,350"), "extras total shown");
  await page.click("#kCall");
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === "inCall", "CALL key focuses the call-fee field");
  await page.keyboard.press("Escape");
  await sleep(100);
  ok((await page.locator("#extrasSum").innerText()).includes("2,350"), "Esc leaves the extras unchanged");

  /* 5. SUR key toggles the out-of-city surcharge: 4,800 x 1.2 = 5,760 -> 5,800 */
  await page.click("#kSur");
  ok((await page.locator("#kSur").getAttribute("class")).includes("lit"), "SUR key lights up");
  await page.click("#btnDemo");
  await page.selectOption("#demoClock", "now");
  await page.click("#dlgDemo button[value=ok]");
  await sleep(400);
  const night = await page.locator('.lamps li[data-lamp="night"].on').count() === 1;
  ok((await page.locator('[data-ann="out"]').getAttribute("class")).includes("on"), "OUT annunciator is lit");
  const f5 = await fareOf(page);
  const expect = night ? null : 5800 + 2350;
  ok(night || f5 === expect, `day trip with SUR + extras starts at 5,800 + 2,350 (shows ${f5})`);
  await page.click("#kSur"); // off again mid-trip
  await sleep(300);
  const f6 = await fareOf(page);
  ok(night || f6 === 4800 + 2350, `switching SUR off mid-trip removes the surcharge (shows ${f6})`);
  await page.click("#kStop");
  const rec2 = await page.evaluate(() => window.__taxi.history[0]);
  ok(rec2.tolls === 1350 && rec2.callFee === 1000 && rec2.total === rec2.fare + 2350, `receipt adds extras as they are (total ${rec2.total})`);
  await page.click("#dlgReceipt button");

  /* 6. VACANT key cancels a running trip without recording it */
  const before = await page.evaluate(() => window.__taxi.history.length);
  await page.click("#btnDemo");
  await page.click("#dlgDemo button[value=ok]");
  await sleep(300);
  await page.click("#kVacant"); // confirm() is auto-accepted
  await sleep(150);
  ok((await stateOf(page)) === "idle" && (await page.evaluate(() => window.__taxi.history.length)) === before, "VACANT cancels the trip and nothing is recorded");

  /* 7. real GPS path: emulated car, 50 m per second heading north */
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.click("#kHired");
  await sleep(300);
  ok((await stateOf(page)) === "run", "HIRED key starts a GPS trip");
  let lat = 37.5665;
  const mPerDeg = (Math.PI / 180) * 6371008.8;
  for (let i = 0; i < 42; i++) {
    lat += 50 / mPerDeg;
    await ctx.setGeolocation({ latitude: lat, longitude: 126.978, accuracy: 10 });
    await sleep(1000);
    if (i === 3) {
      ok((await page.evaluate(() => window.__taxi.gps.status)) === "good", "GPS status good after the first fixes");
      await shot("3-gps-moving");
    }
  }
  const gDist = parseFloat(await lcdValue(page, "#lcdDist"));
  ok(gDist > 1.8 && gDist < 2.3, `GPS distance ~2.0 km for 42 x 50 m (shows ${gDist} km)`);
  const gFare = await fareOf(page);
  ok(gFare >= 5000 && gFare <= 5200, `fare = 4,800 + ~3 units after 2 km (shows ${gFare})`);
  ok((await page.locator('[data-ann="dist"]').getAttribute("class")).includes("on"), "DIST annunciator lit while moving fast");
  const moving = await page.evaluate(() => ({ hz: window.__taxi.horse.hz, kmh: window.__taxi.trip.speed * 3.6 }));
  ok(moving.hz > 3, `horse is galloping while the car moves (${moving.hz.toFixed(2)} Hz at ${Math.round(moving.kmh)} km/h)`);
  await sleep(5000); // the car stops: no more fixes
  const halted = await page.evaluate(() => ({ hz: window.__taxi.horse.hz, kmh: window.__taxi.trip.speed * 3.6, elapsed: window.__taxi.trip.elapsed }));
  ok(halted.kmh < 1 && halted.hz < 0.3, `after the car stops the horse stops too (${halted.kmh.toFixed(1)} km/h, ${halted.hz.toFixed(2)} Hz)`);
  ok(halted.elapsed > 45, `the meter clock keeps running (${Math.round(halted.elapsed)} s)`);
  ok(await page.locator('.lamps li[data-lamp="stop"].on').count() === 1, "STOP lamp lights when the car is standing");
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
      ok(((await lcdValue(pg, "#lcdFare")) || "").trim() === "0", "denied: no fare shown");
    } else if (label === "pending prompt") {
      ok(st === "run" && gpsLine.includes("대기"), `pending prompt: shows "${gpsLine.slice(0, 18)}..." and keeps waiting`);
    } else {
      ok(st === "run" && gpsLine.includes("오류"), `unavailable: shows an error line ("${gpsLine.slice(0, 18)}...") but the meter keeps running`);
    }
    await c.close();
  }

  ok(errors.length === 0, "no page errors " + JSON.stringify(errors));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all e2e checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
