// The galloping horse on the display. `strideHz` / `pose` are pure (and tested); `Horse` drives an
// SVG with them: it speeds up gradually as the car speeds up and settles into a standing pose when
// the car stops.

// Strides per second for a car speed in km/h. Zero when (almost) stopped.
export function strideHz(kmh) {
  if (!(kmh >= 0.5)) return 0;
  return Math.min(5, 1.0 + kmh * 0.06);
}

// How big the leg swing is (0..1) for a speed in km/h; a slow walk is gentler than a sprint.
export function ampFor(kmh) {
  if (!(kmh >= 0.5)) return 0;
  return Math.min(1, 0.45 + kmh / 90);
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
    bob: -2.4 * amp * Math.abs(Math.sin(TAU * (phase + 0.05))), // body rises twice per stride
    head: 5 * amp * Math.sin(TAU * (phase + 0.1)),
    tail: 10 * amp * Math.sin(TAU * (phase - 0.15)),
    rl: leg(OFFSETS.rl, 34),
    rr: leg(OFFSETS.rr, 34),
    fl: leg(OFFSETS.fl, 40),
    fr: leg(OFFSETS.fr, 40),
  };
}

export class Horse {
  constructor(svg) {
    const q = (id) => svg.querySelector(`[data-j="${id}"]`);
    this.j = {
      body: q("body"), head: q("head"), tail: q("tail"),
      rl: [q("rl-thigh"), q("rl-shin")], rr: [q("rr-thigh"), q("rr-shin")],
      fl: [q("fl-thigh"), q("fl-shin")], fr: [q("fr-thigh"), q("fr-shin")],
    };
    this.target = 0; // km/h
    this.hz = 0;
    this.amp = 0;
    this.phase = 0;
    this.raf = 0;
    this.last = 0;
    this.draw();
  }

  setSpeed(kmh) {
    this.target = Math.max(0, kmh);
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  frame(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    // ease towards the target so the horse "gets into" the gallop and winds down when the car stops
    this.hz += (strideHz(this.target) - this.hz) * Math.min(1, dt * 2.5);
    this.amp += (ampFor(this.target) - this.amp) * Math.min(1, dt * 5);
    this.phase = (this.phase + this.hz * dt) % 1000;
    this.draw();
    const settled = this.target < 0.5 && this.hz < 0.03 && this.amp < 0.01;
    if (settled) {
      this.hz = 0; this.amp = 0;
      this.draw();
      this.raf = 0;
    } else {
      this.raf = requestAnimationFrame((n) => this.frame(n));
    }
  }

  draw() {
    const p = pose(this.phase, this.amp);
    const set = (el, deg, cx = 0, cy = 0) => el && el.setAttribute("transform", `rotate(${(-deg).toFixed(1)} ${cx} ${cy})`);
    this.j.body.setAttribute("transform", `translate(0 ${p.bob.toFixed(2)})`);
    set(this.j.head, p.head, 84, 20);
    set(this.j.tail, p.tail, 30, 27);
    for (const k of ["rl", "rr", "fl", "fr"]) {
      set(this.j[k][0], p[k].thigh);
      set(this.j[k][1], p[k].shin);
    }
    this.pose = p;
  }
}
