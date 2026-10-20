import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const storageKey = "aonote:workspace-session:v1";
type TestNote = { id: string; filename: string; content: string; version: number };
const issues = new WeakMap<Page, string[]>();
const allowedStatuses = new WeakMap<Page, Set<number>>();

function monitor(page: Page) {
  const errors: string[] = [];
  const statuses = new Set<number>();
  issues.set(page, errors);
  allowedStatuses.set(page, statuses);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    const status = /Failed to load resource:.*status of (\d+)/.exec(message.text());
    if (status && statuses.has(Number(status[1]))) return;
    errors.push(message.text());
  });
}

test.beforeEach(async ({ page }) => {
  monitor(page);
  await page.setViewportSize({ width: 1440, height: 960 });
});

test.afterEach(async ({ page }) => { expect(issues.get(page)).toEqual([]); });

async function seed(request: APIRequestContext) {
  const folderResponse = await request.post("/api/folders", { data: { name: `Session-${crypto.randomUUID().slice(0, 8)}` } });
  expect(folderResponse.ok()).toBeTruthy();
  const folder = await folderResponse.json();
  const notes: TestNote[] = [];
  for (const letter of ["A", "B"]) {
    const response = await request.post("/api/notes", { data: {
      filename: `${letter}-${folder.name}.md`, folder_id: folder.id, content: `# ${letter} remembered note\n\n- [ ] Task`,
    } });
    expect(response.ok()).toBeTruthy();
    notes.push(await response.json());
  }
  return { folder, notes };
}

async function ready(page: Page) {
  await expect(page).toHaveURL("http://127.0.0.1:8765/");
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator(".breadcrumb strong")).toBeVisible();
}

