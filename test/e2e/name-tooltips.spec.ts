import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

async function fixture(request: APIRequestContext) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const folderName = `Tooltip-${suffix}-<&>-` + "LongName".repeat(12);
  const folderResponse = await request.post("/api/folders", { data: { name: folderName, parent_id: null } });
  expect(folderResponse.ok()).toBeTruthy();
  const folder = await folderResponse.json();
  const filename = `ノート-${suffix}-` + "長い名前".repeat(28) + ".md";
  const shortName = `短-${suffix}.md`;
  const title = `タイトル-${suffix}-` + "長いタイトル".repeat(20);
  const shortResponse = await request.post("/api/notes", { data: { filename: shortName, folder_id: folder.id, content: "# 短いタイトル" } });
  expect(shortResponse.ok()).toBeTruthy();
  const response = await request.post("/api/notes", { data: {
    filename, folder_id: folder.id, content: `# ${title}\n\n[[${shortName.replace(/\.md$/, "")}]]\n\n` + "検証用の本文です。\n\n".repeat(60),
  } });
  expect(response.ok()).toBeTruthy();
  const note = await response.json();
  return { folder, filename, note, shortName, title };
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_TOOLTIP_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${directory}/${date}-name-tooltip-${name}.png`, animations: "disabled" });
}

async function hoverName(page: Page, label: Locator, text: string) {
  await label.hover({ timeout: 5000 });
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(text);
  expect(await tooltip.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left >= 8 && box.right <= window.innerWidth - 7 && box.top >= 8 && box.bottom <= window.innerHeight - 7
      && element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight;
  }), "全文が折り返され、ツールチップが画面内に収まる").toBeTruthy();
}

for (const theme of ["light", "dark"]) {
  test(`省略名の全文をホバーとキーボードで確認できる (${theme})`, async ({ page, request }) => {
    const issues: string[] = [];
    page.on("pageerror", (error) => issues.push(error.message));
    page.on("console", (message) => { if (["error", "warning"].includes(message.type())) issues.push(message.text()); });
    const { folder, filename, note, shortName, title } = await fixture(request);
    await page.addInitScript((value) => localStorage.setItem("aonote:theme:v1", value), theme);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");
    await expect(page).toHaveURL("http://127.0.0.1:8765/");
    await expect(page).toHaveTitle("aonote");
    await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const folderButton = page.getByRole("button", { name: folder.name, exact: true });
    await hoverName(page, folderButton, folder.name);
    // A delayed event from auto-scrolling must not hide a newly shown name.
    await page.locator(".tree-scroll").dispatchEvent("scroll");
    await expect(page.getByRole("tooltip")).toHaveText(folder.name);
    // Names containing HTML-like characters must remain literal text.
    await expect(page.getByRole("tooltip").locator("*")).toHaveCount(0);
    await screenshot(page, `folder-${theme}`);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    const folderBox = await folderButton.boundingBox();
    expect(folderBox).not.toBeNull();
    await page.mouse.move(folderBox!.x + folderBox!.width / 2 + 5, folderBox!.y + folderBox!.height / 2);
    await expect(page.getByRole("tooltip")).toHaveText(folder.name);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "新規ノート", exact: true }).focus();
    await folderButton.focus();
    await expect(page.getByRole("tooltip")).toHaveText(folder.name);
    await expect(folderButton).toHaveAttribute("aria-describedby", await page.getByRole("tooltip").getAttribute("id") as string);
    await folderButton.press("Enter");
    await expect(folderButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    const noteButton = page.getByRole("button", { name: filename, exact: true });
    await hoverName(page, noteButton, filename);
    await screenshot(page, `note-${theme}`);
    await noteButton.click();
    await expect(page.locator(".breadcrumb strong")).toHaveText(filename);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await hoverName(page, page.locator(".breadcrumb [data-full-name]").first(), folder.name);
    await hoverName(page, page.locator(".breadcrumb strong"), filename);
    await screenshot(page, `breadcrumb-${theme}`);
    await page.getByRole("button", { name: shortName, exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.getByRole("button", { name: shortName, exact: true }).click();
    await hoverName(page, page.locator(".backlinks button").filter({ hasText: title }), title);
    await page.locator(".backlinks button").filter({ hasText: title }).click();
    await expect(page.locator(".breadcrumb strong")).toHaveText(filename);
    await page.getByRole("button", { name: "最近のノート", exact: true }).click();
    const recent = page.locator(".recent-row").filter({ hasText: filename });
    await hoverName(page, recent.locator("strong"), title);
    await hoverName(page, recent.locator("small"), filename);
    await recent.click();
    await page.setViewportSize({ width: 1440, height: 360 });
    await hoverName(page, folderButton, folder.name);
    await page.locator(".tree-scroll").evaluate((element) => { element.scrollTop += element.scrollTop > 0 ? -36 : 36; });
    // The pointer may now hover another row; the old name must not remain.
    await expect.poll(() => page.getByRole("tooltip").allTextContents()).not.toContain(folder.name);
    await hoverName(page, folderButton, folder.name);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.getByRole("button", { name: "ワークスペースを表示", exact: true }).click();
    await hoverName(page, folderButton, folder.name);
    await screenshot(page, `mobile-${theme}`);
    await page.getByRole("button", { name: "ワークスペースを隠す", exact: true }).click();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 960 });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "ノートを削除", exact: true }).click();
    await expect(page.locator(".breadcrumb strong")).not.toHaveText(filename);
    await page.getByRole("button", { name: "ゴミ箱", exact: true }).click();
    const trash = page.locator(".trash-row").filter({ hasText: filename });
    await hoverName(page, trash.locator("strong"), filename);
    await hoverName(page, trash.locator("small"), `${folder.name}/${filename}`);
    await trash.click();
    await hoverName(page, page.locator(".trash-document-bar .breadcrumb strong"), `${folder.name}/${filename}`);
    const saved = await request.get(`/api/trash/${note.id}`);
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).content).toBe(note.content);
    expect(issues).toEqual([]);
  });
}

test.describe("タッチ操作", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("タップで不要なツールチップを残さずノートを開ける", async ({ page, request }) => {
    const { folder, filename } = await fixture(request);
    await page.goto("/");
    await page.getByRole("button", { name: "ワークスペースを表示", exact: true }).tap();
    await page.getByRole("button", { name: folder.name, exact: true }).tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.getByRole("button", { name: filename, exact: true }).tap();
    await expect(page.locator(".breadcrumb strong")).toHaveText(filename);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });
});
