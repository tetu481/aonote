import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const storageKey = "aonote:preview-checkboxes:v1";
const browserIssues = new WeakMap<Page, string[]>();
const simpleContent = "# Preview tasks\n\n- [ ] First task\n- [x] Second task\n  - [x] Nested task\n";
type TestNote = { id: string; filename: string; content: string; version: number };

test.beforeEach(async ({ page }) => {
  const issues: string[] = [];
  browserIssues.set(page, issues);
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    if (/Failed to load resource:.*status of (409|503)\b/.test(message.text())) return;
    issues.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
});

test.afterEach(async ({ page }) => {
  expect(browserIssues.get(page)).toEqual([]);
});

async function setup(page: Page, request: APIRequestContext, content = simpleContent, mode?: string) {
  if (mode) await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: mode });
  const folderResponse = await request.post("/api/folders", { data: { name: `Checkbox-${crypto.randomUUID().slice(0, 8)}` } });
  expect(folderResponse.ok()).toBeTruthy();
  const folder = await folderResponse.json();
  const notes: TestNote[] = [];
  for (const [letter, body] of [["A", content], ["B", "# Other note\n\n- [ ] Do not change\n"]]) {
    const response = await request.post("/api/notes", { data: { filename: `${letter}-${folder.name}.md`, content: body, folder_id: folder.id } });
    expect(response.ok()).toBeTruthy();
    notes.push(await response.json());
  }
  await page.goto("/");
  await expect(page).toHaveURL("http://127.0.0.1:8765/");
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: folder.name, exact: true }).click();
  await page.getByRole("button", { name: notes[0].filename, exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(notes[0].filename);
  await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
  return notes;
}

async function readNote(request: APIRequestContext, note: TestNote): Promise<TestNote> {
  const response = await request.get(`/api/notes/${note.id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function selectMode(page: Page, mode: string) {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const group = page.getByRole("radiogroup", { name: "プレビューのチェックボックス", exact: true });
  await expect(group.getByRole("radio")).toHaveCount(3);
  await group.locator(`input[value="${mode}"]`).check();
  await expect(group.locator(`input[value="${mode}"]`)).toBeChecked();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(mode);
  await page.getByRole("button", { name: "ノートに戻る", exact: true }).click();
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_CHECKBOX_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${directory}/${date}-preview-checkbox-${name}.png`, animations: "disabled" });
}

