# 本番反映の手順（わけたま / waketama.com）

Cloudflare Workers への本番デプロイと、独自ドメイン `waketama.com`（Xserverで取得）の接続手順。

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

## 1. まずworkers.devで動作確認（ドメイン接続前）

```bash
npm run typecheck && npm test        # 壊れていないことを確認
npm run deploy                       # ← npx wrangler deploy ではなくこちらを使う
```

`npm run deploy` を使うのは、gitのコミットハッシュを版数として埋め込むためです。
実機で「直したはずのバグが直っていない」ときに、端末が掴んでいる版をヘッダ
（`x-waketama-version`）と `/api/health` から確認できます。PWAはService Workerや
ブラウザキャッシュが絡むので、これが無いと切り分けができません。

表示される `https://sodatsukake.<あなたのサブドメイン>.workers.dev` を開き、
`/t/test-001` にアクセスして「召喚→会話」まで通ることを確認します。

> Worker名（`sodatsukake`）とworkers.devのURLは、既存のNFCタグを壊さないため
> 改名せずそのままにしてあります。表示上のサービス名だけが「わけたま」です。

---

## 2. waketama.com をCloudflareに載せる

Workersの独自ドメインは、**そのドメインがCloudflareのゾーンになっている必要があります**。
つまりネームサーバーをXserverからCloudflareへ向け替えます。

### 2-1. Cloudflareにサイトを追加

1. Cloudflareダッシュボード → 「ドメインを追加」
2. `waketama.com` を入力
3. プランは **Free** を選択
4. DNSレコードのスキャン結果が出ます。新規ドメインなので通常は空でOK（そのまま次へ）
5. **割り当てられたネームサーバー2つ**（`xxx.ns.cloudflare.com` の形式）が表示されるので控える

### 2-2. Xserver側でネームサーバーを変更

1. Xserverアカウント → 「ドメイン」→ `waketama.com` → **ネームサーバー設定**
2. 「その他のサービスで利用する」を選び、2-1で控えたCloudflareのネームサーバー2つを入力
3. 保存

> 現在は `NS1.XSERVER.JP` 〜 `NS5.XSERVER.JP` が設定されています。
> これを変更すると、このドメインのDNSはCloudflare側で管理されるようになります。
> **注意**: 将来このドメインでメールを使う場合、MXレコードはCloudflare側に登録し直す必要があります。

### 2-3. 有効化を待つ

Cloudflareのダッシュボードで、ゾーンの状態が **Active** になれば完了です。
通常は数分〜数時間（最大48時間）。以下でも確認できます。

```bash
dig NS waketama.com +short     # cloudflare.com のNSが返ればOK
```

---

## 3. Workerに独自ドメインを接続

ゾーンがActiveになってから行います。

`wrangler.toml` の先頭にある `routes` のコメントを外します。

```toml
routes = [
  { pattern = "waketama.com", custom_domain = true },
  { pattern = "www.waketama.com", custom_domain = true }
]
```

そしてデプロイします。

```bash
npm run deploy
```

`custom_domain = true` にしてあるので、DNSレコードとTLS証明書はCloudflareが自動で用意します
（証明書の発行に数分かかることがあります）。

---

## 4. 反映後の確認

```bash
curl -sI https://waketama.com/            # 302 で /home に飛ぶ
curl -s https://waketama.com/home | grep 'og:image'   # https://waketama.com/... の絶対URLになっている
curl -s https://waketama.com/api/health | head -30    # D1・Vectorizeの疎通と版数
```

`/api/health` は既定ではWorkers AIを呼びません（監視から叩かれても課金させないため）。
AIまで含めて確認したいときだけ `?deep=1` を付けてください（1回だけAIを呼びます）。

ブラウザでも以下を確認してください。

- `https://waketama.com/` → 分身一覧に着地する
- `https://waketama.com/t/test-002` → 召喚演出が出て、新しい分身が生まれる
- スマホで開き、「ホーム画面に追加」ができる
- URLをLINEやSlackに貼ると、OGPカード（紫の画像＋「わけたま」）が出る

---

## 5. これ以降のNFCタグに書き込むURL

```
https://waketama.com/t/<タグごとに固有のID>
```

タグIDは任意の文字列で構いません（推測されにくい方が安全です）。
初回タップ時にそのIDへ新しい分身が発行され、2回目以降は同じ分身に戻ります。

すでに `*.workers.dev` のURLで書き込み済みのタグがある場合も、Worker名を変えていないため
引き続き動作します。ただし表示されるURLは古いままなので、新規タグからは独自ドメインを使ってください。

---

## ステージング環境（本番を汚さずに検証する）

本番のD1に混ざると、テストで作った分身が「お散歩」の相手候補として実ユーザーに出てしまいます。
検証はステージングへ。初回だけ、専用のD1とVectorizeを作ります。

```bash
npx wrangler d1 create waketama-staging-db
# → 出力された database_id を wrangler.toml の REPLACE_WITH_STAGING_D1_ID に貼る
npx wrangler d1 migrations apply waketama-staging-db --remote --env staging
npx wrangler vectorize create waketama-staging-memory --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index waketama-staging-memory --property-name=characterId --type=string

npm run deploy:staging
```

ステージングには自動お散歩（cron）を意図的に設定していません。検証環境が勝手にAIコストを
使わないようにするためで、動作確認は手動の「お散歩に出す」から行ってください。

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
