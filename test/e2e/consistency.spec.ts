import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const issues = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  issues.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
});

test.afterEach(async ({ page }, info) => {
  const errors = issues.get(page) ?? [];
  const unexpected = info.title.includes("起動")
    ? errors.filter((error) => !/Failed to load resource:.*(?:status of (?:401|502|503)|net::ERR_FAILED)/.test(error))
    : errors;
  expect(unexpected).toEqual([]);
});

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_CONSISTENCY_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${directory}/${date}-consistency-${name}.png`, animations: "disabled" });
}

async function identity(page: Page) {
  await expect(page).toHaveURL("http://127.0.0.1:8765/");
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
}

async function createNote(request: APIRequestContext, filename: string, content: string, folderId: string | null = null) {
  const response = await request.post("/api/notes", { data: { filename, content, folder_id: folderId } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function openNote(page: Page, filename: string) {
  await page.getByRole("button", { name: "ノートを検索", exact: true }).click();
  await page.getByPlaceholder("タイトルと本文を検索…").fill(filename);
  await expect(page.locator(".search-results > button")).toHaveCount(1);
  await page.locator(".search-results > button").click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(filename);
}

for (const theme of ["light", "dark"]) {
  test(`検索結果はHTMLを実行せず文字とハイライトだけを表示する (${theme})`, async ({ page, request }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const title = `SafeSearch-${suffix}`;
    const content = `# ${title}\n\n危険 <img src="/__xss_probe__" onerror="window.__aonoteXss=1"> needle <svg onload="window.__aonoteXss=2"></svg> &lt;script&gt;`;
    const note = await createNote(request, `${title}.md`, content);
    await page.addInitScript((value) => localStorage.setItem("aonote:theme:v1", value), theme);
    const imageRequests: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/__xss_probe__")) imageRequests.push(request.url()); });
    await page.goto("/");
    await identity(page);
    await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
    await page.getByRole("button", { name: "ノートを検索", exact: true }).click();
    const input = page.getByPlaceholder("タイトルと本文を検索…");
    await input.fill("危");
    const result = page.locator(".search-results > button").filter({ has: page.locator("strong", { hasText: title }) });
    await expect(result.locator("small")).toContainText("<img");
    await expect(result.locator("small img, small svg, small script, small iframe")).toHaveCount(0);
    await screenshot(page, `search-safe-${theme}`);
    await input.fill("needle");
    await expect(result.locator("mark")).toContainText("needle");
    await expect(result.locator("small img, small svg, small script, small iframe")).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { __aonoteXss?: number }).__aonoteXss)).toBeUndefined();
    expect(imageRequests).toEqual([]);
    await result.click();
    await expect(page.locator(".breadcrumb strong")).toHaveText(`${title}.md`);
    expect((await (await request.get(`/api/notes/${note.id}`)).json()).content).toBe(content);
  });
}

test("検索の旧形式レスポンスでもHTMLを実行しない", async ({ page }) => {
  await page.route("**/api/search?*", (route) => route.fulfill({ json: { query: "legacy", results: [{
    id: "legacy", title: "Legacy search", filename: "legacy.md", snippet: '<svg onload="window.__aonoteXss=1"></svg>', rank: 0, updated_at: 0,
  }] } }));
  await page.goto("/");
  await identity(page);
  await page.getByRole("button", { name: "ノートを検索", exact: true }).click();
  await page.getByPlaceholder("タイトルと本文を検索…").fill("legacy");
  await expect(page.locator(".search-results small")).toHaveText('<svg onload="window.__aonoteXss=1"></svg>');
  await expect(page.locator(".search-results small svg")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __aonoteXss?: number }).__aonoteXss)).toBeUndefined();
});

test("同名ノートがあってもWikiリンクのフォルダ指定と同一フォルダを優先する", async ({ page, request }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const folders = [];
  for (const letter of ["A", "B"]) {
    const response = await request.post("/api/folders", { data: { name: `${letter}-${suffix}` } });
    expect(response.ok()).toBeTruthy();
    folders.push(await response.json());
  }
  await createNote(request, "same.md", "# A target", folders[0].id);
  await createNote(request, "same.md", "# B target", folders[1].id);
  const source = await createNote(request, `source-${suffix}.md`, `# Source ${suffix}\n\n[[${folders[0].name}/same.md|Aのノート]]\n\n[[${folders[1].name}/same|Bのノート]]\n\n[[Missing-${suffix}/same|未解決]]\n\n[[ same.md |同じフォルダ]]`, folders[0].id);
  await page.goto("/");
  await identity(page);
  await openNote(page, source.filename);
  for (const [label, expected] of [["Aのノート", "A target"], ["Bのノート", "B target"], ["同じフォルダ", "A target"]]) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByLabel("Markdownプレビュー").getByRole("heading", { name: expected, exact: true })).toBeVisible();
    await page.locator(".backlinks").getByRole("button", { name: `Source ${suffix}`, exact: true }).click();
    await expect(page.locator(".breadcrumb strong")).toHaveText(source.filename);
  }
  await page.getByRole("link", { name: "未解決", exact: true }).click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(source.filename);
});

