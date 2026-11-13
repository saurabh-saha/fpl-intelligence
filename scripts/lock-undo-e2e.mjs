// Browser E2E for "Undo last Lock in". Requires the app running and Google Chrome.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const opt = await (await fetch(`${BASE}/api/optimize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gw: 11, mode: "safe", budget: 90 }) })).json();
const all = [...opt.starting, ...opt.bench];
const seeded = { version: 1, source: "manual", teamName: "Demo FC", actual: { gw: 11, holdings: all.map((p) => ({ id: p.id, buyTenths: p.costTenths })), bankTenths: 1000 - all.reduce((s, p) => s + p.costTenths, 0), freeTransfers: 2, chipsUsed: [] }, plans: {}, snapshots: [], recs: [], actualHistory: [], warnings: [], updatedAt: new Date().toISOString() };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((s) => { if (!localStorage.getItem("fpl-intelligence:season:v1")) localStorage.setItem("fpl-intelligence:season:v1", JSON.stringify(s)); }, seeded);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("fpl-intelligence:season:v1")));

await page.goto(`${BASE}/my-team`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="recommendation"]');
assert.equal(await page.getAttribute('[data-testid="mt-undo"]', "title"), "Make a squad edit to enable Undo.");
assert.equal(await page.getAttribute('[data-testid="mt-restore"]', "title"), "No proposed changes to restore.");
assert.ok(await page.locator('[data-testid="undo-lock"]').isDisabled());
assert.match(await page.textContent('[data-testid="undo-lock-why"]'), /No recent lock-in to undo\./);
const before = await stored();

await page.click('[data-testid="lock-in"]');
await page.waitForFunction(() => document.querySelector('[data-testid="mt-gw-12"]')?.getAttribute("aria-selected") === "true");
assert.match(dialogs[0], /does NOT make any transfers on the official FPL website/);
assert.match(dialogs[0], /Undo last Lock in/);
let s = await stored();
assert.equal(s.actual.gw, 12);
assert.equal(s.lockHistory.length, 1);
assert.equal(s.lockHistory[0].gw, 11);
assert.ok(await page.locator('[data-testid="undo-lock"]').isEnabled());
assert.match(await page.textContent('[data-testid="lock-history-list"]'), /GW11 locked in.*can undo/);

await page.click('[data-testid="undo-lock"]');
await page.waitForFunction(() => document.querySelector('[data-testid="mt-gw-11"]')?.getAttribute("aria-selected") === "true");
assert.match(dialogs[1], /Undo the lock-in of GW11/);
assert.match(dialogs[1], /does not change your official FPL team/);
await page.waitForSelector('[data-testid="recommendation"]');
s = await stored();
assert.equal(s.actual.gw, 11);
assert.deepEqual(s.actual, before.actual);
assert.deepEqual(s.snapshots, before.snapshots);
assert.deepEqual(s.plans, before.plans);
assert.deepEqual(s.lockHistory, []);
assert.ok(await page.locator('[data-testid="undo-lock"]').isDisabled(), "cannot undo twice");
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
// reload: nothing is rolled back silently, state persists
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="recommendation"]');
assert.equal((await stored()).actual.gw, 11);
await browser.close();
assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
console.log("LOCK UNDO E2E OK");
