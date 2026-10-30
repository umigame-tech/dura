# dura

AI エージェントのループ（オーケストレーターとサブエージェント）が共有する「作業状態」を、セッションの外に置いておくためのサーバーです。
REST API を正本とし、Web UI と CLI はその上に載る公式クライアントです。

## 考え方

1 つの作業を **State** と呼び、その中身を 2 種類に分けて持ちます。

| 種類 | 用途 | 書き方 |
| --- | --- | --- |
| **セクション** | `goal` / `plan` / `design` / `tasks` など、名前を自由に決められる Markdown 文書です | 上書きします。version による楽観ロックを使い、更新のたびに全文スナップショットを revision として残します |
| **ジャーナル** | `report` / `decision` / `note` などの記録です | 追記だけを行います。seq はサーバーが採番するので、並列に書いても衝突しません |

サブエージェントはジャーナルに `report` を追記するだけにして、セクションの更新はオーケストレーターが担います。
こうすると追記同士は競合しないため、ロックや claim の仕組みが要りません。

State の status は `active` / `waiting` / `completed` / `abandoned` の 4 つです。
`waiting`（人間の判断待ち）か `completed` に変わると、Web Push と Webhook で通知します。

## API

```
GET     /api/states                                   一覧（?status=）
POST    /api/states                                   作成 {id?, title, status?, statusNote?, sections?}
GET     /api/states/:id                               State・全セクション・ジャーナル（?after=, ?limit=）
PATCH   /api/states/:id                               {title?, status?, statusNote?}
GET     /api/states/:id/sections/:name                セクション（ETag に version が入ります）
PUT     /api/states/:id/sections/:name                全文の書き込み（If-Match: version）
POST    /api/states/:id/sections/:name/replace        old/new による部分置換（If-Match 必須）
GET     /api/states/:id/sections/:name/revisions      全 revision
GET     /api/states/:id/journal                       ジャーナル（?after=<seq>）
POST    /api/states/:id/journal                       追記 {kind, body}、または Markdown 本文 + ?kind=
GET     /api/guide                                    エージェント向けの使い方（Markdown）
POST    /mcp                                          MCP（Streamable HTTP、下の「MCP」を参照）
```

- `Accept: text/markdown` を付けると、`GET /api/states/:id` は全セクションと指定位置以降のジャーナルを 1 つの Markdown にまとめて返します。エージェントは 1 回の呼び出しで作業に必要な文脈を読み込めます。
- セクションの書き込みは `If-Match` に「読んだときの version」を付けて送ります。古い version で書き込もうとすると `409 version_conflict` を返し、エラーメッセージに次に何をすればよいかを書いて返します。
- `replace` は Claude Code や Codex の編集ツールと同じ old/new 方式です。`old` が 1 回だけ現れることを要求し、すべて置換したいときは `replaceAll: true` を付けます。
- セクションや本文は `Content-Type: text/markdown` の生の本文でも、JSON でも送れます。

エージェントには公開エンドポイント `GET /api/guide` を読ませれば、CLI と REST API の使い方が伝わります。たとえば `~/.claude/CLAUDE.md` や `~/.codex/AGENTS.md` に次のように書いておく運用を想定しています。

```
作業状態は dura で管理する。最初に $DURA_URL/api/guide を読み、Reading の手順でジャーナルの全ページを確認してから作業を選ぶ。
```

## CLI

