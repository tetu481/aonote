# Third-party notices

aonoteは、以下を含む第三者のオープンソースソフトウェアとWebフォントを利用しています。各コンポーネントには、aonote本体とは別に、それぞれの著作権表示とライセンス条件が適用されます。

この一覧は、`package-lock.json`、`pyproject.toml`、インストール済みパッケージに同梱されたライセンス情報を基に、2026年8月8日時点で確認したものです。

## 実行時の直接依存関係

| コンポーネント | 確認バージョン | ライセンス | 提供元 |
|---|---:|---|---|
| FastAPI | 0.128.8 | MIT | <https://github.com/fastapi/fastapi> |
| Uvicorn | 0.39.0 | BSD-3-Clause | <https://github.com/encode/uvicorn> |
| python-multipart | 0.0.20 | Apache-2.0 | <https://github.com/Kludex/python-multipart> |
| React | 18.3.1 | MIT | <https://github.com/facebook/react> |
| React DOM | 18.3.1 | MIT | <https://github.com/facebook/react> |
| Lucide React | 0.468.0 | ISC | <https://github.com/lucide-icons/lucide> |
| Mermaid | 11.16.1 | MIT | <https://github.com/mermaid-js/mermaid> |
| react-markdown | 9.1.0 | MIT | <https://github.com/remarkjs/react-markdown> |
| remark-gfm | 4.0.1 | MIT | <https://github.com/remarkjs/remark-gfm> |

## Webフォント

| フォント | ライセンス | 提供元 |
|---|---|---|
| IBM Plex Mono | SIL Open Font License 1.1 | <https://github.com/IBM/plex> |
| Noto Sans JP | SIL Open Font License 1.1 | <https://fonts.google.com/noto/specimen/Noto+Sans+JP> |
| Noto Serif JP | SIL Open Font License 1.1 | <https://fonts.google.com/noto/specimen/Noto+Serif+JP> |

## 開発・テスト用の直接依存関係

| コンポーネント | 確認バージョン | ライセンス | 提供元 |
|---|---:|---|---|
| Vite | 4.5.14 | MIT | <https://github.com/vitejs/vite> |
| TypeScript | 5.9.3 | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| Playwright Test | 1.48.2 | Apache-2.0 | <https://github.com/microsoft/playwright> |
| pytest | 8.4.2 | MIT | <https://github.com/pytest-dev/pytest> |
| HTTPX | 0.28.1 | BSD-3-Clause | <https://github.com/encode/httpx> |

## 主な推移的依存関係

フロントエンドの実行時依存関係は、MIT、ISC、BSD-3-Clause、Apache-2.0、Unlicenseを中心とする許容的ライセンスで構成されています。Mermaidが利用するDOMPurifyは`(MPL-2.0 OR Apache-2.0)`のデュアルライセンスであり、本プロジェクトではApache-2.0の選択肢に基づいて扱います。

代表的な推移的依存関係には、D3（主にISC）、DOMPurify（Apache-2.0またはMPL-2.0）、KaTeX（MIT）、Cytoscape.js（MIT）、Chevrotain Types（Apache-2.0）があります。完全なパッケージ名と固定バージョンは`package-lock.json`を参照してください。Python側の推移的依存関係は、各パッケージの`.dist-info/licenses`または同梱ライセンスファイルを参照してください。

## 再配布時の注意

- npm・PyPIパッケージに同梱された`LICENSE`、`NOTICE`、著作権表示を削除しないでください。
- ビルド済みJavaScriptやDockerイメージを第三者へ配布する場合も、対応するライセンスとNOTICEを一緒に提供してください。
- 依存関係を更新した場合は、このファイルのバージョンとライセンス情報も更新してください。

この文書は依存関係の表示を整理するためのものであり、法的助言ではありません。
