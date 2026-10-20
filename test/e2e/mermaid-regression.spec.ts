import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const browserIssues = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const issues: string[] = [];
  browserIssues.set(page, issues);
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) issues.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
});

test.afterEach(async ({ page }) => { expect(browserIssues.get(page)).toEqual([]); });

async function openDiagramNote(page: Page, request: APIRequestContext, content: string) {
  const title = `Mermaid-update-${crypto.randomUUID().slice(0, 8)}`;
  const response = await request.post("/api/notes", { data: { filename: `${title}.md`, content: `# ${title}\n\n${content}` } });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page).toHaveURL("http://127.0.0.1:8765/");
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "ノートを検索", exact: true }).click();
  await page.getByPlaceholder("タイトルと本文を検索…").fill(title);
  await page.locator(".search-results > button").click();
  await expect(page.locator(".breadcrumb strong")).toHaveText(`${title}.md`);
  await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.AONOTE_MERMAID_SCREENSHOT_DIR;
  if (!directory) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${directory}/${date}-mermaid-update-${name}.png`, animations: "disabled" });
}

const charts = [
  "```mermaid", "flowchart LR", '  A["$$x^2 + y^2 = z^2$$"] --> B["数式を保存"]', "```", "",
  "```mermaid", "sequenceDiagram", "  participant User as 利用者", "  participant App as aonote",
  "  User->>App: ノートを作成", "  App-->>User: 保存完了", "```", "",
  "```mermaid", "---", "config:", "  layout: elk", "---", "flowchart LR",
  '  A["開始"] --> B["完了"]', "```", "",
].join("\n");

for (const theme of ["light", "dark"]) {
  test(`Mermaid 12の数式・シーケンス図・ELKをプレビューと分割表示で描画する (${theme})`, async ({ page, request }) => {
    await page.addInitScript((value) => localStorage.setItem("aonote:theme:v1", value), theme);
    await openDiagramNote(page, request, charts);
    const diagrams = page.locator(".mermaid-diagram");
    await expect(diagrams).toHaveCount(3, { timeout: 20_000 });
    for (let index = 0; index < 3; index++) await expect(diagrams.nth(index).locator("svg")).toBeVisible();
    await expect(diagrams.first().locator(".katex")).toHaveCount(1);
    await expect(diagrams.first().locator(".katex mi")).toHaveText(["x", "y", "z"]);
    await expect(diagrams.nth(1)).toContainText("保存完了");
    const textColor = await page.locator("html").evaluate((element) => getComputedStyle(element).color);
    await expect(diagrams.nth(1).locator(".messageText").first()).toHaveCSS("fill", textColor);
    await expect(diagrams.nth(2)).toContainText("開始");
    await expect(page.locator(".mermaid-error")).toHaveCount(0);
    await screenshot(page, `${theme}-desktop`);
    await page.locator('.view-switch button[title="分割"]').click();
    await expect(page.getByLabel("Markdown本文")).toBeVisible();
    await expect(page.getByLabel("Markdown本文")).toHaveValue(new RegExp("layout: elk"));
    await expect(diagrams).toHaveCount(3);
    await page.locator('.view-switch button[title="プレビュー"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await diagrams.first().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    for (let index = 0; index < 3; index++) {
      const frame = await diagrams.nth(index).boundingBox();
      const svg = await diagrams.nth(index).locator("svg").boundingBox();
      expect(frame).not.toBeNull();
      expect(svg).not.toBeNull();
      expect(svg!.width).toBeLessThanOrEqual(frame!.width + 1);
    }
    await screenshot(page, `${theme}-mobile`);
  });
}

test("Mermaidのラベルとリンクをstrict設定で無害化する", async ({ page, request }) => {
  await openDiagramNote(page, request, [
    "```mermaid", "flowchart LR",
    '  A["<img src=x onerror=window.__mermaidSecurityProbe=1>"] --> B["Safe"]',
    '  click B "javascript:window.__mermaidSecurityProbe=2"', "```",
  ].join("\n"));
  const diagram = page.locator(".mermaid-diagram");
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 15_000 });
  await expect(diagram.locator("script, [onerror], [onload]")).toHaveCount(0);
  const hrefs = await diagram.locator("a").evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? ""));
  expect(hrefs.every((href) => !/^\s*javascript:/i.test(href))).toBeTruthy();
  expect(await page.evaluate(() => (window as Window & { __mermaidSecurityProbe?: number }).__mermaidSecurityProbe)).toBeUndefined();
});