`cli/` に依存パッケージのない CLI があり、npm で [`@umigame-tech/dura`](https://www.npmjs.com/package/@umigame-tech/dura) として配布しています（Node 20 以上）。コマンド名は `dura` です。

```bash
npm install -g @umigame-tech/dura
```

リポジトリから使うときはビルドします。

```bash
npm run cli:build
```

Node なしで動く単一バイナリが必要なときは、[Bun](https://bun.sh) で実行環境ごとコンパイルできます。今のプラットフォーム向けの `cli/dist/dura` ができるので、PATH の通ったディレクトリに置いて使います。

```bash
npm run cli:compile
```

別のプラットフォーム向けには `bun build cli/src/main.ts --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-darwin-arm64 --outfile dura` のように `--target` を指定します。`--no-compile-autoload-*` は、実行したディレクトリの `.env` や `bunfig.toml` をバイナリが読み込まないようにするためのものです（作業中のリポジトリのファイルでトークンや接続先が変わったり、コードが実行されたりするのを防ぎます）。

`cli:build` のビルド後は、任意のディレクトリから `node /absolute/path/to/dura/cli/dist/dura.js guide` のように絶対パスで実行できます。ビルドしたものを `dura` として PATH から実行するには、dura リポジトリで `npm link ./cli` を実行します。

```bash
export DURA_URL=https://dura.example.com DURA_STATE=search-rewrite
```

`dura guide` は公開ガイドを読むだけなので、`DURA_URL` だけで動き、トークンを送りません。ほかのコマンドには `DURA_TOKEN` も必要です。CLI を用意する前でも、`curl -fsS "$DURA_URL/api/guide"` で公開ガイドを読めます。

トークンはシェルの履歴に残さないため、フラグの値では渡せません。`DURA_TOKEN` に入れるか、`--token-file <path>` でファイルから、`--token-stdin` で標準入力から読みます（`--token-stdin` のときは、`log` や `section put` の本文を `--file` で渡します）。サーバーは `--url <url>` で指定でき、`DURA_URL` より優先します。State は `--state <id>` で指定でき、省略すると `DURA_STATE` を使います。

```
dura show                                   全セクションとジャーナル（Markdown、--json で JSON）
dura list                                   読める State の一覧
dura section get tasks                      本文を stdout に、version を stderr に出します
dura section put plan --version 3 < plan.md 全文の書き込み（新規作成のときは --version を省きます）
dura section replace tasks --version 7 --old "- [ ] CI" --new "- [x] CI"
dura log --kind report "CI を追加した"       ジャーナルに追記（本文は引数、stdin、--file のどれか）
dura journal --after 41                     指定した seq より後のジャーナル
dura status waiting --note "名前はどちらにしますか？"
dura guide                                  /api/guide を表示
```

書き込みが拒否されたときは、サーバーのエラーに加えて、CLI で次に何をすればよいか（`dura section get tasks` で読み直して `--version 8` で再送する、など）を表示します。

### CLI の公開

`cli/package.json` の `version` を上げてマージした後、main のコミットに `cli-v<version>` のタグを付けて push すると、GitHub Actions（`.github/workflows/publish-cli.yml`）が typecheck・test・ビルドを行い、npm にステージング公開（`npm stage publish`）します。main に含まれないコミットのタグでは公開しません。CLI の `dura -V` も `cli/package.json` の `version` を表示します。

```bash
git switch main && git pull
```

```bash
git tag cli-v0.1.1 && git push origin cli-v0.1.1
```

ステージングされたバージョンは、メンテナーが 2FA で承認するまで公開されません。npm 11.15 以上で、ステージングの ID を確かめてから承認します。

```bash
npm stage list @umigame-tech/dura
```

```bash
npm stage approve <stage-id>
```

npm への認証には Trusted Publishing を使います。npm のパッケージ設定で、Trusted Publisher として GitHub Actions の `umigame-tech/dura` と `publish-cli.yml` を登録しておきます。トークンは不要です。provenance は、リポジトリが public のときだけ npm が自動で付けます（private リポジトリからは付けられません）。Allowed actions の `npm publish` は許可しないでください（ステージングだけで足ります）。

## MCP

サーバーは `POST /mcp` で MCP（Streamable HTTP）にも対応しています。インストールは不要で、エージェント用の Bearer トークンをヘッダーに付けて接続します。
中身は REST API を呼ぶだけの薄い層なので、権限・楽観ロック・通知は API と同じように働きます。

```bash
claude mcp add --transport http dura https://dura.example.com/mcp --header "Authorization: Bearer $DURA_TOKEN"
```

| ツール | CLI で言うと |
| --- | --- |
| `list_states` | `dura list` |
| `show_state` | `dura show` |
| `read_journal` | `dura journal` |
| `get_section` | `dura section get`（先頭に `<!-- version: N -->` が付きます） |
| `put_section` | `dura section put` |
| `replace_in_section` | `dura section replace` |
| `append_journal` | `dura log` |
| `set_status` | `dura status` |

- State の ID はツールごとに `state` 引数で渡します。State の作成は人間の確認が前提なので、MCP からはできません。
- ステートレスで、応答は JSON だけです（SSE やセッション ID は使いません）。OAuth には対応していないため、ヘッダーを設定できるクライアントで使います。
- `initialize` の `instructions` に、読み書きの手順を短くまとめて返します。

## 認証

- **人間（Web UI）**: パスキー（WebAuthn）でログインします。インスタンスの所有者は 1 人で、パスキーは複数登録できます。
- **エージェント**: Web UI の Settings で名前付きの Bearer トークンを発行します。読み取り専用 / 読み書き と、対象 State の制限を付けられ、いつでも失効できます。トークン名はセクションの `updatedBy` やジャーナルの `actor` に記録されます。

最初のパスキーを登録するときだけ、サーバーに設定した `DURA_SETUP_TOKEN` の入力が必要です。

## 通知

Settings で次の 2 つを設定できます。

- **Web Push**: Web UI は PWA になっています。「Enable push on this device」を押すと、その端末に通知が届きます（iPhone の場合は先にホーム画面へ追加してください）。VAPID 鍵は初回に自動生成して DB に保存します。
- **Webhook**: ntfy、Slack、Discord、汎用 JSON の各形式に対応しています。

## 動かし方

### Node + SQLite

```bash
npm install
```

```bash
DURA_SETUP_TOKEN=好きな文字列 npm run dev
```

http://localhost:8787 を開き、セットアップ画面でパスキーを登録します。本番用には次のようにビルドして起動します。

```bash
npm run build && DURA_SETUP_TOKEN=... node dist/node.js
```

Docker の場合は次のとおりです。

```bash
docker build -t dura .
```

```bash
docker run -p 8787:8787 -v dura-data:/data -e DURA_SETUP_TOKEN=... -e DURA_ORIGIN=https://dura.example.com dura
```

### Cloudflare Workers + D1

`wrangler.toml` には D1 の `database_id` を書かず、`database_name = "dura"` で名前から探す設定にしています。ID をリポジトリに載せる必要はありません。

まず D1 データベースを作ります（表示される ID を控える必要はありません）。

```bash
npx wrangler d1 create dura
```

`npm run worker:deploy` は、マイグレーションを適用してからデプロイします。

```bash
npm run worker:deploy
```

#### Workers Builds（GitHub 連携）でデプロイする場合

Cloudflare のダッシュボードでこのリポジトリを Worker に接続し、ビルド設定のデプロイコマンドを次のようにすると、push のたびにマイグレーションの適用とデプロイが行われます。

```bash
npm run worker:deploy
```

本番以外のブランチ（PR など）のビルドは無効にしてください。Workers Builds は本番以外のブランチで `wrangler preview` を実行しますが、プレビューは本番の D1 バインディングを引き継がないため、この設定のままでは失敗します。

#### 最初のパスキー登録

登録する直前に、セットアップ用のトークンを設定します（再デプロイは不要です）。

```bash
npx wrangler secret put DURA_SETUP_TOKEN
```

`https://dura.<アカウント名>.workers.dev/setup` を開いてパスキーを登録したら、トークンは削除して構いません。2 本目以降のパスキーは、ログインした状態で Settings から追加できます。

```bash
npx wrangler secret delete DURA_SETUP_TOKEN
```

### 環境変数

| 名前 | 説明 |
| --- | --- |
| `DURA_SETUP_TOKEN` | 最初のパスキー登録に使う秘密の文字列です。未設定のときは初期セットアップができません |
| `DURA_ORIGIN` | ブラウザから見える URL です（例: `https://dura.example.com`）。リバースプロキシの裏で動かすときに設定します。パスキーと通知のリンクに使います |
| `DURA_NAME` | パスキーの登録画面に表示する名前です（既定値: `dura`） |
| `DURA_VAPID_SUBJECT` | Web Push の連絡先（`mailto:` か `https:`）です。既定値はオリジンです |
| `DURA_DB_PATH` | Node 版の SQLite ファイルの場所です（既定値: `./data/dura.db`） |
| `PORT` / `HOST` | Node 版の待ち受けポートとアドレスです（既定値: `8787` / `0.0.0.0`） |

## 開発

```bash
npm test
```

```bash
npm run typecheck
```

スキーマ（`src/db/schema.ts`）を変更したら、`npm run db:generate` でマイグレーションを生成します。

### 構成

```
src/
  app.ts            Hono アプリの組み立て（Node と Workers で共通）
  node.ts           Node + better-sqlite3 のエントリポイント
  worker.ts         Cloudflare Workers + D1 のエントリポイント
  store.ts          State / セクション / ジャーナルの操作
  auth.ts           Bearer トークンとセッション
  notify.ts         通知の配信（Web Push / Webhook）
  guide.ts          /api/guide の本文
  db/schema.ts      Drizzle のスキーマ
  lib/webpush.ts    WebCrypto による Web Push（RFC 8291 / RFC 8292）
  routes/api.ts     REST API
  routes/webauthn.ts パスキーの登録とログイン
  ui/               Hono JSX によるサーバーレンダリングの Web UI
cli/src/            dura CLI（cli.ts が本体、main.ts が Node のエントリポイント）
drizzle/            SQL マイグレーション（Node と D1 で共用）
```

## ライセンス

[MIT](LICENSE)
