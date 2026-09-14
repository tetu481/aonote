import { expect, test, type Page } from "@playwright/test";

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_TREE_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  const phase = process.env.AONOTE_TREE_SCREENSHOT_PHASE ?? "after";
  await page.screenshot({ path: `${directory}/${date}-sidebar-${phase}-${name}.png`, animations: "disabled" });
}

async function expectContained(page: Page) {
  const sizes = await page.locator(".sidebar-shell").evaluate((shell) => {
    const bounds = shell.getBoundingClientRect();
    const panel = shell.querySelector(".sidebar-panel")!;
    const tree = shell.querySelector(".tree-scroll")!;
    return {
      panelOverrun: panel.getBoundingClientRect().right - bounds.right,
      horizontalOverflow: tree.scrollWidth - tree.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(sizes.panelOverrun, "ツリー本体がサイドバーの幅を超えない").toBeLessThanOrEqual(1);
  expect(sizes.horizontalOverflow, "ツリー内に横スクロールが生じない").toBeLessThanOrEqual(1);
  expect(sizes.pageOverflow, "ページ全体が横にはみ出さない").toBeLessThanOrEqual(1);
}

for (const profile of [
  { theme: "light", hasTouch: true, widths: [320, 390, 520, 521, 768, 900, 901, 1024, 1440] },
  { theme: "dark", hasTouch: false, widths: [390, 768, 1440] },
] as const) {
  test.describe(`長い名前のツリー (${profile.theme})`, () => {
    test.use({ hasTouch: profile.hasTouch });

    test("画面幅によらず名前を省略し、開閉・階層展開・ノート選択・フォルダ操作ができる", async ({ page, request }) => {
      const issues: string[] = [];
      page.on("pageerror", (error) => issues.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) issues.push(message.text());
      });
      const suffix = crypto.randomUUID().slice(0, 8);
      const names = [
        `LongFolder-${suffix}-`.padEnd(120, "x"),
        `長いフォルダ名-${suffix}-` + "あ".repeat(100),
        `第三階層-${suffix}-` + "b".repeat(100),
      ];
      let parentId: string | null = null;
      for (const name of names) {
        const response = await request.post("/api/folders", { data: { name, parent_id: parentId } });
        expect(response.ok()).toBeTruthy();
        parentId = (await response.json()).id;
      }
      const filename = `長いノート-${suffix}-` + "ノート".repeat(30) + ".md";
      const noteResponse = await request.post("/api/notes", {
        data: { filename, folder_id: parentId, content: "# ツリー表示の検証\n\n長い名前でもノートを開けます。" },
      });
      expect(noteResponse.ok()).toBeTruthy();
      const note = await noteResponse.json();
      await page.addInitScript((theme) => localStorage.setItem("aonote:theme:v1", theme), profile.theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/");
      await expect(page).toHaveURL("http://127.0.0.1:8765/");
      await expect(page).toHaveTitle("aonote");
      await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      await screenshot(page, `${profile.theme}-mobile-closed`);
      await expectContained(page);

      for (const width of profile.widths) {
        await page.setViewportSize({ width, height: width > 900 ? 960 : 844 });
        const mobile = width <= 900;
        if (mobile) await page.getByRole("button", { name: "ワークスペースを表示", exact: true }).click();
        for (const name of names) {
          const folder = page.getByRole("button", { name, exact: true });
          if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
          await expect(folder).toHaveAttribute("aria-expanded", "true");
          const label = await folder.locator("span").evaluate((span) => ({
            truncated: span.scrollWidth > span.clientWidth,
            ellipsis: getComputedStyle(span).textOverflow,
          }));
          expect(label).toEqual({ truncated: true, ellipsis: "ellipsis" });
        }
        await expectContained(page);
        const noteButton = page.getByRole("button", { name: filename, exact: true });
        await noteButton.scrollIntoViewIfNeeded();
        if (width === 390 || width === 1440) await screenshot(page, `${profile.theme}-${width}-open`);
        await noteButton.click();
        await expect(page.locator(".breadcrumb strong")).toHaveText(filename);
        await expect(page.getByLabel("Markdownプレビュー")).toContainText("長い名前でもノートを開けます。");
        if (mobile) {
          await expect(page.locator(".sidebar-shell")).not.toHaveClass(/mobile-open/);
          await expect.poll(() => page.locator(".sidebar-shell").evaluate((shell) => shell.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
          await expectContained(page);
          const leaked = await page.evaluate(() => {
            const preview = document.querySelector(".preview-pane")!.getBoundingClientRect();
            return [12, 100, 200].some((x) => document.elementFromPoint(x, preview.top + 80)?.closest(".sidebar-shell"));
          });
          expect(leaked, "閉じたツリーが本文の操作を妨げない").toBeFalsy();
        }
      }

      // The action buttons must remain reachable even in the deepest folder.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "ワークスペースを表示", exact: true }).click();
      const renamed = `${names[2].slice(0, 110)}-改名`;
      const renameButton = page.getByRole("button", { name: `「${names[2]}」の名前を変更`, exact: true });
      if (!profile.hasTouch) await renameButton.locator("../..").hover();
      await renameButton.click();
      await page.getByLabel("フォルダ名", { exact: true }).fill(renamed);
      await page.getByRole("button", { name: "変更を保存", exact: true }).click();
      await expect(page.locator(".new-note-dialog")).toBeHidden();
      await expect(page.getByRole("button", { name: renamed, exact: true })).toBeVisible();
      await expectContained(page);
      page.once("dialog", (dialog) => void dialog.accept());
      const deleteButton = page.getByRole("button", { name: `「${renamed}」を削除`, exact: true });
      if (!profile.hasTouch) await deleteButton.locator("../..").hover();
      await deleteButton.click();
      await expect(page.getByRole("button", { name: renamed, exact: true })).toHaveCount(0);
      const remaining = await request.get(`/api/notes/${note.id}`);
      expect(remaining.ok()).toBeTruthy();
      expect((await remaining.json()).content).toBe(note.content);
      expect(issues).toEqual([]);
    });
  });
}
