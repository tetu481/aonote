import { expect, test, type Page } from "@playwright/test";

async function selectOptionContaining(page: Page, selector: string, text: string) {
  const option = page.locator(`${selector} option`).filter({ hasText: text }).first();
  const value = await option.getAttribute("value");
  expect(value).toBeTruthy();
  await page.locator(selector).selectOption(value!);
}

test("ワークスペース機能をデスクトップで操作できる", async ({ page, context }) => {
  const browserIssues: string[] = [];
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) browserIssues.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => browserIssues.push(`pageerror: ${error.message}`));
  const suffix = Date.now().toString().slice(-7);
  const rootName = `QA-${suffix}`;
  const secondName = `第二-${suffix}`;
  const renamedFolder = `第二改名-${suffix}`;
  const thirdName = `第三-${suffix}`;
  const noteBase = `検証ノート-${suffix}`;
  const renamed = `改名ノート-${suffix}.md`;

  await page.setViewportSize({ width: 1440, height: 960 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8765" });
  await page.goto("/");
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/assets/favicon.svg");
  const favicon = await page.evaluate(async () => {
    const response = await fetch("/assets/favicon.svg");
    return { ok: response.ok, contentType: response.headers.get("content-type"), body: await response.text() };
  });
  expect(favicon.ok).toBeTruthy();
  expect(favicon.contentType).toContain("image/svg+xml");
  expect(favicon.body.match(/<path /g)).toHaveLength(2);
  await expect(page.getByLabel("aonote")).toContainText("aonote");
  await expect(page.getByLabel("ユーザー")).toHaveCount(0);
  await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
  await expect(page.getByLabel("Markdownエディタ")).toHaveCount(0);
  await expect(page.getByText("作成者", { exact: true })).toBeVisible();
  await expect(page.getByText("管理者", { exact: true }).first()).toBeVisible();
  const filenameBox = await page.locator(".breadcrumb strong").boundingBox();
  const copyButtonBox = await page.getByRole("button", { name: "パスをコピー", exact: true }).boundingBox();
  expect(filenameBox).not.toBeNull();
  expect(copyButtonBox).not.toBeNull();
  expect(copyButtonBox!.x - (filenameBox!.x + filenameBox!.width)).toBeLessThanOrEqual(8);
  await page.locator('button[title="分割"]').click();
  await expect(page.getByLabel("Markdownエディタ")).toBeVisible();

  const createFolder = async (name: string, parent?: string) => {
    await page.getByRole("button", { name: "新規フォルダ" }).click();
    const dialog = page.locator(".new-note-dialog");
    await expect(dialog.getByRole("heading", { name: "新しいフォルダ" })).toBeVisible();
    await dialog.getByLabel("フォルダ名").fill(name);
    if (parent) await selectOptionContaining(page, ".new-note-dialog select", parent);
    await dialog.getByRole("button", { name: "作成", exact: true }).click();
    await expect(dialog).toBeHidden();
  };

  await createFolder(rootName);
  await createFolder(secondName, rootName);
  await createFolder(thirdName, secondName);

  await page.getByRole("button", { name: "新規フォルダ" }).click();
  await expect(page.locator(".new-note-dialog select option").filter({ hasText: thirdName })).toHaveCount(0);
  await page.getByRole("button", { name: "キャンセル" }).click();

  await page.getByRole("button", { name: "新規ノート" }).click();
  const noteDialog = page.locator(".new-note-dialog");
  await noteDialog.getByLabel("ファイル名").fill(`${noteBase}.md`);
  await selectOptionContaining(page, ".new-note-dialog select", thirdName);
  await noteDialog.getByRole("button", { name: "作成", exact: true }).click();
  await expect(noteDialog).toBeHidden();
  await expect(page.getByLabel("Markdown本文")).toHaveValue(new RegExp(noteBase));

  const rootButton = page.getByRole("button", { name: rootName, exact: true });
  const secondButton = page.getByRole("button", { name: secondName, exact: true });
  const thirdButton = page.getByRole("button", { name: thirdName, exact: true });
  await expect(rootButton).toHaveAttribute("aria-expanded", "true");
  await rootButton.click();
  await expect(rootButton).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "ノートを検索" }).click();
  await page.getByPlaceholder("タイトルと本文を検索…").fill(noteBase);
  await page.locator(".search-results").getByRole("button", { name: new RegExp(noteBase) }).click();
  await expect(rootButton).toHaveAttribute("aria-expanded", "true");
  await expect(secondButton).toHaveAttribute("aria-expanded", "true");
  await expect(thirdButton).toHaveAttribute("aria-expanded", "true");

  await rootButton.click();
  await page.getByRole("button", { name: "最近のノート", exact: true }).click();
  await page.locator(".recent-row").filter({ hasText: noteBase }).click();
  await expect(page.getByText("ワークスペース", { exact: true })).toBeVisible();
  await expect(rootButton).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: `「${secondName}」の名前を変更` }).click();
  const renameFolderDialog = page.locator(".new-note-dialog");
  await expect(renameFolderDialog.getByRole("heading", { name: "フォルダ名を変更" })).toBeVisible();
  await renameFolderDialog.getByLabel("フォルダ名").fill(renamedFolder);
  await renameFolderDialog.getByRole("button", { name: "変更を保存" }).click();
  await expect(renameFolderDialog).toBeHidden();
  await expect(page.locator(".breadcrumb")).toContainText(renamedFolder);
  const renamedFolderButton = page.getByRole("button", { name: renamedFolder, exact: true });
  await expect(renamedFolderButton).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("未整理");
    await dialog.accept();
  });
  await page.getByRole("button", { name: `「${renamedFolder}」を削除` }).click();
  await expect(renamedFolderButton).toHaveCount(0);
  await expect(page.getByRole("button", { name: thirdName, exact: true })).toHaveCount(0);
  await expect(page.locator(".breadcrumb")).toContainText("未整理");
  await expect(page.getByLabel("Markdown本文")).toHaveValue(new RegExp(noteBase));

  await page.getByRole("button", { name: "ノートの名前と保存先を変更" }).click();
  const organize = page.locator(".new-note-dialog");
  await organize.getByLabel("ファイル名").fill(renamed);
  await selectOptionContaining(page, ".new-note-dialog select", rootName);
  await organize.getByRole("button", { name: "変更を保存" }).click();
  await expect(organize).toBeHidden();
  await expect(page.locator(".breadcrumb")).toContainText(renamed);
  await expect(page.locator(".breadcrumb")).toContainText(rootName);
  await page.getByRole("button", { name: "パスをコピー", exact: true }).click();
  await expect(page.getByRole("button", { name: "パスをコピーしました" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${rootName}/${renamed}`);

  await page.evaluate(async ({ filename }) => {
    const tree = await fetch("/api/tree").then((response) => response.json());
    const notes = (nodes: any[]): any[] => nodes.flatMap((node) => [...node.notes, ...notes(node.folders)]);
    const summary = notes(tree).find((item) => item.filename === filename);
    const note = await fetch(`/api/notes/${summary.id}`).then((response) => response.json());
    await fetch(`/api/notes/${summary.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `${note.content}\n外部更新-${filename}`, version: note.version }),
    });
  }, { filename: renamed });
  await page.getByRole("button", { name: "ツリーとノートを再読み込み" }).click();
  await expect(page.getByLabel("Markdown本文")).toHaveValue(new RegExp(`外部更新-${renamed}`));

  const sidebar = page.locator(".sidebar-shell");
  await expect(sidebar).toBeVisible();
  await page.getByRole("button", { name: "ワークスペースを隠す" }).click();
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "ワークスペースを表示" }).click();
  await expect(sidebar).toBeVisible();

  await rootButton.hover();
  await page.screenshot({ path: "/tmp/aonote-desktop.png", fullPage: false });
  expect(browserIssues).toEqual([]);
});

