import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const URL = "https://sakthiai-hitech-preview.onrender.com/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY }, args: ["--ignore-certificate-errors-spki-list=${process.env.SPKI}"] });
const out = [];
for (const vp of [{ name: "mobile-360", width: 360, height: 780 }, { name: "mobile-390", width: 390, height: 844 }, { name: "desktop-1440", width: 1440, height: 900 }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } }); const page = await ctx.newPage();
  const resp = await page.goto(URL, { waitUntil: "networkidle", timeout: 90000 });
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const sev = r.violations.filter(v => ["serious", "critical"].includes(v.impact));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const text = (await page.innerText("body")).slice(0, 200).replace(/\s+/g, " ");
  out.push({ viewport: vp.name, status: resp.status(), violations: r.violations.map(v => `${v.id}:${v.impact}:${v.nodes.length}`), seriousOrCritical: sev.length, horizontalOverflow: overflow, text });
  await page.screenshot({ path: `/var/tmp/live-${vp.name}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 1));
