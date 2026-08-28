# <img src="assets/aonote-title.svg" alt="aonote" height="42">

[日本語](README.md) | English

aonote is a lightweight web workspace where you and AI can work with the same Markdown notes. It runs on Python, React, and SQLite, with full-text search powered by SQLite FTS5.

![aonote Markdown workspace](top_image.png)

## Features

- A folder and file tree on the left, with Markdown editing and preview on the right
- Markdown editing, split preview, autosave, and update-conflict detection
- Full-text search across titles, filenames, and content using SQLite FTS5 with the trigram tokenizer
- Recent notes, Wiki links, backlinks, and update history
- An MCP Streamable HTTP-compatible JSON-RPC endpoint
- OAuth 2.1 authorization code flow with PKCE (S256), DCR, and Protected Resource Metadata
- MCP tools for listing, retrieving by ID or path, searching, creating folders and notes, updating, and deleting
- Note author, last editor, creation time, and modification time
- Note renaming and moving, plus folder creation with a configurable maximum depth
- Read-only previews of deleted notes, restoration, and permanent deletion after a specified number of days

## Local Development

Use Python 3.12 or later and either Node.js 20.19 or later, or Node.js 22.12 or later.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
npm install
npm run build
uvicorn aonote.main:app --reload --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`. Browser authentication is bypassed by default in development. To test the authentication screen as well, start the app as follows.

Folders can be nested up to three levels by default. Change the limit with `AONOTE_MAX_FOLDER_DEPTH`.

```bash
AONOTE_DEV_BYPASS_AUTH=false AONOTE_ADMIN_PASSWORD='local-password' uvicorn aonote.main:app
```

## Docker

```bash
cp .env.example .env
# Set the public URL and a sufficiently long admin password in .env
docker compose up --build -d
```

In production, expose the app over HTTPS through Caddy, nginx, or a similar reverse proxy. `AONOTE_BASE_URL` must exactly match the externally visible HTTPS origin.

## Connecting from ChatGPT

The MCP URL is `https://your-host/mcp`. In ChatGPT developer mode, create a plugin and use this URL as its connection endpoint. The aonote OAuth consent screen opens during connection, where access can be approved with the admin password.

On the consent screen, enter a display name and individually select read, search, and write permissions within the scopes requested by the client. Disable write permission when connecting a read-only AI. Notes updated through MCP record the editor in a format such as `Display Name (via ChatGPT)`.

aonote exposes the following discovery endpoints:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/oauth/register` (Dynamic Client Registration)
- `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke`

ChatGPT connections require publicly accessible HTTPS. For local development, use MCP Inspector or an HTTPS tunnel. See OpenAI's current requirements in [Authentication](https://developers.openai.com/plugins/build/auth) and [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## MCP Tools

| Tool | Required scope | Purpose |
|---|---|---|
| `list_notes` | `notes:read` | List recent notes |
| `get_note` | `notes:read` | Retrieve Markdown content and version by ID or workspace-relative path |
| `list_folders` | `notes:read` | List folder IDs and hierarchy for choosing a destination |
| `create_folder` | `notes:write` | Create a folder at the root or inside a specified folder |
| `search_notes` | `notes:search` | Run a full-text search with SQLite FTS5 |
| `create_note` | `notes:write` | Create a note using a filename and folder ID, or a path that automatically creates missing folders |
| `update_note` | `notes:write` | Safely update a note with version checking |
| `rename_note` | `notes:write` | Rename a note file |
| `move_note` | `notes:write` | Move a note to another folder |
| `delete_note` | `notes:write` | Move a note to the browser trash after explicit confirmation |

Pass either `note_id` or `path` to `get_note`, but not both. `path` is a case-sensitive, workspace-relative path that uses `/` as its separator. The copy button next to the breadcrumb in the browser provides a path that can be used directly.

```json
{"path": "ようこそ/01-ようこそ.md"}
```

For an unfiled note, specify only the filename, such as `{"path": "memo.md"}`. Paths change when notes are renamed or moved, while `note_id` remains unchanged.

For `create_folder`, provide `name` and an optional `parent_id`. Omit `parent_id` or set it to `null` to create the folder at the workspace root.

```json
{"name": "Projects", "parent_id": null}
```

In addition to the existing `filename` and `folder_id` parameters, `create_note` accepts `path`. Missing folders in the path are automatically created within the `AONOTE_MAX_FOLDER_DEPTH` limit, while existing folders are reused.

```json
{"path": "Projects/test/note.md", "content": "# note"}
```

Notes deleted with the MCP `delete_note` tool also go to the trash. Restoration and permanent deletion are available only in the browser.

## Security Notes

- Do not commit `.env`.
- Do not commit databases containing real notes, including `data/` and `*.sqlite3` files.
- Always use `AONOTE_DEV_BYPASS_AUTH=false` in production.
- Access tokens expire after one hour, and refresh tokens expire after 30 days.
- The built-in OAuth server is intended for small-scale personal use. For public services or multi-user deployments, replace it with an established identity provider such as Auth0.
- Configure rate limiting, access logging, and TLS renewal at the reverse proxy.

## License

aonote is released under the [MIT License](LICENSE). Commercial use, modification, redistribution, and private use are permitted as long as the copyright notice and license text are retained.

The primary runtime dependencies are provided under the following licenses:

| Library | Purpose | License |
|---|---|---|
| FastAPI | Web API | MIT |
| Uvicorn | ASGI server | BSD-3-Clause |
| python-multipart | OAuth form handling | Apache-2.0 |
| React / React DOM | Frontend UI | MIT |
| Lucide React | UI icons | ISC |
| Mermaid | Diagrams in Markdown | MIT |
| react-markdown / remark-gfm | Markdown and GFM rendering | MIT |
| IBM Plex Mono | Web font for the editor | SIL Open Font License 1.1 |
| Noto Sans JP / Noto Serif JP | Japanese web fonts | SIL Open Font License 1.1 |

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for copyright notices, development and test libraries, and major transitive dependencies. Each dependency remains subject to its own license terms.

## Testing

```bash
pytest
npm run build
```
