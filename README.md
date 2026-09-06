# そだつかけ（Sodatsukake）

NFCタグ付きグッズをきっかけに、テキスト会話で「育つ」キャラクターと出会うサービスのMVP実装です。
（開発用のリポジトリ名・フォルダ名は `nfc-companion` のままにしていますが、サービス名は「そだつかけ」です）
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
  index.ts                    # ルーティング（/t/:tagId, /api/chat, /api/character, 静的配信）
  durable-objects/
    characterState.ts         # キャラクター1体分の状態管理（性格・記憶・成長段階）
  ai/
    personality.ts            # 性格パラメータの定義と更新ロジック（育成の核）
    signalExtractor.ts        # ユーザーのメッセージから「育て方の傾向」を抽出する簡易ヒューリスティック
    promptBuilder.ts          # 性格パラメータ→SLMへのシステムプロンプト生成
  db/schema.sql               # D1スキーマ（参考。実際の適用はmigrations/を使用）
migrations/0001_init.sql      # D1マイグレーション
public/
  summon.html                 # NFCタップ直後のAR召喚演出ページ
  chat.html                   # テキストチャットページ
```

## 今後の拡張ポイント（優先度順の目安）

1. **性格更新ロジックの調整**: `src/ai/personality.ts` の係数はまだ仮の値です。実際のユーザーの会話ログを見ながらチューニングしてください
2. **会話の質の検証**: SLM（`@cf/meta/llama-3.2-3b-instruct`）で体験の粗さが目立つ場合は、`characterState.ts` の `CHAT_MODEL` を Workers AI 内のより大きいモデルに差し替えるか、有料プラン向けに外部LLM APIへ切り替えるハイブリッド構成を検討してください
3. **記憶のRAG化**: 現状は直近20往復をそのまま保持しているだけです。会話量が増えたらVectorizeに埋め込みを保存し、関連する過去の記憶だけを検索して渡す方式に置き換えてください
4. **signalExtractorの高度化**: 現状はキーワードマッチの簡易版です。SLM自体に一言で分類させる、または軽量な分類器を挟むと精度が上がります
5. **ユーザーアカウント・複数キャラクター管理**: `users` / `user_characters` テーブルは土台のみ用意しています。認証（Cloudflare Access / 独自実装）と合わせて実装してください
6. **ユーザー間マッチング・ソーシャル機能、Web3/NFT/メタバース連携**: 開発メモ（フィジビリティ検討メモ）のフェーズ2・3を参照してください

## 特許との関係についての実装メモ

`summon.html` の召喚演出は、既存特許ファミリー（第7416500号・第7503872号・特願2024-090738）に共通する
「通信端末が物体を撮像し、その撮像画像の表示中に、サーバー側で決定された処理結果を出力する」という構成要件を
なぞる設計にしてあります。実装を変更する際は、①カメラでの撮像、②その画像を表示したままの状態、③その最中に
処理結果（登場演出）を重畳表示、という3点を崩さないようにしてください。崩れると権利範囲との整合性が変わる
可能性があります（正式な判断は弁理士法人インターブレインにご確認ください）。