async function openNote(page: Page, folderName: string, note: TestNote) {
  const folder = page.getByRole("button", { name: folderName, exact: true });
  if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
  await page.getByRole("button", { name: note.filename, exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(note.filename);
}

async function stored(page: Page) {
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_WORKSPACE_SESSION_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${directory}/${date}-workspace-session-${name}.png`, animations: "disabled" });
}

for (const view of ["preview", "edit", "split"]) {
  test(`再読み込みで最後のノート・表示モード・格納フォルダを復元する (${view})`, async ({ page, request }) => {
    const { folder, notes: [a] } = await seed(request);
    await page.goto("/");
    await ready(page);
    await openNote(page, folder.name, a);
    await page.locator(`.view-switch button[title="${{ preview: "プレビュー", edit: "編集", split: "分割" }[view]}"]`).click();
    await expect.poll(async () => (await stored(page))?.view).toBe(view);
    const before = await stored(page);
    expect(Object.keys(before).sort()).toEqual(["noteId", "updatedAt", "view"]);
    expect(before.noteId).toBe(a.id);
    await page.reload();
    await ready(page);
    await expect(page.locator(".breadcrumb strong")).toHaveText(a.filename);
    await expect(page.locator(".document-workarea")).toHaveClass(new RegExp(`view-${view}`));
    await expect(page.getByRole("button", { name: folder.name, exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: a.filename, exact: true })).toHaveClass(/selected/);
    if (view !== "preview") await expect(page.getByLabel("Markdown本文")).toHaveValue(a.content);
    await expect.poll(async () => (await stored(page))?.updatedAt).toBeGreaterThan(before.updatedAt);
    await screenshot(page, `restored-${view}-desktop`);
  });
}

for (const hours of [1, 2]) {
  test(`APIから受け取った${hours}時間の期限で90分前のセッションを判定する`, async ({ page, request }) => {
    const { folder, notes: [a] } = await seed(request);
    await page.route("**/api/status", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), workspace_session_hours: hours } });
    });
    await page.goto("/");
    await ready(page);
    await openNote(page, folder.name, a);
    await page.evaluate(({ key, noteId }) => sessionStorage.setItem(key, JSON.stringify({
      noteId, view: "split", updatedAt: Date.now() - 90 * 60_000,
    })), { key: storageKey, noteId: a.id });
    await page.reload();
    await ready(page);
    await expect(page.locator(".breadcrumb strong")).toHaveText(hours === 1 ? "01-ようこそ.md" : a.filename);
    await expect(page.locator(".document-workarea")).toHaveClass(new RegExp(`view-${hours === 1 ? "preview" : "split"}`));
    expect((await stored(page)).noteId === a.id).toBe(hours === 2);
  });
}

for (const locale of ["ja", "en"]) {
  test(`記録がない場合は言語に応じたようこそノートを表示する (${locale})`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("aonote:locale:v1", value), locale);
    await page.goto("/");
    await ready(page);
    await expect(page.locator(".breadcrumb strong")).toHaveText(locale === "ja" ? "01-ようこそ.md" : "01-Welcome.md");
    await expect(page.locator(".document-workarea")).toHaveClass(/view-preview/);
  });
}

for (const value of ["not-json", "null", '"string"', '{"noteId":"unknown","view":"invalid","updatedAt":0}']) {
  test(`壊れたセッションでも初期表示できる (${value})`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), { key: storageKey, value });
    await page.goto("/");
    await ready(page);
    await expect(page.locator(".breadcrumb strong")).toHaveText("01-ようこそ.md");
    expect((await stored(page)).view).toBe("preview");
  });
}

test("削除済みノートの記録はようこそノートに戻す", async ({ page, request }) => {
  const { folder, notes: [a] } = await seed(request);
  await page.goto("/");
  await ready(page);
  await openNote(page, folder.name, a);
  const response = await request.delete(`/api/notes/${a.id}`);
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await ready(page);
  await expect(page.locator(".breadcrumb strong")).toHaveText("01-ようこそ.md");
  expect((await stored(page)).noteId).not.toBe(a.id);
});

test("ツリー取得直後に対象ノートが404になってもようこそへ戻せる", async ({ page, request }) => {
  const { folder, notes: [a] } = await seed(request);
  await page.goto("/");
  await ready(page);
  await openNote(page, folder.name, a);
  allowedStatuses.get(page)!.add(404);
  await page.route(`**/api/notes/${a.id}`, (route) => route.fulfill({ status: 404, json: { detail: "Note not found" } }));
  await page.reload();
  await ready(page);
  await expect(page.locator(".breadcrumb strong")).toHaveText("01-ようこそ.md");
  await expect(page.locator(".startup-error, .document-error")).toHaveCount(0);
});

test("復元時の通信エラーでは記録を保持し再試行で元のノートを復元する", async ({ page, request }) => {
  const { folder, notes: [a] } = await seed(request);
  await page.goto("/");
  await ready(page);
  await openNote(page, folder.name, a);
  await page.locator('.view-switch button[title="分割"]').click();
  await expect.poll(async () => (await stored(page))?.view).toBe("split");
  const before = await stored(page);
  let fail = true;
  allowedStatuses.get(page)!.add(503);
  await page.route(`**/api/notes/${a.id}`, (route) => fail
    ? route.fulfill({ status: 503, json: { detail: "Temporary failure" } }) : route.continue());
  await page.reload();
  await expect(page.locator(".startup-error")).toBeVisible();
  expect(await stored(page)).toEqual(before);
  fail = false;
  await page.getByRole("button", { name: "読み込みを再試行", exact: true }).click();
  await ready(page);
  await expect(page.locator(".breadcrumb strong")).toHaveText(a.filename);
  await expect(page.locator(".document-workarea")).toHaveClass(/view-split/);
});

test("ストレージを利用できなくてもノートを開いて操作できる", async ({ page, request }) => {
  const { folder, notes: [a] } = await seed(request);
  await page.addInitScript(() => Object.defineProperty(window, "sessionStorage", {
    get() { throw new DOMException("Storage unavailable", "SecurityError"); },
  }));
  await page.goto("/");
  await ready(page);
  await openNote(page, folder.name, a);
  await page.reload();
  await ready(page);
  await expect(page.locator(".breadcrumb strong")).toHaveText("01-ようこそ.md");
});

test("タブごとにノートを記憶し、スマホ幅でも再読み込みで復元する", async ({ page, context, request }) => {
  const { folder, notes: [a, b] } = await seed(request);
  await page.goto("/");
  await ready(page);
  await openNote(page, folder.name, a);
  const second = await context.newPage();
  monitor(second);
  try {
    await second.goto("/");
    await ready(second);
    await expect(second.locator(".breadcrumb strong")).toHaveText("01-ようこそ.md");
    await openNote(second, folder.name, b);
    await second.reload();
    await ready(second);
    await expect(second.locator(".breadcrumb strong")).toHaveText(b.filename);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await ready(page);
    await expect(page.locator(".breadcrumb strong")).toHaveText(a.filename);
    await screenshot(page, "restored-mobile");
    expect(issues.get(second)).toEqual([]);
  } finally { await second.close(); }
});

test("改名・移動後もIDで復元し現在の格納フォルダを展開する", async ({ page, request }) => {
  const { folder, notes: [a] } = await seed(request);
  await page.goto("/");
  await ready(page);
  await openNote(page, folder.name, a);
  const folderResponse = await request.post("/api/folders", { data: { name: `Moved-${folder.name}` } });
  expect(folderResponse.ok()).toBeTruthy();
  const destination = await folderResponse.json();
  const response = await request.patch(`/api/notes/${a.id}/location`, { data: { filename: "renamed.md", folder_id: destination.id, version: a.version } });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await ready(page);
  await expect(page.locator(".breadcrumb")).toContainText(destination.name);
  await expect(page.locator(".breadcrumb strong")).toHaveText("renamed.md");
  await expect(page.getByRole("button", { name: destination.name, exact: true })).toHaveAttribute("aria-expanded", "true");
  expect((await stored(page)).noteId).toBe(a.id);
});
