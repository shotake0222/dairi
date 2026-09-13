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
  talk.ts                     # かざして話す（カメラ映像を出したまま声で会話。保存され、育つ）
  vision.ts                   # 「これ見て」— 見せられた1枚を言葉に変える（保存しない）
  ime.ts                      # かな漢字変換（視線・スイッチ入力の補助）
  contact.ts                  # 法人向けページからの問い合わせの受付
  personaRoutes.ts            # 同意・属性・アクセシビリティ設定・人格カードの書き出し（持ち主のみ）
  market.ts                   # 人格マーケット（本人出品／匿名集約セグメント統計）
  admin.ts                    # 管理画面の入口と集計API（合言葉で保護。未設定なら開かない）
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
  persona/
    consent.ts                # 用途ごとの同意（既定オフ・版付き）。すべての取得と提供の入口
    profile.ts                # 属性の質問票（選択肢式・全て任意・段階的に聞く）
    accessibility.ts          # 入力方法などの設定。販売・集約からは構造的に外してある
    personaCard.ts            # エッジAI向けの人格カード（JSON / プロンプト / Modelfile）
    registry.ts               # 集計用レジストリ（D1）への写しと、日次カウンタ
  analysis/
    textMining.ts             # 会話からの語の抽出と話題カテゴリ化（AIを使わない層）
    psychographics.ts         # 価値観・関心の推定と、人格データへの緩やかなマージ
    segments.ts               # 性格＋価値観＋関心からのセグメント分類
  db/schema.sql               # D1スキーマ（参考。実際の適用はmigrations/を使用）
migrations/                   # D1マイグレーション（nfc_tags / character_directory / transfer_codes / persona_registry / contact_requests）
public/
  summon.html                 # NFCタップ直後のAR召喚演出ページ
  chat.html                   # テキストチャットページ
  call.html                   # その場限りの通話ページ（記録が残らないモード）
  talk.html                   # かざして話すページ（カメラ＋音声。撮像画像の表示中に応答する）
  privacy.html                # プライバシーポリシー
  profile.html                # 同意・属性・人物像・アクセシビリティ設定・人格カードの書き出し
  eyes.html                   # 視線／スイッチによる文字入力
  market.html                 # 人格マーケット（さがす・傾向・出品）
  admin.html                  # 管理画面
  lp.html                     # toC向けランディングページ（分け御霊というコンセプト）
  biz.html                    # 法人向けランディングページ（SLM・エッジ向けの人格データ）
  terms.html                  # 利用規約
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
| `POST /api/talk` | かざして話す。通常の会話と同じく保存され、演出スクリプトも一緒に返る |
| `POST /api/voice/transcribe` | 音声の文字起こし（ブラウザ標準の音声認識が使えないとき用） |
| `POST /api/voice/speak` | 読み上げ音声の生成（既定はブラウザ標準を使うので任意） |
| `POST /api/character/transfer/issue` / `claim` | 引き継ぎコードの発行・使用 |
| `GET /api/health` | D1・Vectorize・会話モデルの疎通と版数（既定ではAIを呼ばない） |
| `GET /api/profile/schema` | 属性の質問票と同意文面の定義（唯一の定義元。画面側は書き写さない） |
| `GET/POST /api/profile`, `POST /api/consent`, `POST /api/accessibility` | 持ち主のみ。同意・属性・入力設定 |
| `GET /api/persona/card` | 人格カードの書き出し（`format=json\|prompt\|modelfile\|readme`） |
| `POST /api/ime` | ひらがな→漢字かな交じりの変換（視線・スイッチ入力の補助） |
| `POST /api/notes` | 覚え書きの書き換え（持ち主のみ）。分身が覚えている内容を本人が直す |
| `POST /api/contact` | 法人向けページからの問い合わせ |
| `GET/POST /api/market/*` | マーケット（一覧・出品・問い合わせ・集約セグメント統計） |
| `GET /api/admin/*` | 管理画面用。`ADMIN_PASSCODE` を設定していなければ 404 |

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

## 管理画面

`/admin` にあります。**合言葉を設定するまで開きません**（未設定は 404）。

```bash
npx wrangler secret put ADMIN_PASSCODE
# 開くとき: https://app.waketama.com/admin?key=合言葉
#   → 合言葉はCookieへ移され、URLからは消えます（12時間有効）
```

表示されるのは、集約に同意した分身の数値と、日次の利用状況までです。
会話の本文・記憶・覚え書きは、管理画面からも見えません。

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
- **会話の文脈は messages 配列で渡すこと**: 直近のやり取りを「システムプロンプトに貼り付けた要約文」に
  戻さないでください。以前それをやっていて（各発言を40文字に切り詰めた1行）、モデルから見ると
  毎ターン初対面になっていました。「会話が頭悪い」の原因はモデルではなくここでした。
  `data.recentTurns` に原文で持ち、`toChatMessages()` で user / assistant として積み直します。
  `src/durable-objects/__tests__/characterState.test.ts` の "conversation context" が守っています。
- **会話の中身を公開APIに載せないこと**: `GET /api/character` は cid さえ知っていれば誰でも叩けます。
  `memorySummary` / `recentTurns` / `profileNotes` / `ownerToken` は必ず除外してから返します
  （記憶を厚く持つようにした分、ここが漏れたときの被害も大きくなりました）。
