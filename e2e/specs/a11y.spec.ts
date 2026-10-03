import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, newIdentity } from "../support/helpers";

const focusIndicator = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  const hasOutline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
  const hasShadow = s.boxShadow !== "none";
  return { tag: el.tagName, label: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || "", visible: hasOutline || hasShadow };
});

async function tabTo(page: Page, matches: (info: NonNullable<Awaited<ReturnType<typeof focusIndicator>>>) => boolean, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const info = await focusIndicator(page);
    if (info && matches(info)) return info;
  }
  throw new Error("element never received keyboard focus");
}

async function criticalAxe(page: Page, label: string, testInfo: import("@playwright/test").TestInfo) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await testInfo.attach(`axe-${label}.json`, { body: JSON.stringify(results.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })), null, 2), contentType: "application/json" });
  const critical = results.violations.filter(v => v.impact === "critical");
  expect(critical.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`), `critical axe violations on ${label}`).toEqual([]);
}

test.describe("keyboard, focus and critical accessibility", () => {
  test("landing: keyboard reaches the sign-in control with a visible focus indicator; no critical axe violations", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sign in securely" })).toBeVisible();
    const info = await tabTo(page, i => i.label.includes("Sign in securely"));
    expect(info.visible, "focus indicator must be visible on the sign-in button").toBe(true);
    await criticalAxe(page, "landing", testInfo);
  });

  test("workspace: keyboard-only navigation, language toggle, composing and sending; visible focus; no critical axe violations", async ({ page }, testInfo) => {
    await login(page, newIdentity("kbd"));
    // nav landmark + focusable links with visible focus
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    const link = await tabTo(page, i => i.tag === "A" && /Chat/.test(i.label));
    expect(link.visible).toBe(true);

    const tamil = await tabTo(page, i => i.label === "தமிழ்");
    expect(tamil.visible, "language toggle focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "தமிழ்", exact: true })).toHaveAttribute("aria-pressed", "true");

    const area = await tabTo(page, i => i.tag === "TEXTAREA");
    expect(area.visible, "textarea focus indicator").toBe(true);
    await page.keyboard.type("hello");
    await tabTo(page, i => i.label === "Send");
    // send is enabled and reachable; activating it by keyboard must not throw (no evidence yet → INSUFFICIENT_EVIDENCE)
    await page.keyboard.press("Enter");
    await expect(page.locator(".answer-area")).toContainText("INSUFFICIENT_EVIDENCE");

    await criticalAxe(page, "workspace", testInfo);
  });

  test("layout stays usable at this viewport: no horizontal page scroll and primary controls are on-screen", async ({ page }) => {
    await login(page, newIdentity("layout"));
    const report = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const offenders = [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > width + 1).slice(0, 6).map(el => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`.slice(0, 80));
      return { overflow: document.documentElement.scrollWidth - width, offenders };
    });
    expect(report.overflow, `horizontal overflow in px; offenders: ${report.offenders.join(" | ")}`).toBeLessThanOrEqual(1);
    const send = page.getByRole("button", { name: "Send" });
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeVisible();
    await expect(page.locator("textarea")).toBeVisible();
  });
});
