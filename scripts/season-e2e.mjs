// End-to-end test + screenshots for the Season Manager (/my-team). Requires the app running and Google Chrome.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const num = (t) => parseFloat(String(t).replace(/[^0-9.\-]/g, ""));

// A deliberately imperfect starting squad (budget-capped, spare cash) so there is something to recommend.
const opt = await (await fetch(`${BASE}/api/optimize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gw: 11, mode: "safe", budget: 90 }) })).json();
const all = [...opt.starting, ...opt.bench];
const seeded = {
  version: 1, source: "manual", teamName: "Demo FC",
  actual: { gw: 11, holdings: all.map((p) => ({ id: p.id, buyTenths: p.costTenths })), bankTenths: 1000 - all.reduce((s, p) => s + p.costTenths, 0), freeTransfers: 2, chipsUsed: [] },
  plans: {}, snapshots: [], recs: [], actualHistory: [], warnings: [], updatedAt: new Date().toISOString(),
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.accept());
const shot = async (n, p = page, o = {}) => { await p.waitForTimeout(500); await p.screenshot({ path: `${OUT}${n}.png`, ...o }); console.log("saved", n); };

// 1. Onboarding + import error handling (real FPL API: unknown team)
await page.goto(`${BASE}/my-team`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="onboarding"]');
await page.fill('[data-testid="team-id"]', "999999999");
await page.click('[data-testid="import-btn"]');
await page.waitForSelector('[data-testid="import-error"]');
assert.match(await page.textContent('[data-testid="import-error"]'), /No FPL team found|updating|returned/);
await shot("14-season-onboarding");

// 2. Seed the demo squad and open the manager
await page.addInitScript((s) => { if (!localStorage.getItem("fpl-intelligence:season:v1")) localStorage.setItem("fpl-intelligence:season:v1", JSON.stringify(s)); }, seeded);
await page.goto(`${BASE}/my-team`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="season-summary"]');
await page.waitForSelector('[data-testid="recommendation"]');
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
assert.equal((await page.textContent('[data-testid="s-ft"]')).trim().startsWith("2"), true);
const action = await page.getAttribute('[data-testid="recommendation"]', "data-action");
console.log("recommendation action:", action);
assert.ok(["transfer", "hit"].includes(action), "imperfect squad should get a transfer recommendation");
const ep0 = num(await page.textContent('[data-testid="s-ep"]'));
await page.waitForTimeout(1500);
await shot("15-season-manager");

// 3. Accept a recommendation -> proposed squad changes, actual untouched
await page.locator('[data-testid="accept"]').first().click();
await page.waitForSelector('[data-testid="transfer-card"][data-state="accepted"]');
await page.waitForSelector('[data-testid="s-delta"]');
const ep1 = num(await page.textContent('[data-testid="s-ep"]'));
console.log("EP before/after accept", ep0, ep1);
assert.ok(ep1 > ep0, "accepting an improving transfer raises projected points");
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("fpl-intelligence:season:v1")));
assert.equal(JSON.stringify(stored.actual.holdings), JSON.stringify(seeded.actual.holdings), "actual squad must never be overwritten by a recommendation");
assert.equal(stored.plans["11"].transfers.length, 1);
await shot("16-transfer-accepted");

// 4. Restore original squad
await page.click('[data-testid="mt-restore"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="s-delta"]'));
assert.equal(num(await page.textContent('[data-testid="s-ep"]')), ep0);

// 5. Click a player: replacement panel with selling-price aware alternatives
await page.locator('[data-testid="row-MID"] [data-testid^="player-"]').first().click();
await page.click('[data-testid="tab-replace"]');
await page.waitForSelector('[data-testid^="alt-"]');
await shot("17-season-replacement-panel");
await page.locator('[data-testid^="swap-"]').first().click();
await page.waitForSelector('[data-testid="panel"]', { state: "detached" });
await page.waitForSelector('[data-testid="s-bank"]');
await page.click('[data-testid="mt-undo"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="s-delta"]'));

// 6. Chips: Bench Boost, Free Hit, Wildcard, one chip only
await page.waitForSelector('[data-testid="chip-bboost"]');
await page.click('[data-testid="play-bboost"]');
await page.waitForSelector('[data-testid="s-chip"]');
const bb = num(await page.textContent('[data-testid="s-ep"]'));
assert.ok(bb > ep0 + 3, "Bench Boost adds the bench's points");
assert.ok(await page.locator('[data-testid="play-3xc"]').isDisabled(), "only one chip per gameweek");
await shot("18-chip-strategy");
await page.click('[data-testid="cancel-bboost"]');
await page.click('[data-testid="play-freehit"]');
await page.waitForSelector('[data-testid="mt-fh-banner"]');
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
await shot("19-free-hit");
await page.click('[data-testid="cancel-freehit"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="mt-fh-banner"]'));
await page.click('[data-testid="play-wildcard"]');
await page.waitForSelector('[data-testid="s-chip"]');
assert.match(await page.textContent('[data-testid="s-ft"]'), /unlimited/);
await page.click('[data-testid="cancel-wildcard"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="s-chip"]'));

// 7. Accept, then plan ahead (GW12 carries the accepted transfer)
await page.locator('[data-testid="accept"]').first().click();
await page.waitForSelector('[data-testid="s-delta"]');
await page.click('[data-testid="mt-gw-12"]');
await page.waitForSelector('[data-testid="mt-ahead"]');
await page.waitForSelector('[data-testid="recommendation"]');
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
await shot("20-plan-ahead-gw12");

// 8. Lock in GW11 -> actual advances to GW12, snapshot keeps the prediction
await page.click('[data-testid="mt-gw-11"]');
await page.waitForSelector('[data-testid="lock-in"]:not([disabled])');
await page.click('[data-testid="lock-in"]');
await page.waitForSelector('[data-testid="snapshot-row"]');
const after = await page.evaluate(() => JSON.parse(localStorage.getItem("fpl-intelligence:season:v1")));
assert.equal(after.actual.gw, 12);
assert.equal(after.snapshots.length, 1);
assert.ok(after.snapshots[0].predictedEp > 30);
assert.equal(after.snapshots[0].transfers.length, 1);
await page.fill('input[aria-label="Actual points GW11"]', "52");
await page.waitForSelector('[data-testid="accuracy-line"]');
await shot("21-predicted-vs-actual", page, { fullPage: true });

// 9. Persistence
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="season-summary"]');
assert.match(await page.textContent('[data-testid="mt-deadline"]'), /GW12/);

// 10. Mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
const mp = await m.newPage();
await mp.addInitScript((s) => localStorage.setItem("fpl-intelligence:season:v1", JSON.stringify(s)), seeded);
await mp.goto(`${BASE}/my-team`, { waitUntil: "networkidle" });
await mp.waitForSelector('[data-testid="recommendation"]');
await mp.waitForTimeout(1200);
await mp.screenshot({ path: `${OUT}22-season-mobile.png` });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 1, `no horizontal scroll on mobile (${overflow}px)`);

await browser.close();
assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
console.log("SEASON E2E OK");