test("初期プレビューで表示名だけを表示し接続元はツールチップに出す", async ({ page }) => {
  const browserIssues: string[] = [];
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) browserIssues.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => browserIssues.push(`pageerror: ${error.message}`));
  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch();
    const note = await response.json();
    note.created_by = "レビュー担当";
    note.created_via = "ChatGPT";
    note.updated_by = "レビュー担当";
    note.updated_via = "ChatGPT";
    await route.fulfill({ response, json: note });
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByLabel("Markdownプレビュー")).toBeVisible();
  await expect(page.getByLabel("Markdownエディタ")).toHaveCount(0);
  const actor = page.locator(".actor-name").first();
  await expect(actor).toHaveText("レビュー担当");
  await expect(page.getByText("ChatGPT経由", { exact: true })).toHaveCount(0);
  await actor.hover();
  await expect.poll(() => actor.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("1");
  await expect.poll(() => actor.evaluate((element) => getComputedStyle(element, "::after").content)).toContain("ChatGPT経由");
  await actor.focus();
  await expect(actor).toBeFocused();
  await page.screenshot({ path: "/tmp/aonote-author-tooltip.png", fullPage: false });
  expect(browserIssues).toEqual([]);
});

test("Markdown AlertsとMermaidをプレビューできる", async ({ page, request }) => {
  const browserIssues: string[] = [];
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) browserIssues.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => browserIssues.push(`pageerror: ${error.message}`));
  const suffix = Date.now().toString().slice(-7);
  const title = `Markdown拡張-${suffix}`;
  const content = `# ${title}

> [!NOTE]
> 補足情報です。

> [!TIP]
> 便利なヒントです。

> [!IMPORTANT]
> 必ず確認してください。

> [!WARNING]
> 操作前の警告です。

> [!CAUTION]
> データに注意してください。

> 通常の引用です。

\`\`\`mermaid
flowchart LR
  A[ノート] --> B{確認}
  B -->|OK| C[保存]
\`\`\`
`;
  const created = await request.post("/api/notes", { data: { filename: `${title}.md`, content, folder_id: null } });
  expect(created.ok()).toBeTruthy();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "ノートを検索" }).click();
  await page.getByPlaceholder("タイトルと本文を検索…").fill(title);
  await page.locator(".search-results").getByRole("button", { name: new RegExp(title) }).click();

  const preview = page.getByLabel("Markdownプレビュー");
  await expect(preview.locator(".markdown-alert-note")).toContainText("補足情報です");
  await expect(preview.locator(".markdown-alert-tip")).toContainText("便利なヒントです");
  await expect(preview.locator(".markdown-alert-important")).toContainText("必ず確認してください");
  await expect(preview.locator(".markdown-alert-warning")).toContainText("操作前の警告です");
  await expect(preview.locator(".markdown-alert-caution")).toContainText("データに注意してください");
  await expect(preview.locator("blockquote:not(.markdown-alert)")).toContainText("通常の引用です");
  const diagram = preview.getByLabel("Mermaid図");
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "/tmp/aonote-markdown-alerts.png", fullPage: false });

  await page.setViewportSize({ width: 1674, height: 868 });
  await page.getByRole("button", { name: "ワークスペースを隠す" }).click();
  const headingBox = await preview.locator("h1").boundingBox();
  const alertBox = await preview.locator(".markdown-alert-important").boundingBox();
  const previewDiagramBox = await diagram.boundingBox();
  const previewSvgBox = await diagram.locator("svg").boundingBox();
  expect(headingBox).not.toBeNull();
  expect(alertBox).not.toBeNull();
  expect(previewDiagramBox).not.toBeNull();
  expect(previewSvgBox).not.toBeNull();
  expect(Math.abs(headingBox!.x - alertBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(previewDiagramBox!.x - alertBox!.x)).toBeLessThanOrEqual(2);
  expect(previewDiagramBox!.width).toBeGreaterThan(alertBox!.width + 200);
  expect(previewSvgBox!.width).toBeGreaterThan(alertBox!.width);
  await diagram.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/aonote-mermaid-preview-wide.png", fullPage: false });

  await page.locator('button[title="分割"]').click();
  await expect(page.getByLabel("Markdownエディタ")).toBeVisible();
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 15_000 });
  const splitDiagramBox = await diagram.boundingBox();
  expect(splitDiagramBox).not.toBeNull();
  expect(splitDiagramBox!.width).toBeLessThan(previewDiagramBox!.width);
  await page.locator('button[title="プレビュー"]').click();
  await expect(page.getByLabel("Markdownエディタ")).toHaveCount(0);
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 15_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  const breadcrumbBox = await page.locator(".breadcrumb").boundingBox();
  expect(breadcrumbBox).not.toBeNull();
  expect(breadcrumbBox!.height).toBeLessThanOrEqual(24);
  await diagram.scrollIntoViewIfNeeded();
  const diagramBox = await diagram.boundingBox();
  const svgBox = await diagram.locator("svg").boundingBox();
  expect(diagramBox).not.toBeNull();
  expect(svgBox).not.toBeNull();
  expect(svgBox!.width).toBeLessThanOrEqual(diagramBox!.width);
  await page.screenshot({ path: "/tmp/aonote-mermaid-mobile.png", fullPage: false });
  expect(browserIssues).toEqual([]);
});

