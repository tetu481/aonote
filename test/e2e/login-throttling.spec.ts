import { expect, test } from "@playwright/test";

for (const locale of ["ja", "en"]) {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    test(`ログイン停止とRetry-Afterを表示する (${locale}, ${viewport.width}px)`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.addInitScript((value) => localStorage.setItem("aonote:locale:v1", value), locale);
      await page.route("**/api/status", (route) => route.fulfill({ status: 401, json: { detail: "Authentication required" } }));
      let attempts = 0;
      await page.route("**/api/session", (route) => {
        attempts++;
        return route.fulfill(attempts < 5
          ? { status: 401, json: { detail: "Incorrect password" } }
          : { status: 429, headers: { "Retry-After": "120" }, json: { detail: "Too many login attempts" } });
      });
      await page.goto("/");
      await expect(page).toHaveTitle("aonote");
      await expect(page.getByRole("heading", { name: locale === "ja" ? "ワークスペースを開く" : "Open workspace" })).toBeVisible();
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      const password = page.getByLabel(locale === "ja" ? "管理パスワード" : "Admin password");
      const submit = page.getByRole("button", { name: locale === "ja" ? "aonoteを開く" : "Open aonote", exact: true });
      await password.fill("wrong-password");
      for (let index = 0; index < 4; index++) {
        await submit.click();
        await expect(page.getByRole("alert")).toHaveText(locale === "ja" ? "パスワードが正しくありません" : "Incorrect password");
        await expect(submit).toBeEnabled();
      }
      await submit.click();
      await expect(page.getByRole("alert")).toContainText(locale === "ja" ? "約2分後" : "about 2 minute(s)");
      // A correct password cannot hide a server-side lockout behind the generic error.
      await password.fill("correct-password");
      await submit.click();
      await expect(page.getByRole("alert")).toContainText(locale === "ja" ? "試行回数の上限" : "Too many login attempts");
      expect(attempts).toBe(6);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      expect(errors).toEqual([]);
    });
  }
}
