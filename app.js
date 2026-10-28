import {
  SEOUL_DEFAULTS, sanitizeConfig, nightPct, thresholdMps, startTrip, advance, breakdown, FixTracker, won, clock,
} from "./meter.js";
import { demoSpeed } from "./sim.js";
import { Horse } from "./horse.js";

const $ = (id) => document.getElementById(id);
const KEY_CFG = "taxi-meter:cfg:v1";
const KEY_HIST = "taxi-meter:history:v1";

// localStorage can throw (private mode, blocked data): the app must work without it.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

let cfg = sanitizeConfig(store.get(KEY_CFG));
let history = Array.isArray(store.get(KEY_HIST)) ? store.get(KEY_HIST) : [];
const extras = { tolls: 0, callFee: 0 };
let outside = false; // out-of-city surcharge, switched with the SUR key

const horse = new Horse($("horse"));

let trip = null;
let source = null; // "gps" | "demo"
const tracker = new FixTracker();
let pendingDd = 0;
let lastTick = 0;
let recent = []; // last few ticks, to smooth the speed that decides distance- vs time-counting
let timer = 0;
let watchId = null;
let wake = null;
let gps = { status: "idle", accuracy: null, lastFixAt: 0 };
let demo = null; // { mult, simSec, virtualStart, carry }

const nowDate = () => (source === "demo" && demo ? new Date(demo.virtualStart + demo.simSec * 1000) : new Date());

/* ---------- trip lifecycle ---------- */
function begin(kind, opts = {}) {
  if (trip) return;
  source = kind;
  let startAt = new Date();
  if (kind === "demo") {
    if (opts.clock && opts.clock !== "now") {
      const [h, m] = opts.clock.split(":").map(Number);
      startAt = new Date(); startAt.setHours(h, m, 0, 0);
    }
    demo = { mult: opts.mult || 20, simSec: 0, virtualStart: startAt.getTime(), carry: 0 };
  }
  trip = startTrip(cfg, startAt, outside);
  trip.tolls = extras.tolls;
  trip.callFee = extras.callFee;
  tracker.reset();
  pendingDd = 0;
  recent = [];
  lastTick = performance.now();
  if (kind === "gps") startGps();
  timer = setInterval(tick, kind === "demo" ? 250 : 1000);
  requestWake();
  say(kind === "gps" ? "화면을 켜 둔 채로 이용하세요. 화면이 꺼지면 GPS 측정이 멈출 수 있어요." : "");
  render();
}

function tick() {
  if (!trip) return;
  const t = performance.now();
  const dtReal = Math.min((t - lastTick) / 1000, 120);
  lastTick = t;
  if (source === "demo") {
    demo.carry += dtReal * demo.mult;
    const n = Math.floor(demo.carry);
    demo.carry -= n;
    for (let i = 0; i < n; i++) {
      const v = demoSpeed(demo.simSec + 0.5);
      demo.simSec += 1;
      advance(trip, 1, v, new Date(demo.virtualStart + demo.simSec * 1000), v);
    }
  } else if (dtReal > 0) {
    const dd = pendingDd;
    pendingDd = 0;
    recent.push({ dt: dtReal, dd });
    if (recent.length > 3) recent.shift();
    const sumDt = recent.reduce((a, r) => a + r.dt, 0);
    const sumDd = recent.reduce((a, r) => a + r.dd, 0);
    advance(trip, dtReal, dd, new Date(), sumDd / sumDt);
  }
  render();
}

function finish() {
  if (!trip) return;
  clearInterval(timer);
  stopGps();
  releaseWake();
  const b = breakdown(trip);
  const rec = {
    id: Date.now(), at: trip.startedMs, demo: source === "demo", distance: trip.distance, elapsed: trip.elapsed,
    outside: trip.outside, outsidePct: trip.cfg.outsidePct, ...b,
  };
  history.unshift(rec);
  history = history.slice(0, 50);
  store.set(KEY_HIST, history);
  trip = null; source = null; demo = null;
  gps = { status: "idle", accuracy: null, lastFixAt: 0 };
  say("");
  render();
  showReceipt(rec);
}