- **カメラ映像はサーバーへ送らない**: `talk.html` の映像表示は端末内で完結します。送るのは
  「👁 これ見て」を押した瞬間の1枚だけで、画像もその説明文も保存しません。
  変更するときは `public/privacy.html` の記述も必ず合わせてください。
- **公開APIは許可制で返すこと**: `GET /api/character` は返す項目を列挙する方式にしてあります。
  「危ないものを除く」除外方式に戻さないでください。`CharacterData` に項目を足すたびに
  除外を書き足す必要があり、実際にそれで属性・同意状態が漏れていました（E2Eで検出）。
  許可制なら、新しい項目は既定で外に出ません。
- **同意していないデータは、どこにも出さない**: `src/persona/consent.ts` が唯一の判定元です。
  既定はすべてオフ、同意文面を変えたら `CONSENT_VERSION` を上げて取り直し、というのが前提。
  集計用レジストリ（D1）には**同意した分身しか行が存在しません**。同意を外したら値を空にするのではなく
  行ごと削除します（`syncRegistry`）。「オプトアウトできます」ではなく「オプトインしない限り出ない」を守ること。
- **属性は選択肢式のまま保つこと**: `src/persona/profile.ts` に自由記述の欄を足さないでください。
  自由記述は、氏名・勤務先・病名のような、こちらが取るつもりのない情報が入ってきます。
  `sanitizeAnswers()` は定義済みの選択肢以外を黙って捨てます。ここを緩めると、選択肢式にした意味が無くなります。
- **アクセシビリティ設定を統計に混ぜないこと**: 入力方法や滞留時間は、事実上その人の身体の状態を示します。
  だから `persona/profile.ts`（集約対象）ではなく `persona/accessibility.ts`（対象外）に分けてあります。
  集約処理は profile 側しか見に行きません。この分離を崩さないでください。
- **統計には人数の下限がある**: `src/market.ts` の `MIN_COHORT_SIZE` を下回るグループは出力しません。
  数字を下げたくなったときは、下げるのではなく集計の条件を粗くしてください。
- **管理画面は閉じているのが既定**: `ADMIN_PASSCODE` が未設定なら 404 を返します。
  「未設定なら素通し」にすると、設定を忘れた瞬間に全データが公開されます。
  なお管理者からも、会話の本文・記憶・覚え書きは見えません（レジストリに入っていないため）。

## 今後の拡張ポイント（優先度順の目安）

1. **性格更新ロジックの調整**: `src/ai/personality.ts` の係数はまだ仮の値です。実際のユーザーの会話ログを見ながらチューニングしてください
2. **会話の質の継続的な調整**: モデルの選定と文脈量は `src/ai/modelPolicy.ts` に集約してあります。モデルを変えるだけならデプロイ時に `--var CHAT_MODEL:<モデルID>` で差し替えられます（コード変更もデプロイもやり直さずに比較できます）。「覚え書き」の更新間隔は `src/ai/reflection.ts` の `REFLECTION_INTERVAL`、成長段階ごとの文脈の厚みは `contextBudgetFor()` で調整します
3. **signalExtractorの高度化**: 現状はキーワードマッチの簡易版です。SLM自体に一言で分類させる、または軽量な分類器を挟むと精度が上がります
4. **ユーザーアカウント**: 現状は持ち主トークン（localStorage）＋引き継ぎコードによる簡易的な所有権です。`users` / `user_characters` テーブルは土台のみ用意してあるので、本格的な認証（Cloudflare Access / 独自実装）が必要になった段階で実装してください
5. **iOS向けのホーム画面追加の案内**: iOS Safariは `beforeinstallprompt` に非対応のため、現在インストール案内はAndroid/Chrome系にしか出ません。共有メニューからの手順を案内するUIが必要です
6. **Web3/NFT/メタバース連携、フィジカルAIへの人格移植**: 開発メモ（フィジビリティ検討メモ）のフェーズ2・3、および人格エクスポート仕様書を参照してください

※ 長期記憶のRAG化（Vectorize）は実装済みです（`src/ai/memory.ts`）。

## 特許との関係についての実装メモ

`summon.html` の召喚演出と `talk.html`（かざして話す）は、既存特許ファミリー（第7416500号・第7503872号・
特願2024-090738）に共通する「通信端末が物体を撮像し、その撮像画像の表示中に、サーバー側で決定された処理結果を
出力する」という構成要件をなぞる設計にしてあります。実装を変更する際は、①カメラでの撮像、②その画像を
表示したままの状態、③その最中に処理結果を重畳表示、という3点を崩さないようにしてください。

`talk.html` はさらに、**同じ画面でマイクも開いたまま**にしてあります。カメラを表示している最中に検出した音声を
サーバーへ送り、撮像画像を表示したままその応答を出力する、という流れが1画面で完結します（以前は
`summon.html` がカメラのみ・`call.html` が音声のみで、画面が分かれていました）。あわせてサーバーは
文章だけでなく**演出スクリプト**（`src/ai/actionScript.ts`）を返し、ブラウザがそれを実行して出力します。
分身ごとの固有の声（`src/ai/voiceProfile.ts`）は、タグID＝characterId から一意に決まります。

これらは体験として作りたかったものでもありますが、権利との整合を意識して形を選んでいます。
崩すと整合性が変わる可能性があります（正式な判断は弁理士法人インターブレインにご確認ください）。
詳しい構成要件との突き合わせは `特開2024-129022_クレーム対応メモ.md` を参照してください。
