# dura

AI エージェントのループ（オーケストレーターとサブエージェント）が共有する「作業状態」を、セッションの外に置いておくためのサーバーです。
REST API を正本とし、Web UI はその上に載る公式クライアントです（CLI は今後追加予定です）。

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
```

- `Accept: text/markdown` を付けると、`GET /api/states/:id` は全セクションと指定位置以降のジャーナルを 1 つの Markdown にまとめて返します。エージェントは 1 回の呼び出しで作業に必要な文脈を読み込めます。
- セクションの書き込みは `If-Match` に「読んだときの version」を付けて送ります。古い version で書き込もうとすると `409 version_conflict` を返し、エラーメッセージに次に何をすればよいかを書いて返します。
- `replace` は Claude Code や Codex の編集ツールと同じ old/new 方式です。`old` が 1 回だけ現れることを要求し、すべて置換したいときは `replaceAll: true` を付けます。
- セクションや本文は `Content-Type: text/markdown` の生の本文でも、JSON でも送れます。

エージェントには `GET /api/guide` を読ませれば使い方が伝わります。たとえば `~/.claude/CLAUDE.md` や `~/.codex/AGENTS.md` に次のように書いておく運用を想定しています。

```
作業状態は dura で管理する。最初に $DURA_URL/api/guide を読むこと。
```

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

リポジトリの `wrangler.toml` の `database_id` はダミーの値です。自分の D1 の ID は、Git で管理しない `wrangler.local.toml` に書いて使います（`.gitignore` に登録済みです）。

まず D1 データベースを作ります。

```bash
npx wrangler d1 create dura
```

`wrangler.toml` をコピーして `wrangler.local.toml` を作り、`database_id` を表示された ID に書き換えます。

```bash
cp wrangler.toml wrangler.local.toml
```

以降のコマンドには `-c wrangler.local.toml` を付けて実行します。npm スクリプトでは `--` のあとに渡します。

```bash
npm run worker:migrate -- -c wrangler.local.toml
```

```bash
npm run worker:deploy -- -c wrangler.local.toml
```

最初のパスキーを登録する直前に、セットアップ用のトークンを設定します（再デプロイは不要です）。

```bash
npx wrangler secret put DURA_SETUP_TOKEN -c wrangler.local.toml
```

`https://dura.<アカウント名>.workers.dev/setup` を開いてパスキーを登録したら、トークンは削除して構いません。2 本目以降のパスキーは、ログインした状態で Settings から追加できます。

```bash
npx wrangler secret delete DURA_SETUP_TOKEN -c wrangler.local.toml
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
drizzle/            SQL マイグレーション（Node と D1 で共用）
```
