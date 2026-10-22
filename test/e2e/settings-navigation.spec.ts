import { expect, test } from "@playwright/test";

for (const [width, locale] of [[1440, "ja"], [390, "ja"], [390, "en"]] as const) {
  test(`左メニューの3項目で設定画面を切り替える (${width}px, ${locale})`, async ({ page }) => {
    await page.addInitScript((language) => localStorage.setItem("aonote:locale:v1", language), locale);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    await expect(page).toHaveTitle("aonote");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const english = locale === "en";
    const workspaceButton = page.getByRole("button", { name: english ? "Show workspace" : "ワークスペースを表示", exact: true });
    if (width === 390) await workspaceButton.click();
    await page.getByRole("button", { name: english ? "Settings" : "設定", exact: true }).click();
    if (width === 390) await workspaceButton.click();

    const menu = page.locator(".sidebar-panel");
    const displayLabel = english ? "Display settings" : "表示設定";
    const behaviorLabel = english ? "Behavior settings" : "動作設定";
    const connectionsLabel = english ? "Manage AI connections" : "接続AI管理";
    const display = menu.getByRole("button", { name: displayLabel, exact: true });
    const behavior = menu.getByRole("button", { name: behaviorLabel, exact: true });
    const connections = menu.getByRole("button", { name: connectionsLabel, exact: true });
    await expect(menu.locator(".settings-nav-row")).toHaveCount(3);
    await expect(display).toHaveAttribute("aria-current", "page");
    await expect(behavior).not.toHaveAttribute("aria-current", "page");
    await expect(connections).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: displayLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: english ? "Theme" : "テーマ", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: english ? "Language" : "言語", exact: true })).toBeVisible();
    await expect(page.locator(".preview-checkbox-options")).toHaveCount(0);
    await expect(page.locator(".settings-intro > span")).toHaveCount(0);
    await expect(page.locator(".settings-sections")).toHaveCount(0);

    if (process.env.AONOTE_SETTINGS_SCREENSHOT_DIR && !english) {
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
      await page.screenshot({ path: `${process.env.AONOTE_SETTINGS_SCREENSHOT_DIR}/${date}-settings-sidebar-display-${width}.png`, animations: "disabled" });
    }

    await behavior.click();
    await expect(behavior).toHaveAttribute("aria-current", "page");
    await expect(display).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: behaviorLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: english ? "Preview checkboxes" : "プレビューのチェックボックス", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: english ? "Theme" : "テーマ", exact: true })).toHaveCount(0);
    await page.locator('.preview-checkbox-options input[value="toggle"]').check();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("aonote:preview-checkboxes:v1"))).toBe("toggle");
    if (width === 390 && process.env.AONOTE_SETTINGS_SCREENSHOT_DIR && !english) {
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
      await page.screenshot({ path: `${process.env.AONOTE_SETTINGS_SCREENSHOT_DIR}/${date}-settings-behavior-content-390.png`, animations: "disabled" });
    }
    if (width === 390) await workspaceButton.click();

    if (process.env.AONOTE_SETTINGS_SCREENSHOT_DIR && !english) {
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
      await page.screenshot({ path: `${process.env.AONOTE_SETTINGS_SCREENSHOT_DIR}/${date}-settings-sidebar-behavior-${width}.png`, animations: "disabled" });
    }

    await connections.click();
    await expect(connections).toHaveAttribute("aria-current", "page");
    await expect(behavior).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: connectionsLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: english ? "Connected AI" : "接続済みAI", exact: true })).toBeVisible();
    await expect(page.locator(".preview-checkbox-options")).toHaveCount(0);
    if (width === 390 && process.env.AONOTE_SETTINGS_SCREENSHOT_DIR && !english) {
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
      await page.screenshot({ path: `${process.env.AONOTE_SETTINGS_SCREENSHOT_DIR}/${date}-settings-connections-content-390.png`, animations: "disabled" });
    }
    if (width === 390) await workspaceButton.click();

    if (process.env.AONOTE_SETTINGS_SCREENSHOT_DIR && !english) {
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
      await page.screenshot({ path: `${process.env.AONOTE_SETTINGS_SCREENSHOT_DIR}/${date}-settings-sidebar-connections-${width}.png`, animations: "disabled" });
    }

    await display.click();
    await expect(display).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: displayLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: english ? "Theme" : "テーマ", exact: true })).toBeVisible();
    await expect(page.locator(".preview-checkbox-options")).toHaveCount(0);
    if (width === 390) await workspaceButton.click();
    await behavior.click();
    await expect(page.locator('.preview-checkbox-options input[value="toggle"]')).toBeChecked();
    expect(await page.locator(".settings-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
