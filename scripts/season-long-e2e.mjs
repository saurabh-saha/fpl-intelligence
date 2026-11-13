// Browser E2E for the Season Long strategy: Team Builder (desktop + mobile), existing strategies, My Team horizon toggle.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
};
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const ids = (page) => page.locator('[data-testid^="player-"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid").replace("player-", ""))));

async function teamBuilder(label, viewport, shot) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${BASE}/team-builder`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="mode-season-long"]');
  // existing strategies still behave
  const base = {};
  for (const m of ["balanced", "safe", "aggressive"]) {
    await page.click(`[data-testid="mode-${m}"]`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="player-"]').length === 15);
    await page.waitForTimeout(400);
    base[m] = await ids(page);
    assert.equal(await page.locator('[data-testid="season-long-panel"]').count(), 0, `${m}: no Season Long panel`);
    assert.ok(await page.locator('[data-testid="season-long-controls"]').count() === 0, `${m}: no Season Long controls`);
  }
  assert.notDeepEqual(base.balanced, base.aggressive);
  // Season Long
  await page.click('[data-testid="mode-season-long"]');
  await page.waitForSelector('[data-testid="season-long-panel"] [data-testid="sl-table"]');
  await page.waitForTimeout(500);
  const slIds = await ids(page);
  assert.equal(slIds.length, 15);
  assert.notDeepEqual([...slIds].sort(), [...base.balanced].sort(), "Season Long picks a different squad");
  assert.match(await page.textContent('[data-testid="horizon-label"]'), /GW\s*\d+.*GW\s*38/);
  assert.match(await page.textContent('[data-testid="season-long-controls"]'), /long-term value|rest of the season|remaining season/i);
  assert.equal(await page.locator('[data-testid="sl-row-starting"]').count(), 11);
  assert.equal(await page.locator('[data-testid="sl-row-bench"]').count(), 4);
  assert.ok(await page.locator('[data-testid="sl-summary"]').isVisible());
  const th = (await page.locator('[data-testid="sl-table"] thead th').allTextContents()).join(" | ");
  for (const w of [/Price/i, /Next GW/i, /Rest of season/i, /Start/i]) assert.match(th, w);
  assert.ok((await page.locator('[data-testid="sl-limitations"]').count()) === 1);
  // horizon end change reloads
  await page.fill('[data-testid="horizon-end"]', "25");
  await page.waitForTimeout(1200);
  assert.match(await page.textContent('[data-testid="horizon-label"]'), /GW\s*25/);
  await page.click('button:has-text("Season end")');
  await page.waitForTimeout(1200);
  assert.match(await page.textContent('[data-testid="horizon-label"]'), /GW\s*38/);
  assert.ok(await noHScroll(page), `${label}: no horizontal scroll`);
  await page.screenshot({ path: `${OUT}${shot}`, fullPage: true });
  // back to Balanced restores the Balanced squad
  await page.click('[data-testid="mode-balanced"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="season-long-panel"]'));
  await page.waitForTimeout(600);
  assert.deepEqual((await ids(page)).sort(), [...base.balanced].sort(), "Balanced squad unchanged after toggling");
  await ctx.close();
  console.log(`${label}: ok`);
}

await teamBuilder("desktop", { width: 1440, height: 1100 }, "26-season-long-desktop.png");
await teamBuilder("mobile", { width: 390, height: 844 }, "27-season-long-mobile.png");

// other pages still load
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
watch(page);
for (const p of ["/", "/team-builder?strategy=season-long", "/strategies/balanced-plus", "/my-team", "/dashboard", "/players"]) {
  const r = await page.goto(`${BASE}${p}`, { waitUntil: "networkidle" });
  assert.ok(r && r.status() < 400, `${p} ${r?.status()}`);
}
await page.goto(`${BASE}/team-builder?strategy=season-long`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="season-long-panel"]');

// My Team horizon toggle (seeded imperfect squad, same approach as season-e2e)
const opt = await (await fetch(`${BASE}/api/optimize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gw: 11, mode: "safe", budget: 90 }) })).json();
const all = [...opt.starting, ...opt.bench];
const seeded = { version: 1, source: "manual", teamName: "Demo FC", actual: { gw: 11, holdings: all.map((p) => ({ id: p.id, buyTenths: p.costTenths })), bankTenths: 1000 - all.reduce((s, p) => s + p.costTenths, 0), freeTransfers: 2, chipsUsed: [] }, plans: {}, snapshots: [], recs: [], actualHistory: [], warnings: [], updatedAt: new Date().toISOString() };
const mctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await mctx.addInitScript((s) => { if (!localStorage.getItem("fpl-intelligence:season:v1")) localStorage.setItem("fpl-intelligence:season:v1", JSON.stringify(s)); }, seeded);
const mp = await mctx.newPage();
watch(mp);
await mp.goto(`${BASE}/my-team`, { waitUntil: "networkidle" });
await mp.waitForSelector('[data-testid="recommendation"]');
const five = await mp.textContent('[data-testid="transfer-recs"]');
assert.match(five, /5 GWs|next 5/i);
await mp.click('[data-testid="horizon-season"]');
await mp.waitForFunction(() => /remaining season|rest of the season|\d{2} GWs/i.test(document.querySelector('[data-testid="transfer-recs"]')?.textContent ?? ""), null, { timeout: 20000 });
await mp.waitForSelector('[data-testid="recommendation"]');
const sea = await mp.textContent('[data-testid="transfer-recs"]');
assert.match(sea, /28 GWs|remaining season|rest of the season/i);
assert.ok(["save", "transfer", "hit"].includes(await mp.getAttribute('[data-testid="recommendation"]', "data-action")));
await mp.screenshot({ path: `${OUT}28-my-team-season-long.png`, fullPage: true });
await mp.click('[data-testid="horizon-five"]');
await mp.waitForFunction(() => /5 GWs|next 5/i.test(document.querySelector('[data-testid="transfer-recs"]')?.textContent ?? ""), null, { timeout: 20000 });
console.log("my-team horizon toggle: ok");
await browser.close();
assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
console.log("SEASON LONG E2E OK");
