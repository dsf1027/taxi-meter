// Scripted "drive" for the demo mode: city streets with a few stops. Pure, loops forever.
const PROFILE = [ // [seconds, km/h]
  [0, 0], [8, 30], [20, 50], [70, 50], [80, 0], [110, 0], // first red light
  [120, 30], [135, 55], [200, 55], [212, 20], [224, 0], [254, 0], // second red light
  [266, 35], [280, 60], [330, 60], [345, 25], [360, 0], [372, 0],
];
export const DEMO_PERIOD = PROFILE[PROFILE.length - 1][0];

// Speed in m/s `sec` seconds into the demo drive.
export function demoSpeed(sec) {
  const t = ((sec % DEMO_PERIOD) + DEMO_PERIOD) % DEMO_PERIOD;
  for (let i = 1; i < PROFILE.length; i++) {
    const [t1, v1] = PROFILE[i];
    if (t <= t1) {
      const [t0, v0] = PROFILE[i - 1];
      const k = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return ((v0 + (v1 - v0) * k) / 3.6);
    }
  }
  return 0;
}
