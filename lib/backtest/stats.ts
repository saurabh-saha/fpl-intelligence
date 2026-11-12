export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const variance = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};
export const sd = (xs: number[]) => Math.sqrt(variance(xs));

/** Two-sided 97.5% Student-t quantile (exact table up to df=30, then 1.96 + small correction). */
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
export const t975 = (df: number) => (df <= 30 ? T975[df] : df <= 60 ? 2.0 : df <= 120 ? 1.98 : 1.96);

export function tInterval(xs: number[]): { mean: number; lo: number; hi: number; se: number; n: number } {
  const n = xs.length;
  const m = mean(xs);
  const se = sd(xs) / Math.sqrt(n);
  const h = n > 1 ? t975(n - 1) * se : NaN;
  return { mean: m, lo: m - h, hi: m + h, se, n };
}

/** Exact two-sided sign test (ties dropped). */
export function signTest(diffs: number[]): { wins: number; losses: number; ties: number; p: number } {
  const wins = diffs.filter((d) => d > 1e-9).length;
  const losses = diffs.filter((d) => d < -1e-9).length;
  const n = wins + losses;
  if (n === 0) return { wins, losses, ties: diffs.length, p: 1 };
  const k = Math.min(wins, losses);
  let p = 0;
  let c = 1; // C(n,0)
  for (let i = 0; i <= k; i++) { p += c; c = (c * (n - i)) / (i + 1); }
  p = Math.min(1, (2 * p) / 2 ** n);
  return { wins, losses, ties: diffs.length - n, p };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Moving-block bootstrap CI for the mean of a serially dependent series (overlapping windows).
 * `series` = list of independent blocks of ordered values (e.g. one per season); blocks of length `len` are resampled.
 */
export function blockBootstrapCI(series: number[][], len = 5, B = 5000, seed = 12345): { lo: number; hi: number; mean: number } {
  const rnd = mulberry32(seed);
  const all = series.flat();
  const means: number[] = [];
  const total = all.length;
  const starts: { s: number; i: number }[] = [];
  series.forEach((s, si) => { for (let i = 0; i + len <= s.length; i++) starts.push({ s: si, i }); });
  for (let b = 0; b < B; b++) {
    const sample: number[] = [];
    while (sample.length < total) {
      const st = starts[Math.floor(rnd() * starts.length)];
      for (let j = 0; j < len && sample.length < total; j++) sample.push(series[st.s][st.i + j]);
    }
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * B)], hi: means[Math.floor(0.975 * B)], mean: mean(all) };
}

/** Average rank per row (1 = best), ties share the mean rank. */
export function ranks(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out = new Array(values.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && Math.abs(idx[j + 1].v - idx[i].v) < 1e-9) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = r;
    i = j + 1;
  }
  return out;
}
