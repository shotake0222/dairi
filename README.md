# わけたま（Waketama）

NFCタグ付きグッズをきっかけに、テキスト会話で「育つ」キャラクターと出会うサービスのMVP実装です。
**NFCタグは原則として一人につき1つ**（＝1人に1体の分身）を想定しています。
（開発用のリポジトリ名・フォルダ名・Cloudflare Worker名は、既存のNFCタグ配布や動作中のデプロイに影響しないよう
引き続き `sodatsukake` / `nfc-companion` のままにしていますが、サービス名（ブランド表示）は「わけたま」です。
2026/9/12に「そだつかけ」から改名しました。由来は神道の「分け御霊（わけみたま）」＝自分の魂を分けて
新しい依り代に宿しても元の自分は欠けない、という考え方で、それを短くした「分け魂（わけたま）」です。
`waketama.com` が取得可能であることを確認した上でこの表記に決めています）
Cloudflare Workers / Durable Objects / D1 / Workers AI（SLM）のみで構成されており、外部サーバーは不要です。

## 全体の仕組み

1. NFCタグには `https://<あなたのドメイン>/t/<タグID>` というURLを書き込んでおく
2. タップすると `/t/:tagId` にアクセスがあり、初回なら新しいキャラクター（Durable Object 1体）を発行して `summon.html` にリダイレクト
3. `summon.html` はカメラでキーホルダーを映しつつ、その撮像画像の表示中にキャラクター登場テキストを重畳表示する「召喚演出」を行う
   （※既存特許ファミリーの共通必須要件＝「撮像画像の表示中にサーバー主導の処理結果を出力する」を踏まえた設計）
4. 「会話をはじめる」から `chat.html` に遷移し、以降は通常のテキストチャットでキャラクターと会話する
5. 会話のたびに `src/ai/personality.ts` のロジックで性格パラメータが少しずつ変化し、「育て方によって性格が変わる」を実現する
6. 性格・会話履歴はSLM（Workers AI）の記憶力に頼らず、Durable Object（`CharacterState`）が構造化データとして保持し、毎ターンのプロンプトに反映する

## セットアップ手順

### 0. 前提

- Node.js 18以上
- Cloudflareアカウント（無料枠でOK）

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Cloudflareにログイン

```bash
npx wrangler login
```

ブラウザが開くのでCloudflareアカウントでログインを許可してください。

### 3. D1データベースを作成

```bash
npx wrangler d1 create nfc-companion-db
```

実行結果に表示される `database_id` を、`wrangler.toml` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` 部分に貼り付けてください。

### 4. マイグレーションを適用

```bash
npm run db:migrate:local   # ローカル開発用
npm run db:migrate:remote  # 本番（Cloudflare上のD1）用
```

### 5. ローカルで動作確認

```bash
npm run dev
```

表示されたURL（例: http://localhost:8787）にアクセスし、`/t/test-tag-001` のようなパスを開くと、
初回タグ発行→召喚ページ→チャットページの流れを確認できます（ローカルではNFCタグは使わず、直接このURLを叩けばOK）。

### 6. 本番デプロイ

```bash
npm run deploy
```

デプロイ後に発行される `*.workers.dev` のURL（または独自ドメインを設定した場合はそのURL）をNFCタグに書き込みます。
NFCタグへのURL書き込みには、iPhoneなら「NFC TagWriter」、Androidなら「NFC Tools」等の無料アプリが使えます。

## ディレクトリ構成

```
src/
  index.ts                    # ルーティング（/t/:tagId, /api/*, 静的配信、OGPのURL絶対化）
  call.ts                     # その場限りの通話（何も保存しない会話経路・SSEストリーミング）
  voice.ts                    # 音声の文字起こし（Whisper）と読み上げ（MeloTTS）
  transfer.ts                 # 引き継ぎコード（端末をまたいだ所有権の移動）
  health.ts                   # 自己診断（D1・Vectorizeの疎通と版数）
  lib/
    log.ts                    # 構造化ログ（本文は出さない。requestIdで串刺しに追える）
    rateLimit.ts              # AIコストの上限（保存に依存しない回数制限）
  durable-objects/
    characterState.ts         # キャラクター1体分の状態管理（性格・記憶・成長段階）
  ai/
    personality.ts            # 性格パラメータの定義と更新ロジック（育成の核）
    signalExtractor.ts        # ユーザーのメッセージから「育て方の傾向」を抽出する簡易ヒューリスティック
    promptBuilder.ts          # 性格パラメータ→SLMへのシステムプロンプト生成
    memory.ts                 # 長期記憶（Vectorize）の保存・検索・書き出し・削除
  db/schema.sql               # D1スキーマ（参考。実際の適用はmigrations/を使用）
migrations/                   # D1マイグレーション（nfc_tags / character_directory / transfer_codes）
public/
  summon.html                 # NFCタップ直後のAR召喚演出ページ
  chat.html                   # テキストチャットページ
  call.html                   # その場限りの通話ページ（記録が残らないモード）
  home.html                   # あなたの分身（NFCタグが手元にないときの入口）
  friends.html                # 出会いの図鑑
  history.html                # 成長グラフ
  offline.html                # オフライン時の案内（PWA）
tools/
  e2e.mjs                     # ブラウザ実機での通しテスト
  make_brand_assets.py        # PWAアイコン・OGP画像の生成
