// End-to-end walkthrough + screenshots. Requires the app running (npm run dev / npm start) and Google Chrome.
// Usage: BASE_URL=http://localhost:3000 node scripts/screenshots.mjs
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const shot = async (name, opts = {}) => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}${name}.png`, ...opts }); console.log("saved", name); };
const num = (t) => parseFloat(t.replace(/[^0-9.\-]/g, ""));

// 1. Landing -> next gameweek, squad auto-generated
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="pitch"]');
assert.match(page.url(), /team-builder\?gw=11/, "landing should redirect to the next gameweek");
assert.match(await page.textContent('[data-testid="title"]'), /Gameweek 11/);
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
await page.waitForTimeout(1500);
await shot("01-team-builder-gw11");

// 2. Click a player -> why panel, then replacements
const starter = page.locator('[data-testid="row-MID"] [data-testid^="player-"]').first();
const epBefore = num(await page.textContent('[data-testid="ep"]'));
await starter.click();
await page.waitForSelector('[data-testid="why"]');
await shot("02-player-why-selected");
await page.click('[data-testid="tab-replace"]');
await page.waitForSelector('[data-testid^="alt-"]');
await shot("03-replacement-panel");

// 3. Swap and verify recalculation
const firstAlt = page.locator('[data-testid^="swap-"]').first();
await firstAlt.click();
await page.waitForSelector('[data-testid="panel"]', { state: "detached" });
await page.waitForSelector('[data-testid="restore"]:not([disabled])');
const epAfter = num(await page.textContent('[data-testid="ep"]'));
console.log("EP before/after swap", epBefore, epAfter);
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
await shot("04-after-replacement");

// 4. Restore original
await page.click('[data-testid="restore"]');
await page.waitForTimeout(300);
assert.equal(num(await page.textContent('[data-testid="ep"]')), epBefore, "restore returns original projection");

// 5. Strategy + a later gameweek
await page.click('[data-testid="mode-aggressive"]');
await page.waitForTimeout(1200);
await page.click('[data-testid="gw-12"]');
await page.waitForFunction(() => document.querySelector('[data-testid="title"]')?.textContent?.includes("Gameweek 12"));
await page.waitForTimeout(1200);
await shot("05-gw12-differential");
await page.click('[data-testid="gw-11"]');
await page.click('[data-testid="mode-balanced"]');
await page.waitForTimeout(1200);

// 6. Save + share
await page.fill('[data-testid="save-name"]', "My GW11 XI");
await page.click('[data-testid="save"]');
await page.click('[data-testid="share"]');
await page.waitForSelector('[data-testid="share-modal"] img');
await page.waitForTimeout(1500);
await shot("06-share-modal");
const shareUrl = await page.inputValue('[data-testid="share-url"]');
assert.match(shareUrl, /\/share\?d=/);
await page.keyboard.press("Escape");
await page.goto(shareUrl, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="share-view"]');
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
await shot("07-share-view");

// 7. Dashboard with saved team
await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="saved-row"]');
await shot("08-dashboard");

// 8. Player explorer + comparison + detail
await page.goto(`${BASE}/players`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="player-row"]');
await page.click('[data-testid="pos-FWD"]');
await page.waitForTimeout(700);
await shot("09-player-explorer");
await page.locator('[data-testid="player-row"] input[type=checkbox]').nth(0).check();
await page.locator('[data-testid="player-row"] input[type=checkbox]').nth(1).check();
await page.click('[data-testid="compare-btn"]');
await page.waitForSelector('[data-testid="comparison"]');
await shot("10-player-comparison");
await page.keyboard.press("Escape");
await page.goto(`${BASE}/players`, { waitUntil: "networkidle" });
await page.fill('[data-testid="search"]', "haaland");
await page.waitForTimeout(700);
await page.locator('[data-testid="player-row"] a').first().click();
await page.waitForSelector('[data-testid="player-detail"]');
await page.waitForTimeout(1500);
await shot("11-player-detail");

// 9. Mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
const mp = await m.newPage();
await mp.goto(BASE, { waitUntil: "networkidle" });
await mp.waitForSelector('[data-testid="pitch"]');
await mp.waitForTimeout(1500);
await mp.screenshot({ path: `${OUT}12-mobile-team-builder.png`, fullPage: false });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 1, `no horizontal scroll on mobile (overflow ${overflow}px)`);
await mp.locator('[data-testid="row-MID"] [data-testid^="player-"]').first().click();
await mp.waitForSelector('[data-testid="why"]');
await mp.waitForTimeout(500);
await mp.screenshot({ path: `${OUT}13-mobile-player-panel.png` });
console.log("saved mobile shots");

await browser.close();
assert.deepEqual(errors, [], "no console/page errors: " + errors.join(" | "));
console.log("E2E OK");
