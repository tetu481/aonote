import { expect, test } from "@playwright/test";

for (const [width, locale] of [[1440, "ja"], [390, "ja"], [390, "en"]] as const) {
  test(`左メニューの2項目で設定画面を切り替える (${width}px, ${locale})`, async ({ page }) => {
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
    const display = menu.getByRole("button", { name: english ? "Display settings" : "表示設定", exact: true });
    const connections = menu.getByRole("button", { name: english ? "Manage AI connections" : "接続AI管理", exact: true });
    await expect(menu.locator(".settings-nav-row")).toHaveCount(2);
    await expect(display).toHaveAttribute("aria-current", "page");
    await expect(connections).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: english ? "Theme" : "テーマ", exact: true })).toBeVisible();
    await expect(page.locator(".settings-sections")).toHaveCount(0);

    if (process.env.AONOTE_SETTINGS_SCREENSHOT_DIR && !english) {
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
      await page.screenshot({ path: `${process.env.AONOTE_SETTINGS_SCREENSHOT_DIR}/${date}-settings-sidebar-display-${width}.png`, animations: "disabled" });
    }

    await connections.click();
    await expect(connections).toHaveAttribute("aria-current", "page");
    await expect(display).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: english ? "Connected AI" : "接続済みAI", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: english ? "Theme" : "テーマ", exact: true })).toHaveCount(0);
    if (width === 390) await workspaceButton.click();

    if (process.env.AONOTE_SETTINGS_SCREENSHOT_DIR && !english) {
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
      await page.screenshot({ path: `${process.env.AONOTE_SETTINGS_SCREENSHOT_DIR}/${date}-settings-sidebar-connections-${width}.png`, animations: "disabled" });
    }

    await display.click();
    await expect(display).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: english ? "Theme" : "テーマ", exact: true })).toBeVisible();
    expect(await page.locator(".settings-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