for (const width of [1440, 768, 390]) {
  test(`Setextと引用・リスト内の見出しも目次と本文で一致する (${width}px)`, async ({ page, request }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const filename = `headings-${suffix}.md`;
    const gap = "段落の本文です。\n\n".repeat(16);
    const content = [
      "# Top", "Setext **one**\n===", "Setext *two*\n---", "> ## Quoted", "- ### Nested",
      "> [!important]\n> ### Alert heading",
      "````markdown\n# Not a heading\n```\n## Still code\n````",
      "    # Indented code", "#### Excluded depth four", "## Last [link](https://example.com) `code`",
    ].join(`\n\n${gap}`) + `\n\n${gap}`;
    const expected = ["Top", "Setext one", "Setext two", "Quoted", "Nested", "Alert heading", "Last link code"];
    await createNote(request, filename, content);
    await page.setViewportSize({ width, height: width > 900 ? 960 : 844 });
    await page.addInitScript((theme) => localStorage.setItem("aonote:theme:v1", theme), width === 390 ? "dark" : "light");
    await page.goto("/");
    await identity(page);
    await openNote(page, filename);
    const outline = page.locator("#note-outline");
    const preview = page.getByLabel("Markdownプレビュー");
    for (const [index, text] of expected.entries()) {
      if (width < 1180) await page.getByRole("button", { name: "目次を表示", exact: true }).click();
      await expect(outline.locator("nav a")).toHaveText(expected);
      const target = preview.locator(`#note-heading-${index}`);
      await expect(target).toHaveText(text);
      await outline.getByRole("link", { name: text, exact: true }).click();
      await expect.poll(() => target.evaluate((heading) => {
        const box = heading.getBoundingClientRect();
        const pane = heading.closest("article")!.getBoundingClientRect();
        return box.top >= pane.top - 1 && box.top < pane.bottom;
      })).toBeTruthy();
    }
    if (width < 1180) await page.getByRole("button", { name: "目次を表示", exact: true }).click();
    await screenshot(page, `outline-${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}

for (const endpoint of ["status", "tree", "recent", "trash", "notes/*"]) {
  test(`起動時の ${endpoint} 503を空データと区別し再試行できる`, async ({ page }) => {
    const route = `**/api/${endpoint}`;
    await page.route(route, (request) => request.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } }));
    await page.goto("/");
    await identity(page);
    const error = page.getByRole("alert");
    await expect(error).toContainText("ワークスペースを読み込めませんでした");
    await expect(error).toContainText("HTTP 503");
    await expect(page.locator(".app-shell")).toHaveCount(0);
    await page.getByRole("button", { name: "読み込みを再試行" }).click();
    await expect(error).toBeVisible();
    if (endpoint === "tree") await screenshot(page, "startup-503-ja");
    await page.unroute(route);
    await page.getByRole("button", { name: "読み込みを再試行" }).click();
    await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
    await expect(page.locator(".breadcrumb strong")).toHaveText("01-ようこそ.md");
    await expect(page.locator(".startup-error")).toHaveCount(0);
  });
}

test("起動時のHTML形式502も英語・ダークテーマ・スマホで再試行できる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("aonote:locale:v1", "en");
    localStorage.setItem("aonote:theme:v1", "dark");
  });
  await page.route("**/api/tree", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad Gateway</h1>" }));
  await page.goto("/");
  await identity(page);
  await expect(page.getByRole("alert")).toContainText("Could not load the workspace");
  await expect(page.getByRole("alert")).toContainText("HTTP 502");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await screenshot(page, "startup-502-en-dark-mobile");
  await page.unroute("**/api/tree");
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByLabel("Markdown preview")).toBeVisible();
  await expect(page.locator(".breadcrumb strong")).toHaveText("01-Welcome.md");
});

test("起動時の通信失敗は再試行でき、401はログイン画面になる", async ({ page }) => {
  await page.route("**/api/tree", (route) => route.abort("failed"));
  await page.goto("/");
  await identity(page);
  await expect(page.getByRole("alert")).toContainText("サーバーに接続できません。");
  await page.unroute("**/api/tree");
  await page.getByRole("button", { name: "読み込みを再試行" }).click();
  await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
  await page.route("**/api/status", (route) => route.fulfill({ status: 401, json: { detail: "Authentication required" } }));
  await page.reload();
  await expect(page.locator('.login-view input[type="password"]')).toBeVisible();
  await expect(page.locator(".startup-error, .app-shell")).toHaveCount(0);
});
