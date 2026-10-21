import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type TestNote = { id: string; filename: string; content: string; version: number };
const issues = new WeakMap<Page, string[]>();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  issues.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) && !/Failed to load resource:.*status of 503\b/.test(message.text())) errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
});

test.afterEach(async ({ page }) => { expect(issues.get(page)).toEqual([]); });

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_REFRESH_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${directory}/${date}-refresh-fixed-${name}.png`, animations: "disabled" });
}

async function setup(page: Page, request: APIRequestContext) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const response = await request.post("/api/folders", { data: { name: `Refresh-${suffix}` } });
  expect(response.ok()).toBeTruthy();
  const folder = await response.json();
  const created = await request.post("/api/notes", { data: { filename: `origin-${suffix}.md`, folder_id: folder.id, content: "# Original body" } });
  expect(created.ok()).toBeTruthy();
  const note = await created.json() as TestNote;
  await page.addInitScript((id) => sessionStorage.setItem("aonote:workspace-session:v1", JSON.stringify({ noteId: id, view: "preview", updatedAt: Date.now() })), note.id);
  await page.goto("/");
  await expect(page).toHaveURL("http://127.0.0.1:8765/");
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator(".breadcrumb strong")).toHaveText(note.filename);
  await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
  return { suffix, folder, note };
}

async function createFromDialog(page: Page, filename: string) {
  await page.getByRole("button", { name: "新規ノート", exact: true }).click();
  await page.getByLabel("ファイル名", { exact: true }).fill(filename);
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.locator(".new-note-dialog")).toHaveCount(0);
  await expect(page.locator(".breadcrumb strong")).toHaveText(filename);
}

for (const endpoint of ["tree", "recent"]) {
  for (const oldResult of ["success", "failure"]) {
    test(`遅延した${endpoint}の${oldResult}応答でも最新のツリーと履歴を巻き戻さない`, async ({ page, request }) => {
      const { suffix } = await setup(page, request);
      const captured = deferred();
      const release = deferred();
      let first = true;
      await page.route(`**/api/${endpoint}`, async (route) => {
        if (!first) return route.continue();
        first = false;
        const snapshot = await route.fetch();
        captured.resolve();
        await release.promise;
        if (oldResult === "failure") await route.fulfill({ status: 503, json: { detail: "Old failed refresh" } });
        else await route.fulfill({ response: snapshot });
      });
      try {
        await page.locator('.view-switch button[title="編集"]').click();
        await page.getByLabel("Markdown本文").fill("# Trigger autosave refresh");
        await captured.promise;
        const filename = `latest-${suffix}.md`;
        await createFromDialog(page, filename);
        const row = page.locator(".note-row").filter({ hasText: filename });
        await expect(row).toHaveCount(1);
        const delivered = page.waitForResponse((response) => response.url().endsWith(`/api/${endpoint}`));
        release.resolve();
        await (await delivered).finished();
        // Let the older fetch's state updates reach React before asserting.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(row).toHaveCount(1);
        await expect(page.locator(".navigation-warning")).toHaveCount(0);
        await page.getByRole("button", { name: "最近のノート", exact: true }).click();
        await expect(page.locator(".recent-row").filter({ hasText: filename })).toBeVisible();
      } finally { release.resolve(); }
    });
  }
}

test("作成後の一覧更新が失敗しても作成済みノートを開き、本文を保存して表示だけ再試行できる", async ({ page, request }) => {
  const { suffix, folder } = await setup(page, request);
  let creates = 0;
  page.on("request", (req) => { if (req.method() === "POST" && req.url().endsWith("/api/notes")) creates++; });
  await page.route("**/api/tree", (route) => route.fulfill({ status: 503, json: { detail: "Navigation unavailable" } }));
  const filename = `created-${suffix}.md`;
  await createFromDialog(page, filename);
  await expect(page.locator(".navigation-warning")).toContainText("変更は保存済み");
  await expect(page.locator(".document-error:not(.navigation-warning)")).toHaveCount(0);
  const tree = await (await request.get("/api/tree")).json();
  const created = tree.find((item: { id: string }) => item.id === folder.id).notes.find((item: TestNote) => item.filename === filename) as TestNote;
  expect(created).toBeTruthy();
  await screenshot(page, "created-note-warning");
  await page.locator('.view-switch button[title="編集"]').click();
  await page.getByLabel("Markdown本文").fill("# Draft before refresh retry");
  await page.unroute("**/api/tree");
  await page.getByRole("button", { name: "表示を再読み込み", exact: true }).click();
  await expect(page.locator(".navigation-warning")).toHaveCount(0);
  await expect(page.getByLabel("Markdown本文")).toHaveValue("# Draft before refresh retry");
  expect((await (await request.get(`/api/notes/${created.id}`)).json()).content).toBe("# Draft before refresh retry");
  await expect(page.locator(".note-row").filter({ hasText: filename })).toHaveCount(1);
  expect(creates).toBe(1);
});

test("英語・ダークテーマ・スマホでもフォルダ作成成功と一覧更新失敗を区別する", async ({ page, request }) => {
  const { suffix } = await setup(page, request);
  await page.evaluate(() => { localStorage.setItem("aonote:locale:v1", "en"); localStorage.setItem("aonote:theme:v1", "dark"); });
  await page.reload();
  await expect(page.getByLabel("Markdown preview")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  let creates = 0;
  page.on("request", (req) => { if (req.method() === "POST" && req.url().endsWith("/api/folders")) creates++; });
  await page.route("**/api/recent", (route) => route.fulfill({ status: 503, json: { detail: "Recent unavailable" } }));
  const name = `created-folder-${suffix}`;
  // The existing mobile toolbar hides its text labels and uses icons only.
  await page.locator(".topbar-actions .secondary-button").click();
  await page.getByLabel("Folder name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".new-note-dialog")).toHaveCount(0);
  await expect(page.locator(".navigation-warning")).toContainText("Your changes were saved");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await screenshot(page, "folder-en-dark-mobile");
  await page.unroute("**/api/recent");
  await page.getByRole("button", { name: "Refresh display", exact: true }).click();
  await expect(page.locator(".navigation-warning")).toHaveCount(0);
  await page.getByRole("button", { name: "Show workspace", exact: true }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  expect(creates).toBe(1);
});

for (const operation of ["rename", "delete"]) {
  test(`フォルダ${operation}成功後のノート再取得失敗は書き込み失敗として扱わない`, async ({ page, request }) => {
    const { suffix, folder, note } = await setup(page, request);
    await page.route(`**/api/notes/${note.id}`, (route) => route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { detail: "Metadata read unavailable" } }) : route.continue());
    const folderRow = page.locator(".folder-row").filter({ has: page.getByRole("button", { name: folder.name, exact: true }) });
    if (operation === "rename") {
      await folderRow.getByRole("button", { name: `「${folder.name}」の名前を変更`, exact: true }).click();
      await page.getByLabel("フォルダ名", { exact: true }).fill(`renamed-${suffix}`);
      await page.getByRole("button", { name: "変更を保存", exact: true }).click();
      await expect(page.locator(".new-note-dialog")).toHaveCount(0);
    } else {
      page.once("dialog", (dialog) => dialog.accept());
      await folderRow.getByRole("button", { name: `「${folder.name}」を削除`, exact: true }).click();
    }
    await expect(page.locator(".navigation-warning")).toBeVisible();
    await expect(page.locator(".document-error:not(.navigation-warning)")).toHaveCount(0);
    await page.unroute(`**/api/notes/${note.id}`);
    await page.getByRole("button", { name: "表示を再読み込み", exact: true }).click();
    await expect(page.locator(".navigation-warning")).toHaveCount(0);
    await expect(page.locator(".breadcrumb")).toContainText(operation === "rename" ? `renamed-${suffix}` : "未整理");
    expect((await (await request.get(`/api/notes/${note.id}`)).json()).content).toBe(note.content);
  });
}

for (const operation of ["restore", "purge"]) {
  test(`ゴミ箱の${operation}成功後の一覧更新失敗では操作を繰り返さない`, async ({ page, request }) => {
    const { note } = await setup(page, request);
    expect((await request.delete(`/api/notes/${note.id}`)).ok()).toBeTruthy();
    await page.reload();
    await page.getByRole("button", { name: "ゴミ箱", exact: true }).click();
    await page.locator(".trash-row").filter({ hasText: note.filename }).click();
    await expect(page.locator(".breadcrumb strong")).toContainText(note.filename);
    await page.route("**/api/trash", (route) => route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { detail: "Trash refresh unavailable" } }) : route.continue());
    let writes = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith(`/api/trash/${note.id}/restore`)) writes++;
      if (req.method() === "DELETE" && req.url().includes("/api/trash?")) writes++;
    });
    if (operation === "restore") {
      await page.getByRole("button", { name: "元に戻す", exact: true }).click();
      await expect(page.locator(".trash-document-bar")).toHaveCount(0);
      await expect(page.locator(".breadcrumb strong")).toHaveText(note.filename);
    } else {
      await page.getByLabel("完全削除する経過日数").fill("0");
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "完全削除", exact: true }).click();
      await expect(page.locator(".trash-purge-controls")).toContainText("件を完全に削除しました");
    }
    await expect(page.locator(".navigation-warning")).toBeVisible();
    await page.unroute("**/api/trash");
    await page.getByRole("button", { name: "表示を再読み込み", exact: true }).click();
    await expect(page.locator(".navigation-warning")).toHaveCount(0);
    await expect(page.locator(".trash-row").filter({ hasText: note.filename })).toHaveCount(0);
    expect(writes).toBe(1);
    const actual = await request.get(`/api/notes/${note.id}`);
    expect(actual.status()).toBe(operation === "restore" ? 200 : 404);
  });
}
