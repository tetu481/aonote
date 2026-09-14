import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type TestNote = { id: string; filename: string; content: string; version: number };
const browserIssues = new WeakMap<Page, string[]>();

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_AUTOSAVE_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${directory}/${date}-autosave-${name}.png`, animations: "disabled" });
}

async function setup(page: Page, request: APIRequestContext) {
  const folderResponse = await request.post("/api/folders", { data: { name: `Autosave-${crypto.randomUUID()}`, parent_id: null } });
  expect(folderResponse.ok()).toBeTruthy();
  const folder = await folderResponse.json();
  const notes: TestNote[] = [];
  for (const letter of ["A", "B", "C"]) {
    const response = await request.post("/api/notes", { data: { filename: `${letter}-${folder.id.slice(0, 8)}.md`, folder_id: folder.id, content: `# ${letter} original` } });
    expect(response.ok()).toBeTruthy();
    notes.push(await response.json());
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page).toHaveURL("http://127.0.0.1:8765/");
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: folder.name, exact: true }).click();
  await page.getByRole("button", { name: notes[0].filename, exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(notes[0].filename);
  await page.locator('.view-switch button[title="編集"]').click();
  return { notes, folder };
}

async function readNote(request: APIRequestContext, note: TestNote): Promise<TestNote> {
  const response = await request.get(`/api/notes/${note.id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test.beforeEach(async ({ page }) => {
  const issues: string[] = [];
  browserIssues.set(page, issues);
  page.on("pageerror", (error) => { issues.push(error.message); });
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    // These HTTP failures are deliberately exercised below, not app exceptions.
    if (/Failed to load resource:.*status of (409|503)\b/.test(message.text())) return;
    issues.push(message.text());
  });
});

test.afterEach(async ({ page }) => {
  expect(browserIssues.get(page)).toEqual([]);
});

test("保存タイマーを待たずに切り替えても元のノートの本文を保存する", async ({ page, request }) => {
  const { notes: [a, b] } = await setup(page, request);
  await page.getByLabel("Markdown本文").fill("# A immediately edited");
  await page.getByRole("button", { name: b.filename, exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(b.filename);
  expect((await readNote(request, a)).content).toBe("# A immediately edited");
  expect((await readNote(request, b)).content).toBe(b.content);
});

test("遅延した保存応答で選択や別ノートの本文を上書きしない", async ({ page, request }) => {
  const { notes: [a, b] } = await setup(page, request);
  const started = deferred();
  const release = deferred();
  const writes: { content: string; version: number }[] = [];
  await page.route(`**/api/notes/${a.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes.push(route.request().postDataJSON());
    const response = await route.fetch();
    started.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await page.getByLabel("Markdown本文").fill("# A pending save");
    await started.promise;
    await page.getByRole("button", { name: b.filename, exact: true }).click();
    await expect(page.locator(".breadcrumb strong")).toHaveText(a.filename);
    await expect(page.getByLabel("Markdown本文")).not.toBeEditable();
    release.resolve();
    await expect(page.locator(".breadcrumb strong")).toHaveText(b.filename);
    await expect(page.getByLabel("Markdown本文")).toHaveValue(b.content);
    await screenshot(page, "switch-complete");
    // Wait beyond the debounce window to catch an unintended follow-up PATCH.
    await page.waitForTimeout(900);
    expect(writes).toEqual([{ content: "# A pending save", version: a.version }]);
    expect((await readNote(request, a)).content).toBe("# A pending save");
    expect((await readNote(request, b)).content).toBe(b.content);
  } finally { release.resolve(); }
});

for (const revert of [false, true]) {
  test(`保存中の追加入力を順番に保存する${revert ? "（元の本文への取り消し）" : ""}`, async ({ page, request }) => {
    const { notes: [a, b] } = await setup(page, request);
    const started = deferred();
    const release = deferred();
    const writes: { content: string; version: number }[] = [];
    await page.route(`**/api/notes/${a.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes.push(route.request().postDataJSON());
      if (writes.length !== 1) return route.continue();
      const response = await route.fetch();
      started.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      const editor = page.getByLabel("Markdown本文");
      await editor.fill("# A first edit");
      await started.promise;
      await expect(editor).toBeEditable();
      const latest = revert ? a.content : "# A latest edit";
      await editor.fill(latest);
      await page.waitForTimeout(900);
      expect(writes).toHaveLength(1);
      await expect(page.locator(".save-state")).toHaveText("保存中…");
      await page.getByRole("button", { name: b.filename, exact: true }).click();
      release.resolve();
      await expect(page.locator(".breadcrumb strong")).toHaveText(b.filename);
      expect(writes).toEqual([
        { content: "# A first edit", version: a.version },
        { content: latest, version: a.version + 1 },
      ]);
      expect((await readNote(request, a)).content).toBe(latest);
      expect((await readNote(request, b)).content).toBe(b.content);
    } finally { release.resolve(); }
  });
}

test("保存失敗時は本文を保持し、切替・再読み込み・新規作成を止めて再試行できる", async ({ page, request }) => {
  const { notes: [a, b] } = await setup(page, request);
  let unavailable = true;
  await page.route(`**/api/notes/${a.id}`, async (route) => {
    if (route.request().method() !== "PATCH" || !unavailable) return route.continue();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "database_busy" }) });
  });
  const editor = page.getByLabel("Markdown本文");
  await editor.fill("# A unsaved draft");
  await page.getByRole("button", { name: b.filename, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("編集内容はこの画面に保持されています");
  await expect(page.locator(".save-state")).toHaveText("保存エラー");
  await expect(page.locator(".breadcrumb strong")).toHaveText(a.filename);
  await expect(editor).toHaveValue("# A unsaved draft");
  await expect(editor).toBeEditable();
  await screenshot(page, "save-error-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator(".sidebar-shell").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "保存を再試行" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await screenshot(page, "save-error-mobile");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "ツリーとノートを再読み込み" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(editor).toHaveValue("# A unsaved draft");
  await page.getByRole("button", { name: "新規ノート", exact: true }).click();
  await page.getByLabel("ファイル名").fill("Should-not-be-created.md");
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.locator(".dialog-error")).toContainText("編集内容はこの画面に保持されています");
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect((await readNote(request, a)).content).toBe(a.content);
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBeTruthy();
  unavailable = false;
  await page.getByRole("button", { name: "保存を再試行" }).click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.locator(".save-state")).toHaveText("保存済み");
  expect((await readNote(request, a)).content).toBe("# A unsaved draft");
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBeFalsy();
  await page.getByRole("button", { name: b.filename, exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(b.filename);
});

test("他のクライアントとの競合時はローカル本文とサーバーの更新を両方保持する", async ({ page, request }) => {
  const { notes: [a, b] } = await setup(page, request);
  const response = await request.patch(`/api/notes/${a.id}`, { data: { content: "# Updated by AI", version: a.version } });
  expect(response.ok()).toBeTruthy();
  await page.getByLabel("Markdown本文").fill("# My local changes");
  await page.getByRole("button", { name: b.filename, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("他の利用者による更新と競合");
  await expect(page.locator(".save-state")).toHaveText("更新の競合");
  await expect(page.locator(".breadcrumb strong")).toHaveText(a.filename);
  await expect(page.getByLabel("Markdown本文")).toHaveValue("# My local changes");
  await page.getByRole("button", { name: "保存を再試行" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect((await readNote(request, a)).content).toBe("# Updated by AI");
  expect((await readNote(request, b)).content).toBe(b.content);
});

test("英語・ダークテーマでも保存失敗と再試行を表示する", async ({ page, request }) => {
  const { notes: [a, b] } = await setup(page, request);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("radio", { name: /English/ }).click();
  await page.getByRole("radio", { name: /Dark/ }).click();
  await page.getByRole("button", { name: "Back to note", exact: true }).click();
  await page.route(`**/api/notes/${a.id}`, (route) => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"database_busy"}' })
    : route.continue());
  await page.getByLabel("Markdown content").fill("# English unsaved draft");
  await page.getByRole("button", { name: b.filename, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your edits are still on this screen");
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  await expect(page.getByLabel("Markdown content")).toHaveValue("# English unsaved draft");
  await screenshot(page, "save-error-dark-en");
});

test("スマホ幅でもツリーからのノート切替前に本文を保存する", async ({ page, request }) => {
  const { notes: [a, b] } = await setup(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Markdown本文").fill("# Edited on mobile");
  await page.getByRole("button", { name: "ワークスペースを表示", exact: true }).click();
  await page.getByRole("button", { name: b.filename, exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(b.filename);
  await expect(page.getByLabel("Markdown本文")).toHaveValue(b.content);
  expect((await readNote(request, a)).content).toBe("# Edited on mobile");
  expect((await readNote(request, b)).content).toBe(b.content);
});

test("切替先の読み込みが遅くても最後に選択したノートを開き本文を混在させない", async ({ page, request }) => {
  const { notes: [a, b, c] } = await setup(page, request);
  const started = deferred();
  const release = deferred();
  await page.route(`**/api/notes/${b.id}`, async (route) => {
    const response = await route.fetch();
    started.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await page.getByLabel("Markdown本文").fill("# A before rapid navigation");
    await page.getByRole("button", { name: b.filename, exact: true }).click();
    await started.promise;
    await expect(page.getByLabel("Markdown本文")).not.toBeEditable();
    await page.getByRole("button", { name: c.filename, exact: true }).click();
    release.resolve();
    await expect(page.locator(".breadcrumb strong")).toHaveText(c.filename);
    await expect(page.getByLabel("Markdown本文")).toHaveValue(c.content);
    await expect(page.getByLabel("Markdown本文")).toBeEditable();
    expect((await readNote(request, a)).content).toBe("# A before rapid navigation");
    expect((await readNote(request, b)).content).toBe(b.content);
    await page.getByRole("button", { name: a.filename, exact: true }).click();
    await expect(page.getByLabel("Markdown本文")).toHaveValue("# A before rapid navigation");
  } finally { release.resolve(); }
});

for (const operation of ["新規作成", "フォルダ改名", "削除"] as const) {
  test(`保存中の${operation}でも最新の本文を保持する`, async ({ page, request }) => {
    const { notes: [a], folder } = await setup(page, request);
    const started = deferred();
    const release = deferred();
    await page.route(`**/api/notes/${a.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      started.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      await page.getByLabel("Markdown本文").fill(`# A before ${operation}`);
      await started.promise;
      if (operation === "新規作成") {
        await page.getByRole("button", { name: "新規ノート", exact: true }).click();
        await page.getByLabel("ファイル名").fill("New-note.md");
        await page.getByRole("button", { name: "作成", exact: true }).click();
      } else if (operation === "フォルダ改名") {
        await page.getByRole("button", { name: `「${folder.name}」の名前を変更` }).click();
        await page.getByLabel("フォルダ名").fill(`Renamed-${folder.id}`);
        await page.getByRole("button", { name: "変更を保存", exact: true }).click();
      } else {
        page.once("dialog", (dialog) => void dialog.accept());
        await page.getByRole("button", { name: "ノートを削除", exact: true }).click();
      }
      await expect(page.getByLabel("Markdown本文")).not.toBeEditable();
      release.resolve();
      if (operation === "削除") {
        await expect(page.locator(".breadcrumb strong")).not.toHaveText(a.filename);
        const response = await request.get(`/api/trash/${a.id}`);
        expect(response.ok()).toBeTruthy();
        expect((await response.json()).content).toBe(`# A before ${operation}`);
      } else {
        await expect(page.locator(".new-note-dialog")).toBeHidden();
        expect((await readNote(request, a)).content).toBe(`# A before ${operation}`);
        await expect(page.getByLabel("Markdown本文")).toHaveValue(operation === "新規作成" ? "# New-note\n\n" : `# A before ${operation}`);
      }
    } finally { release.resolve(); }
  });
}
