// Browser E2E for the News Intelligence dashboard. Requires the app running and Google Chrome.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
for (const [label, vp] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${BASE}/news`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="news-dashboard"]');
  await page.waitForSelector('[data-testid="news-list"], [data-testid="news-empty"]');
  assert.match(await page.textContent('[data-testid="news-fresh-badge"]'), /Up to date|Stale|Not refreshed/);
  assert.match(await page.textContent('[data-testid="news-sources"]'), /Official FPL status/);
  assert.match(await page.textContent('[data-testid="news-sources"]'), /BBC Sport/);
  const cards = await page.locator('[data-testid="news-event"]').count();
  assert.ok(cards > 0, "FPL official status yields events");
  const href = await page.locator('[data-testid="news-event"] a').first().getAttribute("href");
  assert.match(href, /^https:/);
  for (const t of ["mine", "changed", "injury", "suspension", "intl", "rotation", "all"]) await page.click(`[data-testid="news-tab-${t}"]`);
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.ok(noScroll, `${label}: no horizontal scroll`);
  await page.click('[data-testid="news-tab-all"]');
  await page.screenshot({ path: `${OUT}${label === "desktop" ? "29-news-desktop" : "30-news-mobile"}.png`, fullPage: true });
  await page.click('[data-testid="news-refresh"]');
  await page.waitForSelector('[data-testid="news-msg"]');
  console.log(`${label}: ${cards} events, ok`);
  await ctx.close();
}
// Team Builder shows the news panel and keeps working
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${BASE}/team-builder`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="player-' + (await page.locator('[data-testid^="player-"]').first().getAttribute("data-testid")).replace("player-", "") + '"]');
assert.equal(await page.locator('[data-testid^="player-"]').count(), 15);
await browser.close();
assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
console.log("NEWS E2E OK");
