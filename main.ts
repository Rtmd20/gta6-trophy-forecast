// GTA VI trophy rarity forecast (gta6-trophy-rarity-forecast-01).
//
// Forecasts every trophy's Exophase earn rate at the case's target as five
// quantiles (5/25/50/75/95%), scored by pinball loss on the logit scale.
//
// Method — all in logit space (rates clamped to 0.01..99.99, as the scorer
// does), against x = ln(1 + hours since launch, 2026-11-19T00:00:00Z):
//   1. Per trophy, a weighted least-squares line of logit(rate) on x, with
//      weights halving every 24h, so recent reads count most. Launch-week
//      earn rates rise fast then flatten, and log-time is the scale on
//      which that curve is close to straight; it is also the house curve
//      baseline's form, so this starts where it does and goes further.
//   2. The slope is shrunk by |b| / (|b| + se_b): a noisy or flat history
//      (the practice cases have literally identical reads) falls back to
//      persistence instead of extrapolating noise. The extrapolated move
//      from the last read is capped (CAP grows slowly with horizon), so a
//      steep early slope cannot run the median to 0 or 100.
//   3. The spread is honest uncertainty, not a fixed band: the random-walk
//      term (0.5*sqrt(days), the house baseline's), the fit's residual,
//      the uncertainty of extrapolating the trend past the observed window,
//      and a refresh term (Exophase refreshes its counts in jumps — the
//      launch-night refresh moved every rate at once — so the band must
//      cover a jump the history has not shown). Rare trophies get a wider
//      floor, near-saturated ones wider still.
//   4. The one trophy at 100% in every read ("Just Like Paradise") is
//      special: logit(100) is a wall, and a week of new players joining
//      can only dilute it, never raise it. Its median is set at 99.5 with
//      a wide lower tail instead of a degenerate 99.99 everywhere.
// Everything is a fixed function of the case file: no randomness, no
// clock, no network. Two runs on the same case write byte-identical files.
//
// Standard library only. Node 22: `node main.ts`.
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, in logit units per square-root day (house baseline). */
const SIGMA_RW = 0.5;
/** Extra spread for Exophase refresh jumps, per square-root day. */
const SIGMA_REFRESH = 0.35;
/** A refresh can move every rate at once even over a short horizon
 * (the launch-night refresh cut most rates to about a quarter), so the
 * spread also carries this horizon-independent jump allowance. */
const SIGMA_JUMP = 0.55;
/** Downward median shift (logit units) when every read is identical:
 * the page was stale, and the one refresh ever observed diluted rates. */
const REFRESH_SHIFT = 0.5;
/** Recency half-life for the trend fit, in hours. */
const HALF_LIFE_HOURS = 24;

interface Trophy {
  id: number;
  name: string;
  tier: string;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { release_date: string };
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const sigmoid = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Weighted least squares of y on x. Returns slope, intercept, the
 * residual standard deviation and the slope's standard error, or null
 * when the points cannot define a line (fewer than 3, or no spread in x).
 */
function wls(
  xs: number[],
  ys: number[],
  ws: number[],
): { slope: number; intercept: number; residSd: number; slopeSe: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    sw += ws[i];
    mx += ws[i] * xs[i];
    my += ws[i] * ys[i];
  }
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += ws[i] * (xs[i] - mx) * (xs[i] - mx);
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-12) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    sse += ws[i] * r * r;
  }
  // Weighted residual variance, with the usual (n - 2) denominator.
  const residVar = Math.max(0, sse / sw) * (n / Math.max(1, n - 2));
  const residSd = Math.sqrt(residVar);
  const slopeSe = Math.sqrt(residVar / sxx);
  return { slope, intercept, residSd, slopeSe };
}