function abort(message) {
  clearInterval(timer);
  stopGps();
  releaseWake();
  trip = null; source = null; demo = null;
  gps = { status: "idle", accuracy: null, lastFixAt: 0 };
  say(message);
  render();
}

/* ---------- GPS ---------- */
function startGps() {
  if (!("geolocation" in navigator)) {
    gps = { status: "unsupported" };
    return;
  }
  gps = { status: "waiting", accuracy: null, lastFixAt: 0 };
  watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function stopGps() {
  if (watchId !== null && "geolocation" in navigator) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
function onFix(pos) {
  const c = pos.coords;
  gps = { status: c.accuracy <= 50 ? "good" : "poor", accuracy: c.accuracy, lastFixAt: Date.now() };
  const dd = tracker.ingest({ t: pos.timestamp || Date.now(), lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed });
  if (dd) pendingDd += dd;
}
function onGpsError(err) {
  if (err.code === 1) { // permission denied
    abort("위치 권한이 거부되어 출발할 수 없어요. 권한을 허용하거나 '데모 주행'으로 체험해 보세요.");
    return;
  }
  gps = { status: "error", accuracy: gps.accuracy, lastFixAt: gps.lastFixAt };
}

/* ---------- screen wake lock ---------- */
async function requestWake() {
  try { if ("wakeLock" in navigator) wake = await navigator.wakeLock.request("screen"); } catch (e) { /* not available */ }
}
function releaseWake() {
  try { if (wake) wake.release(); } catch (e) { /* ignore */ }
  wake = null;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && trip) requestWake(); });

/* ---------- rendering ---------- */
function say(text) { $("msg").textContent = text || ""; }

function gpsLine() {
  if (!trip) return { text: "출발을 누르면 GPS로 거리를 재요. 위치 권한이 필요해요.", cls: "" };
  if (source === "demo") return { text: `데모 주행 중 (가상 GPS, ×${demo.mult})`, cls: "" };
  switch (gps.status) {
    case "unsupported": return { text: "이 기기는 위치 기능을 지원하지 않아요. 데모 주행을 이용하세요.", cls: "bad" };
    case "error": return { text: "GPS 오류: 위치를 가져오지 못하고 있어요.", cls: "bad" };
    case "waiting": return { text: "GPS 신호 대기 중… (이 동안은 거리가 측정되지 않아요)", cls: "warn" };
    default: {
      const age = (Date.now() - gps.lastFixAt) / 1000;
      if (age > 5) return { text: `GPS 신호 끊김 (${Math.round(age)}초) — 이 동안 거리는 측정되지 않아요`, cls: "bad" };
      if (gps.status === "poor") return { text: `GPS 정확도 낮음 (${Math.round(gps.accuracy)} m)`, cls: "warn" };
      return { text: `GPS 신호 양호 (정확도 ${Math.round(gps.accuracy)} m)`, cls: "good" };
    }
  }
}

// The fare digits are as big as the column allows: shrink them when the number gets longer.
function fitFare() {
  const el = $("fare");
  const room = el.parentElement.clientWidth || 180;
  const digits = Math.max(4, el.textContent.length);
  el.style.fontSize = `${Math.max(34, Math.min(84, Math.floor(room / (digits * 0.72))))}px`;
}
const setFare = (n) => { $("fare").textContent = String(n); $("fare").dataset.value = String(n); fitFare(); };
window.addEventListener("resize", fitFare);

