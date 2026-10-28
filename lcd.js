// Seven-segment LCD digits drawn as inline SVG. Unlit segments stay faintly visible (like a real
// LCD); lit ones glow. Cells are built once and only their classes change afterwards.

const SEG = {
  a: "M10 6 L14 2 L46 2 L50 6 L46 10 L14 10 Z",
  b: "M52 8 L56 12 L56 44 L52 48 L48 44 L48 12 Z",
  c: "M52 52 L56 56 L56 88 L52 92 L48 88 L48 56 Z",
  d: "M10 94 L14 90 L46 90 L50 94 L46 98 L14 98 Z",
  e: "M8 52 L12 56 L12 88 L8 92 L4 88 L4 56 Z",
  f: "M8 8 L12 12 L12 44 L8 48 L4 44 L4 12 Z",
  g: "M10 50 L14 46 L46 46 L50 50 L46 54 L14 54 Z",
};

export const GLYPHS = {
  0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg",
  "-": "g", " ": "",
};

// "12.5" -> cells [{ch:"1"}, {ch:"2", extra:"."}, {ch:"5"}], right-aligned into `n` cells.
// "02:10" -> the colon belongs to the cell before it. Returns null if it does not fit.
export function layout(text, n) {
  const cells = [];
  for (const ch of String(text)) {
    if ((ch === "." || ch === ":") && cells.length) cells[cells.length - 1].extra = ch;
    else if (ch in GLYPHS) cells.push({ ch });
    else cells.push({ ch: " " });
  }
  if (cells.length > n) return null;
  while (cells.length < n) cells.unshift({ ch: " " });
  return cells;
}

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export class Lcd {
  constructor(root, n) {
    this.root = root;
    this.n = n;
    this.cells = [];
    this.value = null;
    root.setAttribute("role", "img");
    for (let i = 0; i < n; i++) {
      const svg = el("svg", { viewBox: "0 0 68 100", class: "digit", "aria-hidden": "true" });
      const g = el("g", { class: "skew" });
      const segs = {};
      for (const [k, d] of Object.entries(SEG)) {
        segs[k] = el("path", { d, class: "seg" });
        g.appendChild(segs[k]);
      }
      const dp = el("circle", { cx: 62, cy: 94, r: 4.2, class: "seg dp" });
      const c1 = el("circle", { cx: 62, cy: 30, r: 4.2, class: "seg colon" });
      const c2 = el("circle", { cx: 62, cy: 70, r: 4.2, class: "seg colon" });
      g.append(dp, c1, c2);
      svg.appendChild(g);
      root.appendChild(svg);
      this.cells.push({ segs, dp, colon: [c1, c2], ch: null, extra: null });
    }
  }

  // Shows `text` (digits, space, '-', plus '.' / ':' attached to the previous digit).
  set(text) {
    if (text === this.value) return;
    const cells = layout(text, this.n) || layout("-".repeat(this.n), this.n); // overflow shows dashes
    this.value = text;
    this.root.dataset.value = text;
    this.root.setAttribute("aria-label", String(text));
    cells.forEach((c, i) => {
      const cell = this.cells[i];
      if (cell.ch !== c.ch) {
        const on = GLYPHS[c.ch];
        for (const [k, p] of Object.entries(cell.segs)) p.classList.toggle("on", on.includes(k));
        cell.ch = c.ch;
      }
      const extra = c.extra || null;
      if (cell.extra !== extra) {
        cell.dp.classList.toggle("on", extra === ".");
        cell.colon.forEach((d) => d.classList.toggle("on", extra === ":"));
        cell.extra = extra;
      }
    });
  }
}
