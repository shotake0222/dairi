# 本番反映の手順（わけたま / app.waketama.com）

Cloudflare Workers への本番デプロイ手順。

| | URL |
| --- | --- |
| 本番 | `https://app.waketama.com` |
| 検証（ステージング） | `https://staging.waketama.com` |

`waketama.com`（apex）はアプリでは使っていません。将来LPを置く余地として空けてあります。

前提として、**デプロイ操作はあなたのMacのターミナルから実行する必要があります**。
Cloudflareの認証情報はあなたのMacのユーザー領域（`~/Library/Preferences/.wrangler` など）にあり、
AI側の作業環境からは触れないためです。以下のコマンドはすべて `~/src/nfc-companion` で実行してください。

---

## 0. 初回だけ必要な準備

### 0-1. Cloudflareにログイン

```bash
cd ~/src/nfc-companion
npx wrangler login
```

ブラウザが開くので許可します。完了後、`npx wrangler whoami` でアカウントが表示されればOKです。

### 0-2. 本番D1にマイグレーションを適用

ローカル用とは別に、本番のD1にもテーブルを作る必要があります。

```bash
npx wrangler d1 migrations list nfc-companion-db --remote   # 未適用のものを確認
npm run db:migrate:remote                                    # 適用
```

`nfc_tags` / `character_directory` / `transfer_codes`（引き継ぎコード用）が作られます。
未適用のままデプロイすると、NFCタップ時に「D1_ERROR: no such table: nfc_tags」で500エラーになります。

**マイグレーションを追加したときは毎回これを実行してください。**
適用済みかどうかは、デプロイ後に `https://<ドメイン>/api/health` を開けば一目で分かります
（`checks.d1.ok` が false ならテーブルが足りていません）。

### 0-3. Vectorizeインデックスを作成（長期記憶用）

```bash
npx wrangler vectorize list
```

`nfc-companion-memory` が無ければ、以下を1回だけ実行します。

```bash
npx wrangler vectorize create nfc-companion-memory --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index nfc-companion-memory --property-name=characterId --type=string
```

未作成でも会話自体は動きます（記憶の保存・検索が静かにスキップされるだけ）が、
「昔話したことを思い出す」体験が失われます。

---

## 1. workers.dev でも確認できる（任意）

```bash
npm run typecheck && npm test        # 壊れていないことを確認
npm run deploy                       # ← npx wrangler deploy ではなくこちらを使う
```

`npm run deploy` を使うのは、gitのコミットハッシュを版数として埋め込むためです。
実機で「直したはずのバグが直っていない」ときに、端末が掴んでいる版をヘッダ
（`x-waketama-version`）と `/api/health` から確認できます。PWAはService Workerや
ブラウザキャッシュが絡むので、これが無いと切り分けができません。

> **workers.dev のURLについて**: `routes`（独自ドメイン）を設定すると、wranglerは
> workers.dev への配信を既定で無効にします。独自ドメインが動いていれば不要ですが、
> DNSや証明書と切り分けるための予備URLが欲しい場合は `wrangler.toml` に
> `workers_dev = true` を足すと復活します。URLはデプロイ出力の最後、または
> ダッシュボードの Workers & Pages → 対象Worker → Settings → Domains & Routes で確認できます。

> Worker名（`sodatsukake`）とworkers.devのURLは、既存のNFCタグを壊さないため
> 改名せずそのままにしてあります。表示上のサービス名だけが「わけたま」です。

---

## 2. ドメインの状態（2026-09-12 完了済み）

- `waketama.com` はCloudflareのゾーンとして **Active**
- ネームサーバーはXserverからCloudflareへ移行済み
  （`margo.ns.cloudflare.com` / `serenity.ns.cloudflare.com`）
- Universal SSLにより、apexと第一階層のサブドメイン（`app.` / `staging.`）は証明書が自動発行される

確認コマンド:

```bash
dig NS waketama.com +short          # cloudflare.com のNSが返る
dig app.waketama.com +short         # デプロイ後、Cloudflareのアドレスが返る
```

---

## 3. Workerに独自ドメインを接続

`wrangler.toml` の `routes` は設定済みです。

```toml
routes = [
  { pattern = "app.waketama.com", custom_domain = true }
]
```

デプロイするだけで、**DNSレコードとTLS証明書はCloudflareが自動で作ります**。

```bash
npm run deploy
```

> ⚠️ `app.waketama.com` のDNSレコードを**手動で作らないでください**。
> 既にレコードがあると「custom domain already has a DNS record」で衝突し、
> デプロイが止まります。もし作ってしまった場合は、CloudflareのDNS画面から
> そのレコードを削除してから再度デプロイしてください。

証明書の発行に数分かかることがあります。その間は502やSSLエラーが出ることがありますが、
待てば解消します。

---

## 4. 反映後の確認

```bash
curl -sI https://app.waketama.com/                        # 302 で /home に飛ぶ
curl -s https://app.waketama.com/home | grep 'og:image'   # https://app.waketama.com/... の絶対URLになっている
curl -s https://app.waketama.com/api/health | head -30    # D1・Vectorizeの疎通と版数
curl -sI https://app.waketama.com/home | grep -i version  # x-waketama-version でデプロイ版数を確認
```

`/api/health` は既定ではWorkers AIを呼びません（監視から叩かれても課金させないため）。
AIまで含めて確認したいときだけ `?deep=1` を付けてください（1回だけAIを呼びます）。

ブラウザでも以下を確認してください。

- `https://app.waketama.com/` → あなたの分身のホームに着地する
- `https://app.waketama.com/t/test-002` → 召喚演出が出て、新しい分身が生まれる
- `https://app.waketama.com/call?cid=<上で発行されたcid>` → その場限りの通話が始まる
- スマホで開き、「ホーム画面に追加」ができる
- スマホでマイクボタンを押し、音声入力が動く（実機でしか確認できない項目）
- URLをLINEやSlackに貼ると、OGPカード（紫の画像＋「わけたま」）が出る

---

## 5. これ以降のNFCタグに書き込むURL

```
https://app.waketama.com/t/<タグごとに固有のID>
```

タグIDは任意の文字列で構いません（推測されにくい方が安全です）。
初回タップ時にそのIDへ新しい分身が発行され、2回目以降は同じ分身に戻ります。

すでに `*.workers.dev` のURLで書き込み済みのタグがある場合も、Worker名を変えていないため
引き続き動作します。ただし表示されるURLは古いままなので、新規タグからは独自ドメインを使ってください。

### apex（waketama.com）をどうするか

いまは何も設定していないため、`https://waketama.com` を開いても何も表示されません。
選択肢は2つあります。

1. **LPを置く**（将来的におすすめ）: サービス紹介ページを別途用意して apex に置く
2. **アプリへ転送する**（すぐやるなら）: Cloudflareダッシュボードの
   Rules → Redirect Rules で `waketama.com/*` → `https://app.waketama.com/$1` に転送する。
   Workerを経由しないので速く、コストもかかりません

---

## ステージング環境（本番を汚さずに検証する）

本番のD1に混ざると、テストで作った分身が「お散歩」の相手候補として実ユーザーに出てしまいます。
検証はステージングへ。初回だけ、専用のD1とVectorizeが必要です。

```bash
npm run setup:staging    # D1作成 → wrangler.tomlへID書き込み → マイグレーション → Vectorize作成
npm run deploy:staging   # デプロイ（staging.waketama.com のDNSと証明書もここで作られる）
```

`npm run setup:staging` は何度実行しても安全です（既にあるものは飛ばします）。

> なぜスクリプトにしたか: 手順自体は `d1 create` の出力にある `database_id` を
> `wrangler.toml` に貼るだけなのですが、貼り忘れたままデプロイすると
> `binding DB of type d1 must have a valid database_id specified [code: 10021]`
> という原因の分かりにくいエラーで止まります。貼り付け作業ごと無くしました。