function render() {
  const running = !!trip;
  const b = running ? breakdown(trip) : null;
  const kmh = running ? trip.speed * 3.6 : 0;
  const d = running ? nowDate() : new Date();
  const pct = nightPct(cfg, d);

  // numbers on the screen
  setFare(running ? b.total : 0);
  $("speed").textContent = kmh.toFixed(1);
  const sec = running ? Math.floor(trip.elapsed) : 0;
  $("elapsed").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  const shownPct = (running ? (pct > 0 ? pct : 0) : 0) + (outside ? cfg.outsidePct : 0);
  $("pct").textContent = String(shownPct);
  const remain = !running ? cfg.baseDistance : trip.baseLeft > 0 ? trip.baseLeft : Math.max(0, cfg.unitDistance - trip.accum);
  $("remain").textContent = String(Math.round(remain));
  const extra = running ? trip.tolls + trip.callFee : extras.tolls + extras.callFee;
  $("extraNum").textContent = String(extra);
  $("extrasSum").textContent = `${won(extra)}원`;
  $("recCount").textContent = String(history.length);
  horse.setSpeed(kmh);

  // state badge (bottom left): 빈차 / 주행 / 정차 / 데모
  const stopped = running && trip.speed < 0.5;
  const badge = $("state");
  badge.className = "badge" + (running ? (source === "demo" ? " demo" : stopped ? " stop" : " run") : "");
  badge.textContent = running ? (source === "demo" ? (stopped ? "데모·정차" : "데모") : stopped ? "정차" : "주행") : "빈차";

  // what is being counted right now
  const ann = $("ann");
  const lit = (k, on) => ann.querySelector(`[data-ann="${k}"]`).classList.toggle("on", !!on);
  lit("base", running && trip.mode === "base");
  lit("dist", running && trip.mode === "distance");
  lit("time", running && trip.mode === "time");
  lit("night", running && pct > 0);
  lit("out", outside);

  // GPS dot
  const g = gpsLine();
  const dot = $("gpsDot");
  dot.className = "gpsdot" + (running && source === "demo" ? " demo" : g.cls ? " " + g.cls.replace("good", "good") : "");
  $("gps").textContent = g.text;
  $("gps").className = "gps " + g.cls;

  // keys
  $("kHired").disabled = running;
  $("kStop").disabled = !running;
  $("kVacant").classList.toggle("lit", !running);
  $("kHired").classList.toggle("lit", running);
  $("kSur").classList.toggle("lit", outside);
  $("btnDemo").disabled = running;
  $("btnSettings").disabled = running;
  $("app").dataset.state = running ? (source === "demo" ? "demo" : "run") : "idle";
}

