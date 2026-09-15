# <img src="assets/aonote-title.svg" alt="aonote" height="42">

日本語 | [English](README.en.md)

aonoteは、個人とAIが同じMarkdownノートを扱うための軽量なWebワークスペースです。Python、React、SQLiteで動作し、検索はSQLite FTS5で行います。

![aonoteのMarkdownワークスペース](top_image.png)

## 主な機能

- 左側にフォルダ／ファイルツリー、右側にMarkdownの編集／プレビューを持つ画面構成
- Markdownの編集、分割プレビュー、自動保存、更新競合の検出
- SQLite FTS5（trigram）によるタイトル・ファイル名・本文の全文検索
- 最近のノート、Wikiリンク、バックリンク
- MCP Streamable HTTP互換のJSON-RPCエンドポイント
- OAuth 2.1の認可コード＋PKCE（S256）、DCR、Protected Resource Metadata
- MCPツール：一覧、ID／パス指定取得、検索、フォルダ／ノート作成、更新、削除
- ノートの作成者・修正者と作成日時・変更日時の表示
- ノートの名前変更・移動、最大階層を設定できるフォルダ作成
- 削除済みノートの読み取り専用プレビュー、復元、指定日数経過後の完全削除
- 設定画面から日本語／英語の表示切り替え（ブラウザに保存）

## ローカル開発

Python 3.12以上とNode.js 20.19以上、または22.12以上を利用してください。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
npm install
npm run build
uvicorn aonote.main:app --reload --host 127.0.0.1 --port 8000
```

`http://127.0.0.1:8000` を開きます。開発環境では既定でブラウザ認証を省略します。認証画面も確認する場合は次のように起動します。

フォルダは既定で3階層まで作成できます。`AONOTE_MAX_FOLDER_DEPTH`で上限を変更できます。

```bash
AONOTE_DEV_BYPASS_AUTH=false AONOTE_ADMIN_PASSWORD='local-password' uvicorn aonote.main:app
```

## Docker

```bash
cp .env.example .env
# .envの公開URLと十分に長い管理パスワードを変更
docker compose up --build -d
```

本番環境ではCaddyやnginxなどで公開HTTPS化してください。`AONOTE_BASE_URL` は外部から見えるHTTPSのオリジンと完全に一致させます。

## 安定稼働・監視

- ブラウザでのノート切替や本文を置き換える操作は、自動保存の完了を待ってから進みます。保存失敗時は操作を中止して本文を画面に保持し、保存を再試行できます。更新競合時は、未保存の本文をコピーしてからページを再読み込みし、サーバー側の変更と統合してください。未保存の本文はブラウザを閉じた後まで保持するものではありません。
- OAuthの認可コード／リフレッシュトークンの消費と新トークンの保存は、同じトランザクションで確定します。保存に失敗した場合はまとめて取り消し、同じ認可コード／トークンによる同時発行を防止します。
- ノートの更新は、書き込みロック取得後にバージョンを確認し、本文・検索索引を一括更新します。競合時は再取得して変更を適用し直してください。ブラウザとMCPのDB処理はワーカースレッドで実行し、DB待ちによるイベントループの停止を防ぎます。
- `/healthz` は生存確認用です。`/readyz` はDBの読み取り・書き込みロック取得、フロントエンドの配置、DB保存先の空き容量を確認し、不備があればHTTP 503を返します。DBの完全な整合性検査やバックアップの代わりではありません。
- DockerイメージとComposeのヘルスチェックは `/readyz` を利用します。`unhealthy` の判定だけではDockerは自動再起動しません。監視・通知先は運用環境で別途設定してください。
- 起動時の読み込みに失敗した場合は、空のワークスペースではなくエラーと再試行ボタンを表示します。通信状態・サーバー・DBの状態を確認し、復旧後に「読み込みを再試行」を押してください。