test("既定は編集不可で、設定で有効化するとノート切替前にも保存される", async ({ page, request }) => {
  const [a, b] = await setup(page, request);
  await expect(page.getByRole("checkbox", { name: "タスク: First task", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator('.preview-checkbox-options input[value="readonly"]')).toBeChecked();
  await page.getByRole("button", { name: "ノートに戻る", exact: true }).click();
  await selectMode(page, "toggle");
  await page.getByRole("checkbox", { name: "タスク: First task", exact: true }).check();
  await page.getByRole("button", { name: b.filename, exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(b.filename);
  expect((await readNote(request, a)).content).toBe(simpleContent.replace("[ ] First", "[x] First"));
  expect((await readNote(request, b)).content).toBe(b.content);
  await page.reload();
  await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("toggle");
  await page.getByRole("button", { name: a.filename.slice(2, -3), exact: true }).click();
  await page.getByRole("button", { name: a.filename, exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "タスク: First task", exact: true })).toBeChecked();
  await selectMode(page, "readonly");
  await expect(page.getByRole("checkbox", { name: "タスク: First task", exact: true })).toBeDisabled();
});

test("分割表示でWikiリンク・入れ子・引用・CRLF・コードを壊さず該当マーカーだけ更新する", async ({ page, request }) => {
  const source = [
    "# Tasks 🌙", "", "[[Welcome/01-Welcome.md|Welcome]]", "",
    "- [ ] Same", "  - [X] Same", "- [ ] **Formatted** [[Welcome/01-Welcome.md|welcome]]", "  second line", "",
    "1. [ ] Ordered", "2. [x] Done", "", "> - [ ] Quoted", "",
    "> [!important]", ">", "> - [ ] Alert", "", "-", "  [ ] Next line", "",
    "```md", "- [ ] Code stays unchanged", "```", "", "`- [ ] Inline stays unchanged`", "",
  ].join("\r\n");
  const [a] = await setup(page, request, source, "toggle");
  await page.locator('.view-switch button[title="分割"]').click();
  const preview = page.getByLabel("Markdownプレビュー");
  await expect(preview.getByRole("checkbox")).toHaveCount(8);
  const same = preview.getByRole("checkbox", { name: "タスク: Same", exact: true });
  await same.nth(1).uncheck();
  await same.nth(0).check();
  await preview.getByRole("checkbox", { name: "タスク: Formatted welcome second line", exact: true }).check();
  await preview.getByRole("checkbox", { name: "タスク: Ordered", exact: true }).check();
  await preview.getByRole("checkbox", { name: "タスク: Quoted", exact: true }).check();
  await preview.getByRole("checkbox", { name: "タスク: Alert", exact: true }).check();
  await preview.getByRole("checkbox", { name: "タスク: Next line", exact: true }).check();
  const expected = source.replace("[X] Same", "[ ] Same").replace("- [ ] Same", "- [x] Same")
    .replace("[ ] **Formatted**", "[x] **Formatted**").replace("[ ] Ordered", "[x] Ordered")
    .replace("[ ] Quoted", "[x] Quoted").replace("[ ] Alert", "[x] Alert").replace("[ ] Next line", "[x] Next line");
  // Textarea values normalize CRLF to LF; the saved Markdown must preserve CRLF.
  await expect(page.getByLabel("Markdown本文")).toHaveValue(expected.replace(/\r\n/g, "\n"));
  await expect.poll(async () => (await readNote(request, a)).content).toBe(expected);
  await expect(preview.locator(".task-item-text").filter({ hasText: "Formatted" }).first()).not.toHaveCSS("text-decoration-line", "line-through");
  await screenshot(page, "split");
});

test("ONの文字だけに取り消し線を表示し、入れ子のOFF項目とMarkdown本文は維持する", async ({ page, request }) => {
  const source = simpleContent.replace("[x] Nested", "[ ] Nested");
  const [a] = await setup(page, request, source);
  await selectMode(page, "toggle-strikethrough");
  const first = page.getByRole("checkbox", { name: "タスク: First task", exact: true });
  const second = page.getByRole("checkbox", { name: "タスク: Second task", exact: true });
  const firstText = page.locator(".task-item-text").filter({ hasText: /^First task$/ });
  const secondText = page.locator(".task-item-text").filter({ hasText: /^Second task$/ });
  const nestedText = page.locator(".task-item-text").filter({ hasText: /^Nested task$/ });
  await expect(firstText).not.toHaveCSS("text-decoration-line", "line-through");
  await expect(secondText).toHaveCSS("text-decoration-line", "line-through");
  await expect(nestedText).not.toHaveCSS("text-decoration-line", "line-through");
  await second.uncheck();
  await expect(secondText).not.toHaveCSS("text-decoration-line", "line-through");
  await expect(nestedText).not.toHaveCSS("text-decoration-line", "line-through");
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toBeChecked();
  await expect(firstText).toHaveCSS("text-decoration-line", "line-through");
  const expected = source.replace("[ ] First", "[x] First").replace("[x] Second", "[ ] Second");
  await expect.poll(async () => (await readNote(request, a)).content).toBe(expected);
  await screenshot(page, "strike-on-desktop");
  await selectMode(page, "toggle");
  await expect(firstText).not.toHaveCSS("text-decoration-line", "line-through");
  expect((await readNote(request, a)).content).toBe(expected);
});

test("保存中の連続チェックを直列保存し、ノート切替中は操作をロックする", async ({ page, request }) => {
  const [a, b] = await setup(page, request, simpleContent, "toggle");
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  const saving = new Promise<void>((done) => { started = done; });
  const versions: number[] = [];
  await page.route(`**/api/notes/${a.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    versions.push(route.request().postDataJSON().version);
    const response = await route.fetch();
    if (versions.length === 1) { started(); await pending; }
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("checkbox", { name: "タスク: First task", exact: true }).check();
    await saving;
    await page.getByRole("checkbox", { name: "タスク: Second task", exact: true }).uncheck();
    await page.getByRole("button", { name: b.filename, exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "タスク: First task", exact: true })).toBeDisabled();
    release();
    await expect(page.locator(".breadcrumb strong")).toHaveText(b.filename);
    expect(versions).toEqual([a.version, a.version + 1]);
    expect((await readNote(request, a)).content).toBe(simpleContent.replace("[ ] First", "[x] First").replace("[x] Second", "[ ] Second"));
    expect((await readNote(request, b)).content).toBe(b.content);
  } finally { release(); }
});

for (const status of [503, 409]) {
  test(`保存失敗(${status})でもチェックを保持し別ノートを上書きせず再試行できる`, async ({ page, request }) => {
    const [a, b] = await setup(page, request, simpleContent, "toggle");
    let fail = true;
    await page.route(`**/api/notes/${a.id}`, (route) => route.request().method() === "PATCH" && fail
      ? route.fulfill({ status, json: { detail: "Simulated save failure" } }) : route.continue());
    const first = page.getByRole("checkbox", { name: "タスク: First task", exact: true });
    await first.check();
    await expect(page.locator(".save-state")).toHaveText(status === 409 ? "更新の競合" : "保存エラー");
    await page.getByRole("button", { name: b.filename, exact: true }).click();
    await expect(page.locator(".document-error")).toBeVisible();
    await expect(page.locator(".breadcrumb strong")).toHaveText(a.filename);
    await expect(first).toBeChecked();
    expect((await readNote(request, a)).content).toBe(a.content);
    expect((await readNote(request, b)).content).toBe(b.content);
    fail = false;
    await page.getByRole("button", { name: "保存を再試行", exact: true }).click();
    await expect(page.locator(".save-state")).toHaveText("保存済み");
    await expect.poll(async () => (await readNote(request, a)).content).toBe(simpleContent.replace("[ ] First", "[x] First"));
  });
}

test("編集を有効にしていてもゴミ箱のチェックボックスは読み取り専用", async ({ page, request }) => {
  const [a] = await setup(page, request, simpleContent, "toggle-strikethrough");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "ノートを削除", exact: true }).click();
  await page.getByRole("button", { name: "ゴミ箱", exact: true }).click();
  await page.locator(".trash-row").filter({ hasText: a.filename }).click();
  await expect(page.getByRole("checkbox", { name: "タスク: First task", exact: true })).toBeDisabled();
  const response = await request.get(`/api/trash/${a.id}`);
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).content).toBe(a.content);
});

test("日本語・英語とライト・ダークで設定を表示しモバイルでも切り替えられる", async ({ page, request }) => {
  await setup(page, request);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.locator('.preview-checkbox-options input[value="toggle-strikethrough"]').check();
  await page.getByRole("heading", { name: "プレビューのチェックボックス", exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, "settings-ja-light-desktop");
  await page.getByRole("radio", { name: /English/ }).click();
  await page.getByRole("radio", { name: /Dark/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const group = page.getByRole("radiogroup", { name: "Preview checkboxes", exact: true });
  await expect(group.getByRole("radio")).toHaveCount(3);
  await expect(group.locator('input[value="toggle-strikethrough"]')).toBeChecked();
  await group.locator(".preview-checkbox-option").last().scrollIntoViewIfNeeded();
  await expect(group.getByRole("radio").first()).toBeInViewport();
  await expect(group.getByRole("radio").last()).toBeInViewport();
  await screenshot(page, "settings-en-dark-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Back to note", exact: true }).click();
  const first = page.getByRole("checkbox", { name: "Task: First task", exact: true });
  await expect(first).toBeEnabled();
  await first.check();
  await expect(first).toBeChecked();
  await expect(page.locator(".task-item-text").filter({ hasText: /^First task$/ })).toHaveCSS("text-decoration-line", "line-through");
  await screenshot(page, "strike-on-en-dark-mobile");
});

test("未知の保存設定は編集しない設定に戻す", async ({ page, request }) => {
  await setup(page, request, simpleContent, "unknown-mode");
  await expect(page.getByRole("checkbox", { name: "タスク: First task", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("readonly");
});