/* ---------- dialogs ---------- */
function showReceipt(r) {
  const row = (k, v, cls = "") => `<div class="r ${cls}"><span>${k}</span><span>${v}</span></div>`;
  const when = new Date(r.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  $("receiptBody").innerHTML = [
    row("일시", `${when}${r.demo ? " (데모)" : ""}`),
    row("거리", `${(r.distance / 1000).toFixed(2)} km`),
    row("시간", clock(r.elapsed)),
    row("기본요금", `${won(r.base)}원`),
    row("주행요금", `${won(r.running)}원`),
    r.surcharge ? row("할증", `${won(r.surcharge)}원`) : "",
    r.tolls ? row("통행료", `${won(r.tolls)}원`) : "",
    r.callFee ? row("호출료", `${won(r.callFee)}원`) : "",
    row("합계", `${won(r.total)}원`, "total"),
  ].join("");
  $("dlgReceipt").showModal();
}

function openExtras(focusId = "inToll") {
  $("inToll").value = trip ? trip.tolls : extras.tolls;
  $("inCall").value = trip ? trip.callFee : extras.callFee;
  $("dlgExtras").returnValue = "";
  $("dlgExtras").showModal();
  $(focusId).focus();
}
$("dlgExtras").addEventListener("close", () => {
  if ($("dlgExtras").returnValue !== "ok") return;
  extras.tolls = Math.max(0, Math.round(+$("inToll").value || 0));
  extras.callFee = Math.max(0, Math.round(+$("inCall").value || 0));
  if (trip) { trip.tolls = extras.tolls; trip.callFee = extras.callFee; }
  render();
});
$("dlgExtras").querySelectorAll("[data-add]").forEach((b) =>
  b.addEventListener("click", () => { $("inToll").value = (+$("inToll").value || 0) + +b.dataset.add; })
);

const SETTING_FIELDS = ["baseFare", "baseDistance", "unitFare", "unitDistance", "unitTime", "outsidePct", "roundTo"];
function fillSettings(c) {
  const f = $("formSettings");
  for (const k of SETTING_FIELDS) f.elements[k].value = c[k];
  const rows = [...c.night, { from: "", to: "", pct: "" }]; // one empty row to add a band
  $("nightRows").innerHTML = rows.map((b) =>
    `<div class="row"><input type="time" value="${b.from}" aria-label="시작"><input type="time" value="${b.to}" aria-label="끝"><input type="number" min="0" inputmode="numeric" placeholder="%" value="${b.pct}" aria-label="할증률"></div>`
  ).join("");
  updateThreshold();
}
function updateThreshold() {
  const f = $("formSettings");
  const kmh = (+f.elements.unitDistance.value / +f.elements.unitTime.value) * 3.6;
  $("thrOut").textContent = Number.isFinite(kmh) ? `${kmh.toFixed(1)} km/h 미만` : "-";
}
$("formSettings").addEventListener("input", updateThreshold);
$("btnSettings").addEventListener("click", () => { fillSettings(cfg); $("dlgSettings").returnValue = ""; $("dlgSettings").showModal(); });
$("btnReset").addEventListener("click", () => fillSettings(sanitizeConfig(SEOUL_DEFAULTS)));
$("dlgSettings").addEventListener("close", () => {
  if ($("dlgSettings").returnValue !== "ok") return;
  const f = $("formSettings");
  const raw = {};
  for (const k of SETTING_FIELDS) raw[k] = f.elements[k].value;
  raw.night = [...$("nightRows").querySelectorAll(".row")].map((r) => {
    const [a, z, p] = r.querySelectorAll("input");
    return { from: a.value, to: z.value, pct: p.value };
  }).filter((b) => b.from && b.to && b.pct !== "");
  cfg = sanitizeConfig(raw);
  store.set(KEY_CFG, cfg);
  say("요금 설정을 저장했어요.");
  render();
});

function openHistory() {
  const body = $("historyBody");
  if (!history.length) { body.innerHTML = '<p class="empty">아직 운행 기록이 없어요.</p>'; }
  else {
    body.innerHTML = history.map((r) => {
      const when = new Date(r.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return `<div class="item"><span>${when}${r.demo ? " · 데모" : ""}<small>${(r.distance / 1000).toFixed(2)} km · ${clock(r.elapsed)}</small></span><b>${won(r.total)}원</b></div>`;
    }).join("");
  }
  $("dlgHistory").showModal();
}
$("btnHistory").addEventListener("click", openHistory);
$("btnClear").addEventListener("click", () => {
  if (!history.length || !confirm("운행 기록을 모두 지울까요?")) return;
  history = [];
  store.set(KEY_HIST, history);
  openHistory.call(null);
});

$("btnDemo").addEventListener("click", () => { $("dlgDemo").returnValue = ""; $("dlgDemo").showModal(); });
$("dlgDemo").addEventListener("close", () => {
  if ($("dlgDemo").returnValue !== "ok") return;
  begin("demo", { mult: +$("demoSpeed").value, clock: $("demoClock").value });
});

/* ---------- main controls ---------- */
$("kHired").addEventListener("click", () => { if (!trip) begin("gps"); });
$("kStop").addEventListener("click", () => { if (trip) finish(); });
$("kVacant").addEventListener("click", () => {
  if (trip) {
    if (confirm("운행을 취소할까요? 이 운행은 기록되지 않아요.")) abort("운행을 취소했어요.");
  } else {
    say("빈차 상태예요. '주행'을 누르면 미터가 시작돼요.");
  }
});
$("kSur").addEventListener("click", () => {
  outside = !outside;
  if (trip) trip.outside = outside;
  say(outside ? `시계외 할증 +${cfg.outsidePct}%를 적용했어요. (심야 할증은 시각에 따라 자동 적용)` : "시계외 할증을 껐어요.");
  render();
});
$("kExtra").addEventListener("click", () => openExtras("inToll"));
$("extraBtn").addEventListener("click", () => openExtras("inToll"));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Hooks for automated tests.
window.__taxi = { get trip() { return trip; }, get cfg() { return cfg; }, get gps() { return gps; }, tick, get history() { return history; }, horse };

render();
