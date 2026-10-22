import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const base = "http://127.0.0.1:8765";
const issues = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  issues.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    if (/Failed to load resource:.*status of (409|503)\b/.test(message.text())) return;
    errors.push(message.text());
  });
});

test.afterEach(async ({ page }) => expect(issues.get(page)).toEqual([]));

async function connect(request: APIRequestContext, name: string, scopes = "notes:read notes:search notes:write", clientId?: string) {
  const redirect = "https://example.com/ai/callback";
  const client_id = clientId ?? (await (await request.post("/oauth/register", { data: { client_name: "Hermes Agent (テスト)", redirect_uris: [redirect] } })).json()).client_id;
  const verifier = "browser-test-code-verifier-with-at-least-43-characters";
  const authorization = await request.post("/oauth/authorize", {
    form: { client_id, redirect_uri: redirect, scope: scopes, requested_scope: scopes, actor_name: name,
      resource: `${base}/mcp`, password: "test-e2e-password", code_challenge: createHash("sha256").update(verifier).digest("base64url") },
    maxRedirects: 0,
  });
  expect(authorization.status()).toBe(303);
  const code = new URL(authorization.headers().location).searchParams.get("code")!;
  const exchange = await request.post("/oauth/token", { form: { grant_type: "authorization_code", client_id, code, code_verifier: verifier, redirect_uri: redirect, resource: `${base}/mcp` } });
  expect(exchange.ok()).toBeTruthy();
  return { client_id, ...await exchange.json() } as { client_id: string; access_token: string; refresh_token: string };
}

async function tool(request: APIRequestContext, token: string, name: string, args = {}) {
  return request.post("/mcp", { headers: { Authorization: `Bearer ${token}` }, data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
}

async function openConnections(page: Page, english = false) {
  await page.goto("/");
  await expect(page).toHaveURL(`${base}/`);
  await expect(page).toHaveTitle("aonote");
  await expect(page.locator("vite-error-overlay, nextjs-portal")).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1440) < 768) await page.getByRole("button", { name: english ? "Show workspace" : "ワークスペースを表示", exact: true }).click();
  await page.getByRole("button", { name: english ? "Settings" : "設定", exact: true }).click();
  if ((page.viewportSize()?.width ?? 1440) < 768) await page.getByRole("button", { name: english ? "Show workspace" : "ワークスペースを表示", exact: true }).click();
  const settingsMenu = page.locator(".sidebar-panel");
  const displaySettings = settingsMenu.getByRole("button", { name: english ? "Display settings" : "表示設定", exact: true });
  const connections = settingsMenu.getByRole("button", { name: english ? "Manage AI connections" : "接続AI管理", exact: true });
  await expect(settingsMenu.locator(".settings-nav-row")).toHaveCount(3);
  await expect(displaySettings).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".settings-sections")).toHaveCount(0);
  await connections.click();
  await expect(connections).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: english ? "Manage AI connections" : "接続AI管理", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: english ? "Connected AI" : "接続済みAI", exact: true })).toBeVisible();
  await expect(page.locator(".connections-panel")).toHaveAttribute("aria-busy", "false");
}

async function screenshot(page: Page, suffix: string) {
  if (!process.env.AONOTE_CONNECTION_SCREENSHOT_DIR) return;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
  await page.screenshot({ path: `${process.env.AONOTE_CONNECTION_SCREENSHOT_DIR}/${date}-ai-connections-${suffix}.png`, animations: "disabled" });
}

test("接続の編集・権限制限・個別解除が実際のMCPに反映される", async ({ page, request }) => {
  const unique = crypto.randomUUID().slice(0, 6);
  const name = `ノート整理アシスタント-${unique}`;
  const secondName = `読み取り専用AI-${unique}`;
  const tokens = await connect(request, name);
  const second = await connect(request, secondName, "notes:read", tokens.client_id);
  await tool(request, tokens.access_token, "list_notes");
  await page.setViewportSize({ width: 1440, height: 960 });
  await openConnections(page);
  let card = page.getByRole("article", { name: `${name} (Hermes Agent (テスト))`, exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator(".connection-status")).toHaveText("有効");
  await card.getByText("接続の詳細", { exact: true }).click();
  await expect(card).toContainText(tokens.client_id);
  await screenshot(page, "desktop-light");
  await card.getByRole("button", { name: "情報・権限を編集" }).click();
  await card.getByLabel("表示名", { exact: true }).fill(`調査担当-${unique}`);
  await card.getByRole("checkbox", { name: /書き込み/ }).uncheck();
  await card.getByRole("checkbox", { name: /検索/ }).uncheck();
  await card.getByRole("button", { name: "変更を保存" }).click();
  card = page.getByRole("article", { name: `調査担当-${unique} (Hermes Agent (テスト))`, exact: true });
  await expect(card).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "接続情報を保存しました" })).toBeVisible();
  const denied = (await (await tool(request, tokens.access_token, "create_note", { filename: `forbidden-${unique}.md`, content: "# Denied" })).json()).result;
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain("OAuth scope required: notes:write");
  await card.getByRole("button", { name: "情報・権限を編集" }).click();
  await card.getByRole("checkbox", { name: /書き込み/ }).check();
  await card.getByRole("button", { name: "変更を保存" }).click();
  await expect(card.getByRole("button", { name: "情報・権限を編集" })).toBeVisible();
  const created = await (await tool(request, tokens.access_token, "create_note", { filename: `connection-${unique}.md`, content: "# AI connection test" })).json();
  expect(created.result.isError).not.toBe(true);
  const note = JSON.parse(created.result.content[0].text);
  expect(note.created_by).toBe(`調査担当-${unique}`);
  const rotation = await request.post("/oauth/token", { form: { grant_type: "refresh_token", client_id: tokens.client_id, refresh_token: tokens.refresh_token, resource: `${base}/mcp` } });
  expect(rotation.ok()).toBeTruthy();
  const rotated = await rotation.json();
  page.once("dialog", (dialog) => dialog.dismiss());
  await card.getByRole("button", { name: "接続を解除", exact: true }).click();
  await expect(card.locator(".connection-status")).toHaveText("有効");
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "接続を解除", exact: true }).click();
  await expect(card.locator(".connection-status")).toHaveText("解除済み");
  expect((await tool(request, tokens.access_token, "list_notes")).status()).toBe(401);
  expect((await tool(request, rotated.access_token, "list_notes")).status()).toBe(401);
  expect((await request.post("/oauth/token", { form: { grant_type: "refresh_token", client_id: tokens.client_id, refresh_token: rotated.refresh_token, resource: `${base}/mcp` } })).status()).toBe(400);
  expect((await tool(request, second.access_token, "list_notes")).ok()).toBeTruthy();
  expect((await request.get(`/api/notes/${note.id}`)).ok()).toBeTruthy();
  await page.getByRole("button", { name: "接続一覧を再読み込み" }).click();
  await expect(card.locator(".connection-status")).toHaveText("解除済み");
});