```

## 主なAPI

| エンドポイント | 用途 |
| --- | --- |
| `POST /api/chat` | 通常の会話（性格が育ち、記憶に残る） |
| `POST /api/call/stream` | その場限りの通話。**何も保存しない**。応答はSSEで流れる |
| `POST /api/voice/transcribe` | 音声の文字起こし（ブラウザ標準の音声認識が使えないとき用） |
| `POST /api/voice/speak` | 読み上げ音声の生成（既定はブラウザ標準を使うので任意） |
| `POST /api/character/transfer/issue` / `claim` | 引き継ぎコードの発行・使用 |
| `GET /api/health` | D1・Vectorizeの疎通と版数（既定ではAIを呼ばない） |

## テスト

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest（workerd上でDurable Object・D1を実際に動かす統合テスト）
```

`npm test` は @cloudflare/vitest-plugin を使い、wrangler.toml のバインディング設定そのままで
Durable Object と D1 を実際に動かします。Workers AI と Vectorize はローカルシミュレータが無く、
実際に呼ぶとCloudflareアカウントに課金が発生するため、`remoteBindings: false` の上で
`vi.spyOn(env.AI, "run")` により必ずモックしています（この方針は崩さないでください）。

ブラウザでしか分からない部分（スマホ幅のレイアウト崩れ、削除後の導線、OGPの絶対URL化など）は
別途E2Eスクリプトでカバーしています。

```bash
npm run dev         # 別プロセスで開発サーバーを起動しておく
npm run test:e2e    # Playwrightで実際に画面を操作して検証（要 npm i -D playwright）
```

ブランド画像（PWAアイコン・OGP画像）は `npm run brand:assets` で再生成できます（要 Pillow）。

## 実装上の注意点（ハマりどころ）

- **静的ファイルは既定でWorkerに届かない**: Cloudflare Workers Assets は、ファイルが存在するパスを
  Workerより先に返します。そのため `wrangler.toml` の `run_worker_first` にHTMLページのパスを列挙し、
  OGPのURL絶対化（`src/index.ts` の `serveAsset`）が動くようにしています。ここを消すと
  SNSシェア時のカード画像が静かに壊れます（vitestの `SELF.fetch` は常にWorkerを通るため気づけません）。
- **正規URLは拡張子なし**: `/chat.html` は `/chat` へ307リダイレクトされます。アプリ内リンクは
  最初から拡張子なしを指すようにしてあります（画面遷移ごとの余計な往復を避けるため）。
- **localStorageのキー名 `sodatsukake_*` は変更しないこと**: 持ち主トークンと、この端末で開いた分身の記録の保存先です。
  サービス名を改名した際もあえて据え置きました。変えると既存ユーザーが自分の分身の所有権を失います。
- **その場限りモードに保存処理を足さないこと**: `src/call.ts` は「何も書かない」ことが機能の価値です。
  通常の `chat()` と入口を分けてあるのは、条件分岐で保存を足し忘れる事故を防ぐためです。
  `src/__tests__/call.test.ts` が、会話前後でDurable Objectのストレージが1バイトも変わらないことを
  検証しています。ここが落ちたら、機能の売り自体が壊れていると考えてください。
- **レート制限はストレージに書かない**: `src/lib/rateLimit.ts` はDurable Objectのインスタンスメモリで
  数えます。保存に依存する方式に戻すと、その場限りモードで制限が効かなくなります。

## 今後の拡張ポイント（優先度順の目安）

1. **性格更新ロジックの調整**: `src/ai/personality.ts` の係数はまだ仮の値です。実際のユーザーの会話ログを見ながらチューニングしてください
2. **会話の質の検証**: SLM（`@cf/meta/llama-3.2-3b-instruct`）で体験の粗さが目立つ場合は、`characterState.ts` の `CHAT_MODEL` を Workers AI 内のより大きいモデルに差し替えるか、有料プラン向けに外部LLM APIへ切り替えるハイブリッド構成を検討してください
3. **signalExtractorの高度化**: 現状はキーワードマッチの簡易版です。SLM自体に一言で分類させる、または軽量な分類器を挟むと精度が上がります
4. **ユーザーアカウント**: 現状は持ち主トークン（localStorage）＋引き継ぎコードによる簡易的な所有権です。`users` / `user_characters` テーブルは土台のみ用意してあるので、本格的な認証（Cloudflare Access / 独自実装）が必要になった段階で実装してください
5. **iOS向けのホーム画面追加の案内**: iOS Safariは `beforeinstallprompt` に非対応のため、現在インストール案内はAndroid/Chrome系にしか出ません。共有メニューからの手順を案内するUIが必要です
6. **Web3/NFT/メタバース連携、フィジカルAIへの人格移植**: 開発メモ（フィジビリティ検討メモ）のフェーズ2・3、および人格エクスポート仕様書を参照してください

※ 長期記憶のRAG化（Vectorize）は実装済みです（`src/ai/memory.ts`）。

## 特許との関係についての実装メモ

`summon.html` の召喚演出は、既存特許ファミリー（第7416500号・第7503872号・特願2024-090738）に共通する
「通信端末が物体を撮像し、その撮像画像の表示中に、サーバー側で決定された処理結果を出力する」という構成要件を
なぞる設計にしてあります。実装を変更する際は、①カメラでの撮像、②その画像を表示したままの状態、③その最中に
処理結果（登場演出）を重畳表示、という3点を崩さないようにしてください。崩れると権利範囲との整合性が変わる
可能性があります（正式な判断は弁理士法人インターブレインにご確認ください）。
