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

for (const theme of ["light", "dark"]) {
  test(`Wikiリンクはコード内を置換せずMermaidのサブルーチンと後続タスクを維持する (${theme})`, async ({ page, request }) => {
    const targetName = `wiki-target-${crypto.randomUUID().slice(0, 8)}.md`;
    const target = await request.post("/api/notes", { data: { filename: targetName, content: "# Actual Wiki target" } });
    expect(target.ok()).toBeTruthy();
    await page.addInitScript((value) => {
      localStorage.setItem("aonote:theme:v1", value);
      localStorage.setItem("aonote:preview-checkboxes:v1", "toggle");
    }, theme);
    const literal = `[[${targetName}]]`;
    const markdown = [
      `## [[${targetName}|通常のWikiリンク]]`, "",
      `Inline: \`${literal}\` and \`\`code \` ${literal}\`\``, "",
      "```mermaid", "flowchart LR", "  A[[内部処理]] --> B[完了]", "```", "",
      "~~~markdown", literal, "~~~", "",
      `    ${literal}`, "",
      `> \`\`\`text`, `> ${literal}`, "> ```", "",
      `[[${targetName}|別のWikiリンク]]`, "",
      "- [ ] 後続タスク", "",
    ].join("\r\n");
    await openDiagramNote(page, request, markdown);
    const filename = await page.locator(".breadcrumb strong").textContent();
    const before = await (await request.get("/api/tree")).json();
    const source = before.find((folder: { id: string }) => folder.id === "unfiled").notes.find((note: { filename: string }) => note.filename === filename);
    const preview = page.getByLabel("Markdownプレビュー");
    await expect(preview.locator(".mermaid-diagram svg")).toBeVisible();
    await expect(preview.locator(".mermaid-diagram")).toContainText("内部処理");
    await expect(preview.locator(".mermaid-error")).toHaveCount(0);
    await expect(preview.locator("a.wikilink")).toHaveCount(2);
    await expect(preview.locator("code")).toHaveText([literal, `code \` ${literal}`, literal, literal, literal]);
    await expect(page.locator("#note-outline nav a").filter({ hasText: "通常のWikiリンク" })).toHaveCount(1);
    const task = preview.getByRole("checkbox", { name: "タスク: 後続タスク", exact: true });
    await task.check();
    await expect(task).toBeChecked();
    await expect.poll(async () => (await (await request.get(`/api/notes/${source.id}`)).json()).content).toBe(source.content.replace("- [ ] 後続タスク", "- [x] 後続タスク"));
    await screenshot(page, `subroutine-${theme}-desktop`);
    await page.locator('.view-switch button[title="分割"]').click();
    // Textarea DOM values normalize CRLF to LF; the stored source above must not.
    await expect(page.getByLabel("Markdown本文")).toHaveValue(source.content.replace("- [ ] 後続タスク", "- [x] 後続タスク").replace(/\r\n/g, "\n"));
    await expect(preview.locator(".mermaid-diagram svg")).toBeVisible();
    if (theme === "dark") {
      await page.locator('.view-switch button[title="プレビュー"]').click();
      await page.setViewportSize({ width: 390, height: 844 });
      await preview.locator(".mermaid-diagram").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await screenshot(page, "subroutine-dark-mobile");
    }
    await preview.getByRole("link", { name: "通常のWikiリンク", exact: true }).click();
    await expect(page.locator(".breadcrumb strong")).toHaveText(targetName);
  });
}