手作業でやる場合は以下と同じことをしています。

```bash
npx wrangler d1 create waketama-staging-db
# → 出力された database_id を wrangler.toml の REPLACE_WITH_STAGING_D1_ID に貼る
npx wrangler d1 migrations apply waketama-staging-db --remote --env staging
npx wrangler vectorize create waketama-staging-memory --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index waketama-staging-memory --property-name=characterId --type=string
```

### ステージングは後回しでもよい

実ユーザーがまだいない段階なら、本番で直接触っても実害はほとんどありません。本番には
`/api/health`・`wrangler tail` のログ・版数ヘッダが入っているので、デバッグ環境としては
これだけでも機能します。ステージングが本当に効いてくるのは、実ユーザーの分身が
「お散歩」で動き始めてから（テスト用の分身が他人のマッチング相手に混ざるのを防ぐため）です。

### ステージングのURL

```
https://staging.waketama.com
```

`wrangler.toml` の `[[env.staging.routes]]` は設定済みなので、`npm run deploy:staging`
するだけでDNSレコードと証明書が自動で用意されます（本番と同じく、手動でDNSレコードを
作らないでください）。

DNSや証明書と切り分けたいときは、こちらでも同じWorkerに到達できます。

```
https://waketama-staging.<あなたのサブドメイン>.workers.dev
```

正確なURLは `npm run deploy:staging` の出力の最後に表示されます。

### ステージングに合言葉をかける（推奨）

独自ドメインに載せると誰でも開ける状態になります。検証環境は本物のWorkers AIを呼ぶため、
放置すると知らない誰かの利用でAI課金が発生します。合言葉をかけておくのが安全です。

```bash
npx wrangler secret put STAGING_PASSCODE --env staging
# プロンプトで合言葉を入力
```

設定すると、初回だけ `https://staging.waketama.com/home?key=合言葉` の形で開きます。
以降はCookieに入るので、URLに付ける必要はありません（合言葉がURLに残り続けないよう、
Cookieへ移した時点でURLからは自動で消えます）。未設定なら素通しなので、
まず動かしてから後で締める、という順番でも構いません。

検索避け（`noindex`）は合言葉の有無に関わらず、ステージングでは常に有効です。
`/api/health` だけは合言葉なしで開くようにしてあります（デプロイ後の疎通確認のため）。

### 本番との違い

| | 本番 | ステージング |
| --- | --- | --- |
| Worker名 | `sodatsukake` | `waketama-staging` |
| D1 | `nfc-companion-db` | `waketama-staging-db` |
| Vectorize | `nfc-companion-memory` | `waketama-staging-memory` |
| 自動お散歩（cron） | 1日2回 | **なし**（勝手にAI課金しないため） |
| 検索避け | なし | 常に `noindex` |

分身のデータ（Durable Object）もWorkerごとに完全に別なので、ステージングで
何を作って壊しても本番には影響しません。

## 本番のログを見る

`wrangler.toml` で観測性を有効にしてあるので、Cloudflareダッシュボードから過去のリクエストと
ログを検索できます。実機を触りながらリアルタイムで追う場合はこちら。

```bash
npx wrangler tail --format pretty
npx wrangler tail --status error            # エラーだけ
npx wrangler tail --search "call.rejected"  # 特定のイベントだけ
```

ログはJSON1行で出しており、`requestId` で Worker→Durable Object→AI を串刺しで追えます。
**会話の本文はログに出していません**（識別子・所要時間・成否のみ）。

## 更新のたびに行うこと

```bash
npm run typecheck && npm test   # 壊れていないか確認
npm run deploy                  # 反映（版数の埋め込み込み）
```

マイグレーションを追加したときだけ、`npm run db:migrate:remote` も忘れずに実行してください。
