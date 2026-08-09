from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence
from uuid import uuid4

from .security import now_ts, token_hash


WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]")
TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_UNCHANGED = object()


SEED_NOTES = {
    "ようこそ.md": """# aonoteへようこそ

aonoteは、あなたとAIが同じ知識を育てるためのMarkdownワークスペースです。

## できること

- 左のツリーからノートを整理
- 編集内容を自動保存
- SQLite FTS5で全文検索
- OAuthで保護されたMCPからAIと連携

次は [[MCP連携]] を開いて、AIからノートを利用する方法を確認してください。
""",
    "MCP連携.md": """# MCP連携のセットアップ

## 概要

MCP（Model Context Protocol）を使うと、aonoteのノートライブラリをAIから安全に利用できます。

このガイドでは、セットアップからChatGPTとの接続までを説明します。

## OAuth

aonoteはOAuth 2.1による認可コードフローとPKCE（S256）を採用しています。

- アクセストークンは短寿命です
- スコープは最小権限の原則に基づきます
- MCPへの各リクエストでトークンを検証します

## ChatGPTに接続

ChatGPTのプラグイン設定で、公開HTTPSエンドポイントを指定します。

```text
https://notes.example.com/mcp
```

接続後は、ノートの検索・閲覧・作成・更新を会話から実行できます。
""",
    "SQLite全文検索.md": """# SQLite全文検索

aonoteの検索はEmbeddingモデルを使わず、SQLite FTS5を利用します。

## 方針

- タイトル、ファイル名、本文を一つの索引に保存
- 日本語の部分一致にはtrigramトークナイザーを利用
- 3文字未満の語はLIKE検索へフォールバック

個人用のノートでは、構成が単純で説明可能な検索がよく合います。
""",
}


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(self.path), timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS folders (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY,
                    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
                    filename TEXT NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    created_actor_name TEXT NOT NULL DEFAULT '管理者',
                    created_client_name TEXT,
                    updated_actor_name TEXT NOT NULL DEFAULT '管理者',
                    updated_client_name TEXT,
                    UNIQUE(folder_id, filename)
                );

                CREATE TABLE IF NOT EXISTS note_revisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    actor_name TEXT NOT NULL DEFAULT '管理者',
                    client_name TEXT
                );

                CREATE TABLE IF NOT EXISTS note_links (
                    source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                    target_label TEXT NOT NULL,
                    target_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
                    alias TEXT,
                    PRIMARY KEY(source_id, target_label, alias)
                );

                CREATE TABLE IF NOT EXISTS web_sessions (
                    token_hash TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS oauth_clients (
                    client_id TEXT PRIMARY KEY,
                    client_name TEXT NOT NULL,
                    redirect_uris TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS oauth_codes (
                    code_hash TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    code_challenge TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    actor_name TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS oauth_tokens (
                    token_hash TEXT PRIMARY KEY,
                    token_kind TEXT NOT NULL,
                    client_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    actor_name TEXT NOT NULL DEFAULT ''
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
                    note_id UNINDEXED,
                    title,
                    filename,
                    content,
                    tokenize='trigram'
                );

                CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
                CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_links_target ON note_links(target_id);
                """
            )
            self._migrate_schema(connection)
            count = connection.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            if count == 0:
                self._seed(connection)

    @staticmethod
    def _migrate_schema(connection: sqlite3.Connection) -> None:
        additions = {
            "notes": (
                "created_actor_name TEXT NOT NULL DEFAULT '管理者'",
                "created_client_name TEXT",
                "updated_actor_name TEXT NOT NULL DEFAULT '管理者'",
                "updated_client_name TEXT",
            ),
            "note_revisions": (
                "actor_name TEXT NOT NULL DEFAULT '管理者'",
                "client_name TEXT",
            ),
            "oauth_codes": ("actor_name TEXT NOT NULL DEFAULT ''",),
            "oauth_tokens": ("actor_name TEXT NOT NULL DEFAULT ''",),
        }
        for table, definitions in additions.items():
            columns = {
                row["name"] for row in connection.execute(f"PRAGMA table_info({table})")
            }
            for definition in definitions:
                name = definition.split()[0]
                if name not in columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")

    def _seed(self, connection: sqlite3.Connection) -> None:
        stamp = now_ts()
        folders: Dict[str, str] = {}
        for position, name in enumerate(["Inbox", "Projects", "Learning", "Archive"]):
            folder_id = str(uuid4())
            folders[name] = folder_id
            connection.execute(
                "INSERT INTO folders VALUES (?, ?, NULL, ?, ?, ?)",
                (folder_id, name, position, stamp, stamp),
            )
        for index, (filename, content) in enumerate(SEED_NOTES.items()):
            note_id = str(uuid4())
            folder = folders["Inbox"] if index == 0 else folders["Projects"]
            title = self.extract_title(content, filename)
            connection.execute(
                """INSERT INTO notes
                   (id, folder_id, filename, title, content, version, created_at, updated_at,
                    created_actor_name, created_client_name, updated_actor_name, updated_client_name)
                   VALUES (?, ?, ?, ?, ?, 1, ?, ?, '管理者', NULL, '管理者', NULL)""",
                (note_id, folder, filename, title, content, stamp, stamp + index),
            )
            self._reindex(connection, note_id)
        self._resolve_all_links(connection)

    @staticmethod
    def extract_title(content: str, filename: str) -> str:
        match = TITLE_RE.search(content)
        return match.group(1).strip() if match else filename.removesuffix(".md")

    @staticmethod
    def actor_display(actor_name: str, client_name: Optional[str]) -> str:
        actor = actor_name.strip() if actor_name else ""
        client = client_name.strip() if client_name else ""
        return actor or client or "管理者"

    @staticmethod
    def actor_via(actor_name: str, client_name: Optional[str]) -> Optional[str]:
        actor = actor_name.strip() if actor_name else ""
        client = client_name.strip() if client_name else ""
        return client if actor and client and actor != client else None

    @classmethod
    def _note_dict(cls, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "folder_id": row["folder_id"],
            "filename": row["filename"],
            "title": row["title"],
            "content": row["content"],
            "version": row["version"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "created_by": cls.actor_display(
                row["created_actor_name"], row["created_client_name"]
            ),
            "created_via": cls.actor_via(
                row["created_actor_name"], row["created_client_name"]
            ),
            "updated_by": cls.actor_display(
                row["updated_actor_name"], row["updated_client_name"]
            ),
            "updated_via": cls.actor_via(
                row["updated_actor_name"], row["updated_client_name"]
            ),
        }

    def list_tree(self) -> List[Dict[str, Any]]:
        with self.connect() as connection:
            folders = [dict(row) for row in connection.execute(
                "SELECT * FROM folders ORDER BY position, name COLLATE NOCASE"
            )]
            notes = [self._note_dict(row) for row in connection.execute(
                "SELECT * FROM notes ORDER BY filename COLLATE NOCASE"
            )]
        by_parent: Dict[Optional[str], List[Dict[str, Any]]] = {}
        for folder in folders:
            folder["folders"] = []
            folder["notes"] = [n for n in notes if n["folder_id"] == folder["id"]]
            by_parent.setdefault(folder["parent_id"], []).append(folder)
        for folder in folders:
            folder["folders"] = by_parent.get(folder["id"], [])
        roots = by_parent.get(None, [])
        unfiled = [n for n in notes if n["folder_id"] is None]
        if unfiled:
            roots.insert(0, {
                "id": "unfiled", "name": "未整理", "parent_id": None,
                "folders": [], "notes": unfiled,
            })
        return roots

    def get_note(self, note_id: str) -> Optional[Dict[str, Any]]:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if not row:
                return None
            note = self._note_dict(row)
            folder_path = self._folder_path(connection, row["folder_id"])
            note["folder_name"] = folder_path[-1]["name"] if folder_path else None
            note["folder_path"] = folder_path
            note["backlinks"] = [
                {"id": item["id"], "title": item["title"], "filename": item["filename"]}
                for item in connection.execute(
                    """SELECT n.id, n.title, n.filename FROM note_links l
                       JOIN notes n ON n.id = l.source_id
                       WHERE l.target_id = ? ORDER BY n.title""",
                    (note_id,),
                )
            ]
            return note

    def list_recent(self, limit: int = 12) -> List[Dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [self._note_dict(row) for row in rows]

    def list_folders(self) -> List[Dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id, name, parent_id FROM folders ORDER BY position, name COLLATE NOCASE"
            ).fetchall()
            return [
                {
                    "id": row["id"],
                    "name": row["name"],
                    "parent_id": row["parent_id"],
                    "depth": len(self._folder_path(connection, row["id"])),
                }
                for row in rows
            ]

    @staticmethod
    def _folder_path(
        connection: sqlite3.Connection, folder_id: Optional[str]
    ) -> List[Dict[str, str]]:
        path: List[Dict[str, str]] = []
        current = folder_id
        seen = set()
        while current:
            if current in seen:
                raise ValueError("Folder hierarchy contains a cycle")
            seen.add(current)
            row = connection.execute(
                "SELECT id, name, parent_id FROM folders WHERE id = ?", (current,)
            ).fetchone()
            if not row:
                raise ValueError("Folder not found")
            path.append({"id": row["id"], "name": row["name"]})
            current = row["parent_id"]
        path.reverse()
        return path

    def create_folder(
        self, name: str, parent_id: Optional[str] = None, max_depth: int = 3
    ) -> Dict[str, Any]:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("Folder name is required")
        if "/" in clean_name or "\\" in clean_name:
            raise ValueError("Folder name cannot contain path separators")
        if parent_id == "unfiled":
            parent_id = None
        folder_id = str(uuid4())
        stamp = now_ts()
        with self.connect() as connection:
            depth = len(self._folder_path(connection, parent_id)) + 1
            if depth > max_depth:
                raise FolderDepthError(max_depth)
            position = connection.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE parent_id IS ?",
                (parent_id,),
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO folders VALUES (?, ?, ?, ?, ?, ?)",
                (folder_id, clean_name, parent_id, position, stamp, stamp),
            )
        return {
            "id": folder_id,
            "name": clean_name,
            "parent_id": parent_id,
            "depth": depth,
        }

    def rename_folder(self, folder_id: str, name: str) -> Optional[Dict[str, Any]]:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("Folder name is required")
        if "/" in clean_name or "\\" in clean_name:
            raise ValueError("Folder name cannot contain path separators")
        if folder_id == "unfiled":
            return None
        with self.connect() as connection:
            folder = connection.execute(
                "SELECT id, parent_id FROM folders WHERE id = ?", (folder_id,)
            ).fetchone()
            if not folder:
                return None
            connection.execute(
                "UPDATE folders SET name = ?, updated_at = ? WHERE id = ?",
                (clean_name, now_ts(), folder_id),
            )
            depth = len(self._folder_path(connection, folder_id))
            return {
                "id": folder_id,
                "name": clean_name,
                "parent_id": folder["parent_id"],
                "depth": depth,
            }

    def delete_folder(self, folder_id: str) -> bool:
        if folder_id == "unfiled":
            return False
        with self.connect() as connection:
            rows = connection.execute(
                """WITH RECURSIVE subtree(id) AS (
                       SELECT id FROM folders WHERE id = ?
                       UNION ALL
                       SELECT folders.id FROM folders
                       JOIN subtree ON folders.parent_id = subtree.id
                   )
                   SELECT id FROM subtree""",
                (folder_id,),
            ).fetchall()
            folder_ids = [row["id"] for row in rows]
            if not folder_ids:
                return False
            placeholders = ", ".join("?" for _ in folder_ids)
            # フォルダを消してもノート本文は残し、未整理へ戻す。
            connection.execute(
                f"UPDATE notes SET folder_id = NULL WHERE folder_id IN ({placeholders})",
                folder_ids,
            )
            connection.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
            return True

    def create_note(
        self,
        filename: str,
        content: str = "",
        folder_id: Optional[str] = None,
        actor_name: str = "管理者",
        client_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        clean_name = filename.strip()
        if not clean_name.lower().endswith(".md"):
            clean_name += ".md"
        note_id = str(uuid4())
        stamp = now_ts()
        title = self.extract_title(content, clean_name)
        with self.connect() as connection:
            if folder_id == "unfiled":
                folder_id = None
            if folder_id:
                self._folder_path(connection, folder_id)
            connection.execute(
                """INSERT INTO notes
                   (id, folder_id, filename, title, content, version, created_at, updated_at,
                    created_actor_name, created_client_name, updated_actor_name, updated_client_name)
                   VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)""",
                (
                    note_id, folder_id, clean_name, title, content, stamp, stamp,
                    actor_name, client_name, actor_name, client_name,
                ),
            )
            self._reindex(connection, note_id)
            self._resolve_all_links(connection)
        return self.get_note(note_id)  # type: ignore[return-value]

    def update_note(
        self,
        note_id: str,
        content: Optional[str] = None,
        filename: Optional[str] = None,
        folder_id: Any = _UNCHANGED,
        expected_version: Optional[int] = None,
        actor_name: str = "管理者",
        client_name: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        with self.connect() as connection:
            current = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if not current:
                return None
            if expected_version is not None and current["version"] != expected_version:
                raise VersionConflict(current["version"])
            next_content = current["content"] if content is None else content
            next_filename = current["filename"] if filename is None else filename.strip()
            if not next_filename.lower().endswith(".md"):
                next_filename += ".md"
            next_folder = current["folder_id"] if folder_id is _UNCHANGED else folder_id
            if next_folder == "unfiled":
                next_folder = None
            if next_folder:
                self._folder_path(connection, next_folder)
            next_title = self.extract_title(next_content, next_filename)
            if (
                next_content == current["content"]
                and next_filename == current["filename"]
                and next_folder == current["folder_id"]
            ):
                return self.get_note(note_id)
            next_version = current["version"] + 1
            stamp = now_ts()
            connection.execute(
                """INSERT INTO note_revisions
                   (note_id, title, content, version, created_at, actor_name, client_name)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    note_id, current["title"], current["content"], current["version"],
                    stamp, actor_name, client_name,
                ),
            )
            connection.execute(
                """UPDATE notes SET folder_id = ?, filename = ?, title = ?, content = ?,
                   version = ?, updated_at = ?, updated_actor_name = ?, updated_client_name = ?
                   WHERE id = ?""",
                (
                    next_folder, next_filename, next_title, next_content, next_version,
                    stamp, actor_name, client_name, note_id,
                ),
            )
            self._reindex(connection, note_id)
            self._resolve_all_links(connection)
        return self.get_note(note_id)

    def relocate_note(
        self,
        note_id: str,
        filename: str,
        folder_id: Optional[str],
        expected_version: Optional[int],
        actor_name: str = "管理者",
        client_name: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        return self.update_note(
            note_id,
            filename=filename,
            folder_id=folder_id,
            expected_version=expected_version,
            actor_name=actor_name,
            client_name=client_name,
        )

    def delete_note(self, note_id: str) -> bool:
        with self.connect() as connection:
            deleted = connection.execute("DELETE FROM notes WHERE id = ?", (note_id,)).rowcount
            connection.execute("DELETE FROM note_fts WHERE note_id = ?", (note_id,))
            self._resolve_all_links(connection)
            return deleted > 0

    def search(self, query: str, limit: int = 20) -> List[Dict[str, Any]]:
        clean = query.strip()
        if not clean:
            return []
        with self.connect() as connection:
            if len(clean) < 3:
                term = f"%{clean}%"
                rows = connection.execute(
                    """SELECT id, title, filename, content, updated_at FROM notes
                       WHERE title LIKE ? OR filename LIKE ? OR content LIKE ?
                       ORDER BY updated_at DESC LIMIT ?""",
                    (term, term, term, limit),
                ).fetchall()
                return [
                    {
                        "id": row["id"],
                        "title": row["title"],
                        "filename": row["filename"],
                        "snippet": self._plain_snippet(row["content"], clean),
                        "rank": 0,
                        "updated_at": row["updated_at"],
                    }
                    for row in rows
                ]
            escaped = clean.replace('"', '""')
            rows = connection.execute(
                """SELECT n.id, n.title, n.filename, n.updated_at,
                          snippet(note_fts, 3, '<mark>', '</mark>', '…', 22) AS snippet,
                          bm25(note_fts, 2.0, 1.2, 1.0) AS rank
                   FROM note_fts JOIN notes n ON n.id = note_fts.note_id
                   WHERE note_fts MATCH ? ORDER BY rank LIMIT ?""",
                (f'"{escaped}"', limit),
            ).fetchall()
            return [dict(row) for row in rows]

    @staticmethod
    def _plain_snippet(content: str, query: str) -> str:
        compact = re.sub(r"\s+", " ", content)
        position = compact.lower().find(query.lower())
        start = max(0, position - 45) if position >= 0 else 0
        end = min(len(compact), start + 130)
        return ("…" if start else "") + compact[start:end] + ("…" if end < len(compact) else "")

    def _reindex(self, connection: sqlite3.Connection, note_id: str) -> None:
        row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            return
        connection.execute("DELETE FROM note_fts WHERE note_id = ?", (note_id,))
        connection.execute(
            "INSERT INTO note_fts(note_id, title, filename, content) VALUES (?, ?, ?, ?)",
            (note_id, row["title"], row["filename"], row["content"]),
        )
        connection.execute("DELETE FROM note_links WHERE source_id = ?", (note_id,))
        for match in WIKILINK_RE.finditer(row["content"]):
            label = match.group(1).strip()
            alias = match.group(2).strip() if match.group(2) else ""
            connection.execute(
                "INSERT OR IGNORE INTO note_links(source_id, target_label, target_id, alias) VALUES (?, ?, NULL, ?)",
                (note_id, label, alias),
            )

    @staticmethod
    def _resolve_all_links(connection: sqlite3.Connection) -> None:
        connection.execute("UPDATE note_links SET target_id = NULL")
        notes = connection.execute("SELECT id, title, filename FROM notes").fetchall()
        lookup: Dict[str, str] = {}
        for note in notes:
            lookup[note["title"].casefold()] = note["id"]
            lookup[note["filename"].removesuffix(".md").casefold()] = note["id"]
        links = connection.execute("SELECT rowid, target_label FROM note_links").fetchall()
        for link in links:
            target = lookup.get(link["target_label"].split("/")[-1].casefold())
            if target:
                connection.execute(
                    "UPDATE note_links SET target_id = ? WHERE rowid = ?", (target, link["rowid"])
                )

    def create_session(self, ttl: int) -> str:
        from .security import random_token

        token = random_token()
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO web_sessions VALUES (?, ?)",
                (token_hash(token), now_ts() + ttl),
            )
        return token

    def valid_session(self, token: Optional[str]) -> bool:
        if not token:
            return False
        with self.connect() as connection:
            row = connection.execute(
                "SELECT expires_at FROM web_sessions WHERE token_hash = ?", (token_hash(token),)
            ).fetchone()
            return bool(row and row[0] > now_ts())


class VersionConflict(Exception):
    def __init__(self, current_version: int):
        super().__init__("Note has changed since it was loaded")
        self.current_version = current_version


class FolderDepthError(Exception):
    def __init__(self, max_depth: int):
        super().__init__(f"Folder depth cannot exceed {max_depth}")
        self.max_depth = max_depth