| 環境変数 | デフォルト | 用途 |
|---|---|---|
| `AONOTE_MIN_FREE_DISK_MB` | `100` | `/readyz` が異常と判定する空き容量の下限（MiB、正の整数） |
| `AONOTE_MONITOR_INTERVAL_SECONDS` | `60` | バックグラウンドの稼働監視間隔（秒、正の整数） |

起動時と稼働状態の変化時に `readiness_changed` をJSONログへ記録します。HTTPログにはルート名・ステータス・処理時間・リクエストID、MCPログにはツール名・処理時間・エラー種別を記録します。リクエストIDはレスポンスの `X-Request-ID` と対応します。aonoteのログにはノート本文、ファイル名、パス、検索語、パスワード、認証トークンを記録しません。

```bash
docker compose logs --tail=100 -f aonote
```

Dockerではクエリ文字列を含むUvicorn標準アクセスログを無効にしています。直接起動する場合も `uvicorn aonote.main:app --no-access-log` を推奨します。リバースプロキシ側のログでも機密情報を除外してください。DBのロック待ち・ディスク障害はHTTP APIでは503、MCPツールでは `isError: true` とエラー種別で通知します。応答を受け取れなかった書き込みを再試行する際は、先にノートを取得して保存済みか確認してください。

## ノート名・リンク・REST APIの扱い

- 「未整理」を含め、同じ保存先に同名ノートを作る更新・移動は拒否します。フォルダ削除で配下ノートを未整理へ移す際にも、未整理または配下の別フォルダに同名があれば、全体を変更せずHTTP 409を返します。先にノートを改名してください。既存データの名前を勝手に変更することはありません。
- `[[Projects/guide.md]]` や `[[Projects/guide]]` はワークスペース相対パスです。フォルダ付きのパスは大文字・小文字を区別し、指定先がなければ別フォルダの同名ノートには移動しません。パスのないWikiリンクは同じフォルダを優先し、それ以外は候補が1件の場合だけ解決します。曖昧なリンクはパスで指定してください。
- RESTの `PATCH /api/notes/{note_id}` は、取得時の `version`（正の整数）が必須です。省略・不正な値はHTTP 422、更新競合は409、不正なファイル名は400になります。ブラウザとMCPは従来どおりバージョンを送信します。
- OAuthトークンによる `GET /api/search` は、MCPの `search_notes` と同じく `notes:search` が必要です。`notes:read` だけでは検索できません。検索結果の `snippet` はハイライト以外をHTMLエスケープし、ブラウザは `snippet_parts` の文字列とハイライトを安全に描画します。

## ChatGPTから接続

MCP URLは `https://あなたのホスト/mcp` です。ChatGPTの開発者モードでプラグインを作成し、このURLを接続先に指定します。接続時にaonoteのOAuth同意画面が開き、管理パスワードで許可できます。
同意画面では表示名を入力し、クライアントが要求した範囲内で閲覧・検索・書き込み権限を個別に選択できます。読み取り専用のAIには書き込み権限を外して接続してください。MCPから更新したノートには `表示名(ChatGPT経由)` のように修正者が記録されます。

