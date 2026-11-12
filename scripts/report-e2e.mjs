// Final end-to-end test: Download GW Report from Team Builder and My Team in a real browser, then validate the
// downloaded PDF's contents against what was on screen. Requires the app running and Google Chrome.
import { chromium } from "playwright-core";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { readPdf } from "./lib/pdf-extract.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const SAMPLES = new URL("../docs/samples/", import.meta.url).pathname;
const tmp = mkdtempSync(path.join(tmpdir(), "fpl-report-"));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.accept());
const displayedIds = async () => (await page.locator('[data-testid^="player-"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid").replace("player-", "")))));

/* ============ 1. Team Builder: edit the squad, then download ============ */
await page.goto(`${BASE}/team-builder?gw=11`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="pitch"]');
await page.waitForSelector('[data-testid="download-report"]');
const generated = await displayedIds();
assert.equal(generated.length, 15);
// replace a midfielder via the UI so the on-screen squad differs from a fresh optimisation
await page.locator('[data-testid="row-MID"] [data-testid^="player-"]').first().click();
await page.click('[data-testid="tab-replace"]');
await page.waitForSelector('[data-testid^="swap-"]');
await page.locator('[data-testid^="swap-"]').nth(4).click();
await page.waitForSelector('[data-testid="panel"]', { state: "detached" });
await page.waitForSelector('[data-testid="restore"]:not([disabled])');
const onScreen = await displayedIds();
const added = onScreen.filter((x) => !generated.includes(x));
assert.equal(added.length, 1, "exactly one player was swapped on screen");
const epOnScreen = parseFloat(await page.textContent('[data-testid="ep"]'));
const names = await page.locator('[data-testid^="player-"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").split(",")[0]));
await page.screenshot({ path: `${OUT}23-download-report-button.png` });

const [dl1] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="download-report"]')]);
assert.match(dl1.suggestedFilename(), /^fpl-gw11-builder-report\.pdf$/);
const f1 = path.join(tmp, dl1.suggestedFilename());
await dl1.saveAs(f1);
await page.waitForSelector('[data-testid="report-msg"]');
assert.match(await page.textContent('[data-testid="report-msg"]'), /Downloaded fpl-gw11-builder-report\.pdf/);
const r1 = await readPdf(f1);
console.log(`Team Builder PDF: ${r1.pages} pages, ${(r1.size / 1024).toFixed(0)} KB`);
assert.equal(r1.title, "Gameweek 11 Intelligence Report");
// exactly the on-screen squad (same ids), NOT a newly generated one
assert.deepEqual([...r1.json.players.map((p) => p.id)].sort((x, y) => x - y), [...onScreen].sort((x, y) => x - y));
assert.ok(r1.json.players.some((p) => p.id === added[0]), "swapped-in player is in the report");
assert.equal(r1.json.userEditsVsGeneratedSquad.added.length, 1);
assert.ok(Math.abs(r1.json.squad.projectedPoints - epOnScreen) < 0.06, `projected points match the screen (${r1.json.squad.projectedPoints} vs ${epOnScreen})`);
for (const n of names) assert.ok(r1.text.includes(n), `PDF text contains ${n}`);
assert.equal(r1.json.players.length, 15);
assert.equal(r1.json.players.filter((p) => p.role === "starting").length, 11);
assert.equal(r1.json.players.filter((p) => p.isCaptain).length, 1);
for (const h of ["Starting XI", "Bench (in substitution order)", "Expected-points breakdown", "Fixtures and expected points", "Replacement shortlist", "Model, confidence", "Structured data"]) assert.ok(r1.text.includes(h), h);
copyFileSync(f1, `${SAMPLES}gw11-team-builder-report.pdf`);

/* ============ 2. My Team: accept a transfer, then download ============ */
const opt = await (await fetch(`${BASE}/api/optimize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gw: 11, mode: "safe", budget: 90 }) })).json();
const all = [...opt.starting, ...opt.bench];
const seeded = { version: 1, source: "manual", teamName: "Demo FC", actual: { gw: 11, holdings: all.map((p) => ({ id: p.id, buyTenths: p.costTenths })), bankTenths: 1000 - all.reduce((s, p) => s + p.costTenths, 0), freeTransfers: 2, chipsUsed: [] }, plans: {}, snapshots: [], recs: [], actualHistory: [], warnings: [], updatedAt: new Date().toISOString() };
await page.addInitScript((s) => { if (!localStorage.getItem("fpl-intelligence:season:v1")) localStorage.setItem("fpl-intelligence:season:v1", JSON.stringify(s)); }, seeded);
await page.goto(`${BASE}/my-team`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="recommendation"]');
const actualIds = seeded.actual.holdings.map((h) => h.id);
await page.locator('[data-testid="accept"]').first().click();
await page.waitForSelector('[data-testid="s-delta"]');
await page.waitForTimeout(600);
const proposedOnScreen = await displayedIds();
assert.notDeepEqual([...proposedOnScreen].sort((x, y) => x - y), [...actualIds].sort((x, y) => x - y), "plan changed the displayed squad");
const epMy = parseFloat(await page.textContent('[data-testid="s-ep"]'));
await page.screenshot({ path: `${OUT}24-my-team-download-report.png` });

const [dl2] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="download-report"]')]);
assert.match(dl2.suggestedFilename(), /^fpl-gw11-my-team-report\.pdf$/);
const f2 = path.join(tmp, dl2.suggestedFilename());
await dl2.saveAs(f2);
const r2 = await readPdf(f2);
console.log(`My Team PDF: ${r2.pages} pages, ${(r2.size / 1024).toFixed(0)} KB`);
assert.deepEqual([...r2.json.players.map((p) => p.id)].sort((x, y) => x - y), [...proposedOnScreen].sort((x, y) => x - y), "PDF players == proposed squad on screen");
assert.deepEqual([...r2.json.season.actualSquad.playerIds].sort((x, y) => x - y), [...actualIds].sort((x, y) => x - y), "PDF lists the unchanged actual squad");
assert.equal(r2.json.season.proposedPlan.transfers.length, 1);
assert.ok(Math.abs(r2.json.squad.projectedPoints - epMy) < 0.06, "projected points match the screen");
assert.ok(["save", "transfer", "hit"].includes(r2.json.transferRecommendations.decision));
assert.equal(r2.json.chipStrategy.length, 4);
for (const h of ["Actual squad vs proposed plan", "Transfer recommendations (MODEL)", "Chip strategy (MODEL)"]) assert.ok(r2.text.includes(h), h);
assert.ok(r2.text.includes(r2.json.season.proposedPlan.transfers[0].buy) && r2.text.includes(r2.json.season.proposedPlan.transfers[0].sell));
// the actual squad in storage is untouched by downloading
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("fpl-intelligence:season:v1")));
assert.deepEqual(stored.actual.holdings, seeded.actual.holdings);
copyFileSync(f2, `${SAMPLES}gw11-my-team-report.pdf`);

/* ============ 3. My Team with Free Hit planned: PDF == temporary squad, actual untouched ============ */
await page.click('[data-testid="mt-restore"]');
await page.click('[data-testid="play-freehit"]');
await page.waitForSelector('[data-testid="mt-fh-banner"]');
await page.waitForTimeout(600);
const fhOnScreen = await displayedIds();
const [dl3] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="download-report"]')]);
const f3 = path.join(tmp, "fh.pdf");
await dl3.saveAs(f3);
const r3 = await readPdf(f3);
assert.deepEqual([...r3.json.players.map((p) => p.id)].sort((x, y) => x - y), [...fhOnScreen].sort((x, y) => x - y));
assert.equal(r3.json.season.chipPlannedThisGameweek, "freehit");
assert.deepEqual([...r3.json.season.actualSquad.playerIds].sort((x, y) => x - y), [...actualIds].sort((x, y) => x - y));

/* ============ 4. Mobile: button is reachable ============ */
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const mp = await m.newPage();
await mp.goto(`${BASE}/team-builder?gw=11`, { waitUntil: "networkidle" });
await mp.waitForSelector('[data-testid="download-report"]');
assert.ok(await mp.locator('[data-testid="download-report"]').isVisible());

await browser.close();
assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
console.log("REPORT E2E OK");
