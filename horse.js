// The horse icon on the display. Like the little LCD icon on a real meter, the horse itself never
// moves: its body is always lit, and the legs are a handful of fixed "segments" (one set per pose).
// While the car drives, the sets light up one after another; the faster the car, the faster the
// sequence. When the car stops, the standing legs are lit. The other sets stay as faint "unlit
// segments".

// Strides per second for a car speed in km/h. Zero when (almost) stopped.
export function strideHz(kmh) {
  if (!(kmh >= 0.5)) return 0;
  return Math.min(5, 1.0 + kmh * 0.06);
}

const TAU = Math.PI * 2;
// When each leg is in the same phase of its stride (in cycles): hind legs together, then the front pair.
const OFFSETS = { rl: 0.0, rr: 0.12, fl: 0.46, fr: 0.58 };

// Joint angles in degrees for a phase (in cycles, any real number) and an amplitude 0..1.
// thigh > 0 swings the leg forward; shin <= 0 folds the lower leg backwards.
export function pose(phase, amp) {
  const leg = (off, swing) => {
    const a = TAU * (phase + off);
    return { thigh: swing * amp * Math.sin(a), shin: -62 * amp * Math.max(0, Math.cos(a)) ** 1.2 };
  };
  return {
    rl: leg(OFFSETS.rl, 34),
    rr: leg(OFFSETS.rr, 34),
    fl: leg(OFFSETS.fl, 40),
    fr: leg(OFFSETS.fr, 40),
  };
}

export const FRAMES = 4; // running poses per stride
const FRAME_PHASES = [0.08, 0.33, 0.58, 0.83]; // chosen so the four poses look clearly different
export const HIPS = { rl: [46, 37], rr: [38, 37], fl: [68, 37], fr: [74, 37] };
const THIGH = 15, SHIN = 17, HOOF = 4.5;

// SVG path of one leg: hip -> knee -> foot, plus a small hoof tick. Angles in degrees.
export function legPath([hx, hy], thigh, shin) {
  const a = (thigh * Math.PI) / 180;
  const b = ((thigh + shin) * Math.PI) / 180;
  const kx = hx + THIGH * Math.sin(a), ky = hy + THIGH * Math.cos(a);
  const fx = kx + SHIN * Math.sin(b), fy = ky + SHIN * Math.cos(b);
  const tx = fx + HOOF * Math.cos(b), ty = fy - HOOF * Math.sin(b);
  const f = (n) => n.toFixed(1);
  return `M${f(hx)} ${f(hy)} L${f(kx)} ${f(ky)} L${f(fx)} ${f(fy)} L${f(tx)} ${f(ty)}`;
}

// The four leg paths of a frame: 0..FRAMES-1 for running, "stand" for the standing pose.
export function framePaths(frame) {
  const p = frame === "stand" ? pose(0, 0) : pose(FRAME_PHASES[frame], 1);
  return ["rl", "rr", "fl", "fr"].map((k) => legPath(HIPS[k], p[k].thigh, p[k].shin));
}

// Which running frame is lit at a phase (in cycles).
export function frameAt(phase) {
  const x = ((phase % 1) + 1) % 1;
  return Math.min(FRAMES - 1, Math.floor(x * FRAMES));
}

const NS = "http://www.w3.org/2000/svg";

export class Horse {
  constructor(svg) {
    this.sets = new Map();
    const legs = svg.querySelector("#legs");
    for (const name of ["stand", ...Array.from({ length: FRAMES }, (_, i) => i)]) {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "legset");
      g.dataset.frame = String(name);
      for (const d of framePaths(name)) {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", d);
        g.appendChild(p);
      }
      legs.appendChild(g);
      this.sets.set(name, g);
    }
    this.lit = null;
    this.target = 0; // km/h
    this.hz = 0; // strides per second, eased towards the target
    this.phase = 0;
    this.raf = 0;
    this.last = 0;
    this.light("stand");
  }

  light(name) {
    if (this.lit === name) return;
    if (this.lit !== null) this.sets.get(this.lit).classList.remove("on");
    this.sets.get(name).classList.add("on");
    this.lit = name;
  }

  setSpeed(kmh) {
    this.target = Math.max(0, kmh);
    if (!this.raf && (this.target >= 0.5 || this.hz > 0)) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  frame(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    // ease towards the target rate so the gallop "winds up" and winds down instead of jumping
    this.hz += (strideHz(this.target) - this.hz) * Math.min(1, dt * 2.5);
    if (this.target < 0.5 && this.hz < 0.25) {
      this.hz = 0;
      this.light("stand");
      this.raf = 0;
      return;
    }
    this.phase = (this.phase + this.hz * dt) % 1000;
    this.light(frameAt(this.phase));
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }
}