/** One trophy's forecast row: five quantiles in percent. */
function forecastTrophy(
  points: Array<{ x: number; y: number; t: number }>,
  lastRate: number,
  xTarget: number,
  xLast: number,
  horizonDays: number,
): number[] {
  const lastLogit = logit(lastRate);

  // The trophy every read puts at 100%: only dilution can move it, so
  // forecast a high median with a real lower tail instead of a wall.
  if (lastRate >= 99.9) {
    const med = logit(99.5);
    const sigma = 1.5;
    return Z.map((z) => round4(clamp(sigmoid(med + z * sigma))));
  }

  let medianLogit = lastLogit;
  let residSd = 0;
  let trendUnc = 0;
  // True when every read shows the same rate: the page was stale the
  // whole window, so the next refresh is the only news — and the one
  // refresh the house ever saw cut every rate (tracked players grew
  // ~6x while earners grew ~1.5x), so the median is shifted down
  // instead of just widened. A history with real movement never
  // triggers this: its trend fit speaks for itself.
  const allEqual =
    points.length >= 3 &&
    points.every((p) => Math.abs(p.y - points[0].y) < 1e-9);
  if (allEqual) medianLogit -= REFRESH_SHIFT;
  if (points.length >= 3) {
    const tLast = points[points.length - 1].t;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const ws = points.map((p) => Math.pow(0.5, (tLast - p.t) / HALF_LIFE_HOURS));
    const fit = wls(xs, ys, ws);
    if (fit !== null) {
      // Shrink the slope toward 0 when its standard error is large
      // relative to the slope itself: a weak signal is not a trend.
      const shrink = Math.abs(fit.slope) / (Math.abs(fit.slope) + fit.slopeSe + 1e-9);
      const slopeS = fit.slope * shrink;
      const pred = fit.intercept + slopeS * xTarget;
      // Cap how far the median may travel from the last read: the trend
      // is a guide, not a licence to run to 0 or 100.
      const cap = 1.5 + 0.6 * Math.sqrt(horizonDays);
      medianLogit = lastLogit + Math.max(-cap, Math.min(cap, pred - lastLogit));
      residSd = fit.residSd;
      trendUnc = 0.5 * Math.abs(slopeS) * Math.max(0, xTarget - xLast);
    }
  }

  // Honest spread: random walk + fit residual + trend-extrapolation
  // uncertainty + refresh jumps, combined in quadrature.
  let sigma = Math.sqrt(
    Math.pow(SIGMA_RW * Math.sqrt(horizonDays), 2) +
      Math.pow(residSd, 2) +
      Math.pow(trendUnc, 2) +
      Math.pow(SIGMA_REFRESH * Math.sqrt(horizonDays), 2) +
      Math.pow(SIGMA_JUMP, 2),
  );
  if (sigma < 0.4) sigma = 0.4;
  if (lastRate <= 0.2) sigma = Math.max(sigma, 0.7); // rare: few earners, noisy
  if (lastRate >= 90) sigma = Math.max(sigma, 1.0); // near-saturated: dilution risk
  if (sigma > 2.5) sigma = 2.5;

  return Z.map((z) => round4(clamp(sigmoid(medianLogit + z * sigma))));
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);

  const launch = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const xOf = (iso: string): number =>
    Math.log(1 + Math.max(0, (Date.parse(iso) - launch) / 3_600_000));
  const xTarget = xOf(c.target);
  const horizonDays = c.horizon_minutes / 1440;

  const trophies = c.trophies.map((t, i) => {
    // This trophy's reads, oldest first, skipping reads that lack it.
    const points: Array<{ x: number; y: number; t: number }> = [];
    let lastRate: number | null = null;
    for (const read of c.history) {
      const r = read.rates[i];
      if (r === null || r === undefined) continue;
      points.push({ x: xOf(read.at), y: logit(r), t: Date.parse(read.at) });
      lastRate = r;
    }
    if (lastRate === null) lastRate = 1; // no read ever listed it: a neutral guess
    const xLast = points.length > 0 ? points[points.length - 1].x : xOf(c.at);
    return { id: t.id, q: forecastTrophy(points, lastRate, xTarget, xLast, horizonDays) };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
