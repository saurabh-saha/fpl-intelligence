// Browser E2E for the Balanced Plus strategy page and its PDF. Requires the app running and Google Chrome.
import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { readPdf } from "./lib/pdf-extract.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const tmp = mkdtempSync(path.join(tmpdir(), "fpl-bp-"));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

await page.goto(`${BASE}/strategies/balanced-plus`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="bp-compare"]');
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
const cols = await page.locator('[data-testid="bp-compare"] thead th').allTextContents();
assert.deepEqual(cols.map((c) => c.trim()).filter(Boolean), ["Balanced", "Safe", "Aggressive", "Balanced Plus"]);
for (const k of ["balanced", "safe", "aggressive"]) assert.ok(await page.locator(`[data-testid="bp-changes-${k}"]`).count(), `changes vs ${k}`);
assert.match(await page.textContent('[data-testid="bp-xpts-note"]'), /not.*the Balanced Plus objective/s);
assert.ok(await page.locator('[data-testid="bp-objective"] tbody tr').count() === 15, "objective table lists all 15 players");
assert.match(await page.textContent('[data-testid="bp-validation"]'), /no advantage over Balanced is established/i);
assert.ok((await page.locator('[data-testid="bp-limitations"] li').count()) >= 5, "limitations visible");
const swapCount = await page.locator('[data-testid="bp-swap"]').count();
assert.ok(swapCount >= 6, `swaps listed (${swapCount})`);
// club cap visible in the comparison: Balanced Plus row shows 2, others show 3
const clubRow = (await page.locator('[data-testid="bp-compare"] tr', { hasText: "Max from one club in XI" }).first().innerText()).replace(/\s+/g, " ");
assert.match(clubRow, /3.*3.*3.*2/);
await page.locator('[data-testid="bp-swap"] summary').first().click();
await page.screenshot({ path: `${OUT}25-balanced-plus.png`, fullPage: true });

const ids = await page.locator('[data-testid^="player-"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid").replace("player-", ""))));
const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="download-bp-report"]')]);
assert.equal(dl.suggestedFilename(), "fpl-gw11-balanced-plus-report.pdf");
const file = path.join(tmp, dl.suggestedFilename());
await dl.saveAs(file);
const { text, json, pages, size } = await readPdf(file);
assert.deepEqual(json.players.map((p) => p.id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b), "PDF squad == squad on the page");
assert.equal(json.strategyComparison.changes.length, 3);
for (const h of ["Balanced Plus: strategy definition", "What the Balanced Plus objective uses", "Historical validation (rolling backtest)", "Limitations of this validation", "Strategy comparison", "Starting XI", "Bench (in substitution order)", "Structured data"]) assert.ok(text.includes(h), h);
const maxClub = Math.max(...Object.values(json.players.filter((p) => p.role === "starting").reduce((a, p) => ((a[p.club] = (a[p.club] ?? 0) + 1), a), {})));
assert.equal(maxClub, 2, "max 2 per club in the XI inside the PDF");
console.log(`Balanced Plus PDF: ${pages} pages, ${(size / 1024).toFixed(0)} KB, swaps on page: ${swapCount}`);

await browser.close();
assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
console.log("BALANCED PLUS E2E OK");