aonoteは次のディスカバリーURLを公開します。

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/oauth/register`（Dynamic Client Registration）
- `/oauth/authorize`、`/oauth/token`、`/oauth/revoke`

ChatGPT接続には公開HTTPSが必要です。ローカル開発ではMCP InspectorまたはHTTPSトンネルを利用してください。OpenAIの現行要件は[Authentication](https://developers.openai.com/plugins/build/auth)と[Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)を確認してください。

## MCPツール

| ツール | 必要スコープ | 用途 |
|---|---|---|
| `list_notes` | `notes:read` | 最近のノートを一覧 |
| `get_note` | `notes:read` | IDまたはワークスペース相対パスでMarkdown本文とバージョンを取得 |
| `list_folders` | `notes:read` | 移動先フォルダのIDと階層を一覧 |
| `create_folder` | `notes:write` | ルートまたは指定フォルダの配下へフォルダを作成 |
| `search_notes` | `notes:search` | SQLite FTS5で全文検索 |
| `create_note` | `notes:write` | ファイル名／フォルダID、または自動フォルダ作成を伴うパス指定でノートを作成 |
| `update_note` | `notes:write` | バージョン付きで安全に更新 |
| `rename_note` | `notes:write` | ノートのファイル名を変更 |
| `move_note` | `notes:write` | ノートを別のフォルダへ移動 |
| `delete_note` | `notes:write` | 明示確認後にブラウザのゴミ箱へ移動 |

`get_note`には`note_id`または`path`のどちらか一方を指定します。`path`は大文字・小文字を区別するワークスペース相対パスで、区切り文字には`/`を使います。ブラウザのパンくずリスト横にあるコピーボタンから、そのまま利用できるパスを取得できます。

```json
{"path": "ようこそ/01-ようこそ.md"}
```

未整理のノートは`{"path": "memo.md"}`のようにファイル名だけを指定します。パスは名前変更や移動によって変わりますが、`note_id`は変わりません。

`create_folder`では`name`と任意の`parent_id`を指定します。`parent_id`を省略または`null`にするとルートへ作成されます。

```json
{"name": "Projects", "parent_id": null}
```

`create_note`は従来の`filename`と`folder_id`に加えて、`path`も指定できます。パス内に存在しないフォルダは`AONOTE_MAX_FOLDER_DEPTH`の範囲内で自動作成され、既存フォルダは再利用されます。

```json
{"path": "Projects/test/note.md", "content": "# note"}
```

MCPの`delete_note`で削除したノートもゴミ箱に入ります。復元と完全削除はブラウザからのみ操作できます。

### MCPクライアントで引数検証エラーになる場合

`create_note`や`get_note`で`oneOf`の検証エラーが出て「The tool was NOT invoked」と表示される場合、クライアント側のスキーマ変換が影響している可能性があります。aonoteでは互換性のため、これらのツールの入力スキーマを`oneOf`を使わない形式にしています。排他的な引数指定の検証はサーバー側で行います。

aonoteを更新・再起動した後、クライアント側でもMCPツール一覧を再取得してください（再接続またはクライアントの再起動）。Dockerの場合は更新後のソースからイメージを再ビルドし、コンテナを再作成してください。

## セキュリティ上の注意

- `.env`をコミットしないでください。
- `data/`や`*.sqlite3`など、実際のノートを含むデータベースをコミットしないでください。
- 本番では`AONOTE_DEV_BYPASS_AUTH=false`を必ず使用してください。
- アクセストークンは1時間、リフレッシュトークンは30日で失効します。
- 自作OAuthサーバは小規模・個人用途向けです。公開サービスや複数ユーザー用途では、Auth0など確立したIdPへの置き換えを推奨します。
- リバースプロキシでレート制限、アクセスログ、TLS更新を設定してください。

## ライセンス

aonote本体は[MIT License](LICENSE)で公開されています。著作権表示とライセンス文を保持することで、商用利用、改変、再配布、私的利用が可能です。

主な実行時依存ライブラリは次のライセンスで提供されています。

| ライブラリ | 用途 | ライセンス |
|---|---|---|
| FastAPI | Web API | MIT |
| Uvicorn | ASGIサーバー | BSD-3-Clause |
| python-multipart | OAuthフォーム処理 | Apache-2.0 |
| React / React DOM | フロントエンドUI | MIT |
| Lucide React | UIアイコン | ISC |
| Mermaid | Markdown内の図表 | MIT |
| react-markdown / remark-gfm | Markdown・GFM表示 | MIT |
| IBM Plex Mono | エディター用Webフォント | SIL Open Font License 1.1 |
| Noto Sans JP / Noto Serif JP | 日本語Webフォント | SIL Open Font License 1.1 |

各ライブラリの著作権表示、開発・テスト用ライブラリ、主な推移的依存関係については[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を参照してください。依存ライブラリには、それぞれのライセンス条件が別途適用されます。

## テスト

```bash
pytest
npm run build
```