test("読み込み失敗・保存失敗を表示し、入力を保持して再試行できる", async ({ page, request }) => {
  const name = `再試行-${crypto.randomUUID().slice(0, 6)}`;
  await connect(request, name, "notes:read");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/connections", (route) => route.fulfill({ status: 503, json: { detail: "Unavailable" } }));
  await openConnections(page);
  await expect(page.getByRole("alert")).toContainText("接続一覧を読み込めませんでした");
  await expect(page.getByText("接続済みのAIはありません", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/connections");
  await page.getByRole("button", { name: "接続一覧を再読み込み" }).click();
  const card = page.getByRole("article", { name: `${name} (Hermes Agent (テスト))`, exact: true });
  await card.getByRole("button", { name: "情報・権限を編集" }).click();
  await expect(card.getByRole("checkbox", { name: /書き込み/ })).toBeDisabled();
  await card.getByRole("checkbox", { name: /閲覧/ }).uncheck();
  await expect(card.getByRole("button", { name: "変更を保存" })).toBeDisabled();
  await card.getByRole("checkbox", { name: /閲覧/ }).check();
  await card.getByLabel("表示名", { exact: true }).fill("保存待ちの名前");
  await page.route("**/api/connections/*", (route) => route.fulfill({ status: 503, json: { detail: "Unavailable" } }));
  await card.getByRole("button", { name: "変更を保存" }).click();
  await expect(card.getByRole("alert")).toContainText("入力内容は保持されています");
  await expect(card.getByLabel("表示名", { exact: true })).toHaveValue("保存待ちの名前");
  await page.unroute("**/api/connections/*");
  await card.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByRole("article", { name: "保存待ちの名前 (Hermes Agent (テスト))", exact: true })).toBeVisible();
});

for (const [locale, theme, width] of [["ja", "light", 390], ["en", "dark", 390], ["en", "dark", 1440]] as const) {
  test(`長い名前・詳細・編集を表示できる (${locale}, ${theme}, ${width}px)`, async ({ page, request }) => {
    const name = `${locale === "ja" ? "長い表示名の読み取り専用アシスタント" : "Read-only research assistant with a long display name"}-${crypto.randomUUID().slice(0, 6)}`;
    await connect(request, name, "notes:read notes:search");
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem("aonote:locale:v1", locale);
      localStorage.setItem("aonote:theme:v1", theme);
    }, { locale, theme });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    const english = locale === "en";
    await openConnections(page, english);
    const card = page.getByRole("article", { name: `${name} (Hermes Agent (テスト))`, exact: true });
    await expect(card).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await screenshot(page, `${width}-${locale}-${theme}`);
    await card.getByRole("button", { name: english ? "Edit details and permissions" : "情報・権限を編集" }).click();
    await expect(card.getByRole("checkbox", { name: english ? /Write/ : /書き込み/ })).toBeDisabled();
    await card.getByText(english ? "Connection details" : "接続の詳細", { exact: true }).click();
    expect(await page.locator(".settings-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await card.locator(".connection-editor").scrollIntoViewIfNeeded();
    await screenshot(page, `edit-${width}-${locale}-${theme}`);
  });
}

test("未接続の案内と日本語・英語の切り替え", async ({ page }) => {
  await page.route("**/api/connections", (route) => route.fulfill({ json: [] }));
  await openConnections(page);
  await expect(page.getByText("接続済みのAIはありません", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "表示設定", exact: true }).click();
  await page.getByRole("radio", { name: /English/ }).click();
  await page.getByRole("button", { name: "Manage AI connections", exact: true }).click();
  await expect(page.getByText("No connected AI apps", { exact: true })).toBeVisible();
});