test("モバイルのハンバーガーメニューでワークスペースを開閉できる", async ({ page }) => {
  const browserIssues: string[] = [];
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) browserIssues.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => browserIssues.push(`pageerror: ${error.message}`));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const sidebar = page.locator(".sidebar-shell");
  await expect(sidebar).not.toHaveClass(/mobile-open/);
  await page.getByRole("button", { name: "ワークスペースを表示" }).click();
  await expect(sidebar).toHaveClass(/mobile-open/);
  await expect(page.getByRole("button", { name: "サイドバーを閉じる" })).toBeVisible();
  await page.getByRole("button", { name: "ワークスペースを隠す" }).click();
  await expect(sidebar).not.toHaveClass(/mobile-open/);
  const outline = page.getByLabel("ノートの目次と情報");
  await expect(outline).toBeHidden();
  await page.getByRole("button", { name: "目次を表示" }).click();
  await expect(outline).toBeVisible();
  await expect(outline.getByText("作成者", { exact: true })).toBeVisible();
  await expect(outline.getByRole("button", { name: "目次を閉じる" })).toBeFocused();
  await page.screenshot({ path: "/tmp/aonote-mobile-outline.png", fullPage: false });
  await outline.getByRole("button", { name: "目次を閉じる" }).click();
  await expect(outline).toBeHidden();
  expect(browserIssues).toEqual([]);
});

test("iPad幅でも右上から目次を開閉できる", async ({ page }) => {
  const browserIssues: string[] = [];
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) browserIssues.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => browserIssues.push(`pageerror: ${error.message}`));
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  const outline = page.getByLabel("ノートの目次と情報");
  const outlineToggle = page.getByRole("button", { name: "目次を表示" });
  await expect(outlineToggle).toBeVisible();
  await expect(outline).toBeHidden();
  await outlineToggle.click();
  await expect(outline).toBeVisible();
  await page.screenshot({ path: "/tmp/aonote-ipad-outline.png", fullPage: false });
  await outline.getByRole("button", { name: "目次を閉じる" }).click();
  await expect(outline).toBeHidden();
  expect(browserIssues).toEqual([]);
});
