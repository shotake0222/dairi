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
  index.ts                    # ルーティング（/t/:code, /q/:code, /api/*, 静的配信、OGPのURL絶対化）
  yorishiro.ts                # 依代（NFCタグ・QR）の台帳と配布元、依代を持たない人の入口
  delivery.ts                 # 納品（何を売るのかの定義・引換券の発行と検証・取り出す中身）
  slm.ts                      # 自分専用のSLM一式と、判断特化AI向けの判断プロファイル
  insights.ts                 # 匿名集約のセグメント統計（出品機能は廃止済み）
  mcp.ts                      # MCPの口（相手がAIのときの納品形。読み取りだけ）
  call.ts                     # その場限りの通話（何も保存しない会話経路・SSEストリーミング）
  talk.ts                     # かざして話す（カメラ映像を出したまま声で会話。保存され、育つ）
  vision.ts                   # 「これ見て」— 見せられた1枚を言葉に変える（保存しない）
  ime.ts                      # かな漢字変換（視線・スイッチ入力の補助）
  contact.ts                  # 法人向けページ・復旧の窓口からの問い合わせの受付
  recovery.ts                 # 分身の復旧（持ち主トークンを失った人の救済。管理画面の中からのみ）
  personaRoutes.ts            # 同意・属性・アクセシビリティ設定・人格カードの書き出し（持ち主のみ）
  market.ts                   # 人格マーケット（本人出品／匿名集約セグメント統計）
  admin.ts                    # 管理画面の入口と集計API（合言葉で保護。未設定なら開かない）
  voice.ts                    # 音声の文字起こし（Whisper）と読み上げ（MeloTTS）
  transfer.ts                 # 引き継ぎコード（端末をまたいだ所有権の移動）
  health.ts                   # 自己診断（D1・Vectorizeの疎通と版数）
  hosts.ts                    # apex（紹介）とapp（本体）の振り分け・canonical・robots/sitemap
  surveyRoutes.ts             # パルスサーベイのAPI（次の1問・回答・あとで・もう聞かないで）
  lib/
    log.ts                    # 構造化ログ（本文は出さない。requestIdで串刺しに追える）
    rateLimit.ts              # AIコストの上限（保存に依存しない回数制限。DOのメモリ上で数える）
    ipQuota.ts                # 送信元ごとの1日の上限（IPは保存せず、その日限りの塩でハッシュ化）
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
    survey.ts                 # パルスサーベイ（1問ずつ聞く）と、人格データの厚みの計算
    avatarProfile.ts          # 身体のためのパラメータ（動き・距離・目線・振る舞いの識別子）
    questionStore.ts          # 設問カタログ（組み込み＋管理画面での上書き）
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
  recover.html                # 分身を取り戻す（復旧の依頼）
  home.html                   # あなたの分身（NFCタグが手元にないときの入口）
  friends.html                # 出会いの図鑑
  history.html                # 成長グラフ
  offline.html                # オフライン時の案内（PWA）
  404.html                    # 見つからなかったときの案内
  pulse.js                    # 1問ずつ聞くカード（会話画面と属性ページで共用）
  icons/mark.svg              # 勾玉のロゴ（アイコン・OGPもこの形から生成している）
tools/
  e2e.mjs                     # ブラウザ実機での通しテスト
  make-persona-fixtures.mjs   # 検証用に、正反対の2体を作ってカードを書き出す
  persona-runtime-check.mjs   # 人格カードが載せ先で動く形かを測る（到達率・識別性・LLM無しの動作）
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
| `POST /api/notes` | 覚え書きの書き換え（持ち主のみ）。`part:"seed"` で本人が書く土台、既定は会話から覚えた分 |
| `GET /t/:code`, `GET /q/:code` | 依代の読み取り。**同じ処理**。1つの依代から1体だけ、姿はランダム |
| `POST /api/character/new` | 依代を持たない人の入口（1日3体まで／同じ回線から） |
| `GET /api/spot` | その依代がどこで配られたか（画面に出す範囲だけ） |
| `GET/POST /api/admin/tags` | 依代の台帳と発行（管理画面の中だけ） |
| `GET/POST/DELETE /api/admin/spots` | 配布元（特別な場所）の管理 |
| `GET /api/delivery` | 買い手が引換券で取り出す口（`scope=card\|behavior\|mcp\|bundle`） |
| `POST /mcp` | MCP（相手がAIのとき）。読み取りだけ。`Authorization: Bearer <引換券>` |
| `GET /api/admin/skus` | 商品の定義（`src/delivery.ts` の `SKUS`） |
| `GET/POST/DELETE /api/admin/grants` | 引換券の発行・一覧・失効 |
| `POST /api/contact` | 法人向けページ・復旧の窓口からの問い合わせ |
| `GET /api/admin/recovery/lookup` / `POST .../issue` | 復旧（本人確認用の情報の照会と、引き継ぎコードの発行） |
| `GET/POST /api/market/*` | マーケット（一覧・出品・問い合わせ・集約セグメント統計） |
| `GET /api/admin/*` | 管理画面用。`ADMIN_PASSCODE` を設定していなければ 404 |
| `GET /api/survey/next` | 次に聞く1問と、人格データの厚み（持ち主のみ） |
| `POST /api/survey/answer` / `skip` / `decline` | 回答・あとで・もう聞かないで |
| `GET /api/survey/catalog` | 設問カタログ（組み込み＋管理画面での上書き） |
| `GET/POST /api/admin/questions` | 設問の一覧と編集（管理画面の中だけ） |
| `GET /robots.txt`, `GET /sitemap.xml` | ホストごとに内容が変わる（本体側は全面拒否、検証環境も全面拒否） |
| `GET /sw.js` | Service Worker。`SW_KILL=1` を付けてデプロイすると解除用スクリプトに差し替わる |

## 依代（よりしろ）— 入口の考え方

分身が宿るものを、画面では「依代」と呼んでいる。NFCタグでもQRでも、**仕組みはまったく同じ**。

- **1つの依代からは1体だけ。** 2回目以降の読み取りは、同じ子に会いに行く
- **姿はランダム。** どの依代でも確率は等しく、運営が指定する口は用意していない
  （`CharacterState.init()` に見た目を渡す引数を**足さないこと**。足した時点で「引き当てた」が「配られた」に変わる）
- `/t/:code`（かざす）と `/q/:code`（読み取る）は同じ台帳（`nfc_tags`）を引く。違いは計測名と来歴だけ
- 「その場所でしか手に入らない」は、姿を固定するのではなく、**そのコードをその場所にしか置かないこと**で作る

入口は3つ:

| 入口 | URL | 性質 |
| --- | --- | --- |
| NFCタグ | `/t/<code>` | 手元のキーホルダー |
| QR | `/q/<code>` | 配られた1枚。かざすのと同じ扱い |
| 依代なし | `POST /api/character/new`（画面は `/add`） | その端末だけで育てる。引き継ぎコードだけが戻り道 |

台帳（`tag_registry`）に無いコードで読み取られても分身は生まれる。台帳を作る前に配ったタグを
死なせないため。台帳は「こちらが発行した分はどれか」「まだ使われていないのはどれか」を見るためのもの。

管理画面の「依代（タグ・QR）」タブで、発行・CSV書き出し・QR画像の生成までできる
（QRの生成は `public/vendor/qrcode.js`。外部のQR生成サイトに貼ると、どのコードを刷ったかが他所に残る）。

## 何を売るのか（納品）

売るのは分身そのものではなく、**その人格を相手の環境で動かせる形にした写し**と、
それを取り出す権利（引換券）。所有権は持ち主のまま動かない。

| 商品 | 買い手 | 渡すもの |
| --- | --- | --- |
| 人格カード（`card`） | 自前のLLM基盤を持っている相手 | JSON / systemPrompt / Modelfile / README |
| 自分専用のSLM（`slm`） | 手元の小さなモデルで喋らせたい相手 | Modelfile ＋ LoRA学習データ ＋ 手順書 |
| 判断プロファイル（`decision`） | Jev等の判断特化AIに繋ぎたい相手 | Choice / Score / Noul と既定の答え |
| 振る舞いプロファイル（`behavior`） | **AIを積んでいない機器**を作っている相手 | 数値だけの数百バイト＋参照実装。**LLM不要** |
| MCP接続（`mcp`） | 自社のAIエージェントから参照したい相手 | `/mcp` と引換券。読み取りだけ |
| 持ち出し一式（`bundle`） | ネットに繋がない環境 | 上をまとめた1ファイル |

定義元は `src/delivery.ts` の `SKUS`。管理画面の「納品」タブはこの配列を表示しているだけなので、
**営業資料と実装がずれない**。詳しくは [docs/SALES_DELIVERY.md](docs/SALES_DELIVERY.md)。

引換券（`delivery_grants`）は1枚が1体に紐づき、範囲と期限を持つ。平文は発行時の1回しか出ない
（保存しているのはハッシュ）。持ち主トークンは買い手に一切渡さない——渡すと名前の変更も削除もできてしまう。

MCPの `persona_reply` は**何も保存しない経路**（`beginEphemeralTurn`）を通る。
買い手との会話で持ち主の分身が育つ実装にはしないこと。

## 実機（Raspberry Pi / ESP32）で動かす

人格カードは数十KBあり、会話の抜粋も入っているので機器には焼かない。
`tools/edge/compact.mjs` で **数値と識別子だけの数百バイト**に落としてから渡す。
この形なら ESP32 や Pico でも動き、**LLMは要らない**（「人格→振る舞い」の翻訳は
`src/persona/avatarProfile.ts` がサーバ側で済ませている）。

手順・機種ごとの線引き・合格基準は [docs/EDGE_DEVICE_TEST.md](docs/EDGE_DEVICE_TEST.md)、
**会話のテキストがどうやって動作になるのか**（6段の変換過程と、その限界）は
[docs/TEXT_TO_BEHAVIOR.md](docs/TEXT_TO_BEHAVIOR.md)。

> **用語**: SLM は Small Language Model。SML（Standard ML）ではない。
> **Jev は TypeSafe AI の製品**で、こちらでは作れない。渡せるのは判断プロファイルまで。

```bash
curl -o card.json "https://app.waketama.com/api/character/card?format=json&cid=<CID>&token=<TOKEN>"
node tools/edge/make_compact.mjs card.json -o persona.min.json   # 漏れの確認つき
python3 tools/edge/rule_runtime.py persona.min.json              # LLMなしで振る舞いを見る
```

## 2つのドメイン

| ドメイン | 役割 |
| --- | --- |
| `waketama.com`（apex） | 紹介ページ（`/lp`・`/biz`）。検索・SNS・名刺からの入口 |
| `app.waketama.com` | サービス本体（`/home` 以下）。分身を育てる場所 |

同じWorkerが両方を受け、`src/hosts.ts` の `hostRedirect()` が振り分けます。

- apex の `/` → `/lp`
- apex にアプリ本体のパス（`/home`・`/chat`・`/t/:id`・`/admin` など）で来たら app へ送り返す
- app で `/lp`・`/biz` を開いたら apex へ送る
- `/terms`・`/privacy` はどちらでも開ける（canonical は apex）

**本体を1つのホストに寄せているのは、持ち主トークンが localStorage にあるためです。**
localStorage はオリジンごとに別物なので、同じアプリを2つのホストで開けるようにすると、
片方で育てた分身がもう片方からは「持ち主ではない」ものに見えます。
ユーザーから見れば分身を失ったのと同じです。この一線は動かさないでください。

`SITE_HOST` / `APP_HOST`（`wrangler.toml` の `[vars]`）のどちらかが欠けていれば、振り分けは
一切行われません。また `wrangler dev` はリクエストのURLもHostヘッダも独自ドメインに書き換えるため、
ローカルでは振り分けを無効にしています（`isEdgeRuntime()`。これが無いとローカルでLPを開けません）。

### アセットの 404 について

`[assets]` の `not_found_handling` は **既定（none）のままにしてください**。
`"404-page"` にすると、アセットに無いパスをアセット層がその場で404にしてしまい、
**リクエストがWorkerまで届かなくなります（`/api/*` が丸ごと死にます）**。
案内のある404ページは `serveAsset()` が `public/404.html` を読んで返しています。

## 設問（デモグラフィック／サイコグラフィック）

### 中身を確認する方法

1. **管理画面の「設問」タブ**（`/admin` → 設問）。全27問が、種類・いつ聞くか・選択肢つきで一覧になります。
   ここが唯一の確認場所です。
2. **APIで見る**: `GET /api/survey/catalog`（認証不要。個人のデータは含みません）。
3. **コードで見る**: 属性は `src/persona/profile.ts`、価値観は `src/persona/survey.ts`。
   「なぜ聞くのか」の文言と、聞いてよい会話回数（`askAfter`）もここに書いてあります。

### 聞き方

会話の合間に**1問ずつ**出します（`public/pulse.js`）。まとめて聞けば10分のアンケートになり、
「登録不要ですぐ始められる」という入口の価値と正面からぶつかるためです。

- **属性と価値観を交互に出す**。属性だけでは名簿に近く、価値観だけでは心理テストになります。
  人格データとして意味があるのは「30代・首都圏」ではなく「30代・首都圏で、安定より刺激を選ぶ人」のほうです。
- **同意が先**。答えを保存する行為なので、`profile` 同意が無ければ設問の代わりに同意の依頼を返します。
  「答えてくれたから同意したものとみなす」は後から説明できません。
- **「あとで」と「もう聞かないで」は別物**。前者はその設問を後回しにするだけ、後者はこちらから促すのをやめます。
- 会話画面では**1問だけ**（3回以上会話してから）。属性ページ（`/profile`）では続けて答えられます。

### 価値観の設問と、AI推定の重ね方

価値観の設問は、会話からのAI推定（`src/analysis/psychographics.ts`）と**同じ8軸**に載せてあります。
本人が答えた軸は `selfReported` に控え、以降のAI推定はその軸をほとんど動かしません（重み 0.3 → 0.06）。
聞いておいて次の会話で上書きするのでは、答えた意味がなくなるためです。

### 設問を足す・直す（デプロイ不要）

管理画面の「設問」タブから、追加・文言の変更・並べ替え・無効化ができます。
組み込みの設問はコード側に残したままで、DB（`survey_questions`）には**上書きと追加だけ**が入ります。

- 同じIDで保存すると上書き。一覧に「上書き」と出ます。**既定に戻す**でいつでも元の文言へ戻ります
- 出したくない設問は削除ではなく「出さない」に。消すと、次の版で復活したときに気づけません
- 価値観の設問には、選択肢ごとに0〜100の点数が要ります（その軸がその値へ寄る）。点数の無い設問は保存できません
- 表が空でもサービスは完全に動きます（初期化を忘れて設問が全部消える、という壊れ方をしません）

### 人格データの「厚み」

`src/persona/survey.ts` の `personaDepth` が、会話の量（40点）・属性（25点）・価値観（20点）・
覚えていること（15点）から0〜100で出します。**60以上が出品・提供の目安**です。
本人には `/profile` の「この分身の厚み」、運営には管理画面の人格データ一覧に出ます。
会話だけでは60に届かないようにしてあります（たくさん喋っていても、誰なのか分からない分身は売り物になりません）。

## 人格カードは、本当に載せ先で動くのか

「集めたデータで、フィジカルAIやメタバースのアバターが動くのか」を測るための検査があります。

```bash
npm run dev            # 別プロセスで
npm run persona:check  # 対照になる2体を作って、カードを測る
```

正反対の答えをした2体（**さきがけ**＝刺激・自律が高い／**ひだまり**＝安定・思いやりが高い）を作り、
書き出したカードがどれだけ違うかを数字で出します。

### 何を測っているか

| 観点 | 内容 |
| --- | --- |
| A. 必須項目 | LLMランタイム／メタバースのアバター／フィジカルAI の3つの載せ先ごとに、必要な項目が揃っているか |
| B. **到達率** | カードに入っている情報のうち、`runtime.systemPrompt` に実際に現れている割合 |
| C. 識別性 | 2体のプロンプト・価値観・身体パラメータがどれだけ離れているか |
| D. 落とし穴 | AI失敗時の定型文が応答例に混ざっていないか、年収が漏れていないか |
| E. LLM無しの動作 | `policy[].code` だけで動くルールエンジンで、4場面の振る舞いが分かれるか |
| F. 実モデル（任意） | `PERSONA_LLM_URL` を指定したときだけ、実際に生成させて方向性を見る |

### この検査を書いて分かったこと（2026-09-14）

**サーベイで集めた価値観8軸は、書き出したカードのプロンプトに1文字も入っていませんでした。**
JSONの中には入っていましたが、大半の載せ先は `systemPrompt` しか読みません。到達率は55%と48%でした。
属性（年代・地域・職業など）も同様で、11項目中2〜3項目しか届いていませんでした。

- 到達率: **55% / 48% → 100% / 100%**
- 身体のパラメータ: **無し → あり**（動き・間・目線・対人距離・振る舞いの識別子）
- 応答例: AI失敗時の定型文（「うまく考えがまとまらない…」）が**5組すべてを占めていた** → 除外するようにした
  （そのまま渡すと、載せ先のモデルがその言い回しを口調として真似ます）

### 実モデルでの確認

このリポジトリのクラウド開発環境からはモデルの重みを取得できない（配信元が許可リストの外）ため、
**実際のLLMに載せた確認は手元で行ってください**。Ollama があれば1コマンドです。

```bash
ollama serve                                   # 別プロセスで
PERSONA_LLM_URL=http://localhost:11434/v1/chat/completions \
PERSONA_LLM_MODEL=qwen2.5:7b-instruct \
  node tools/persona-runtime-check.mjs
```

同じ3つの質問を2体に投げ、それぞれの人物像どおりの方向に答えたかを出します。
書き出した Modelfile をそのまま使う場合は次のとおりです。

```bash
curl "https://app.waketama.com/api/persona/card?cid=<cid>&token=<token>&format=modelfile" -o Modelfile
ollama create waketama-mine -f ./Modelfile
ollama run waketama-mine
```

### 身体を持たせるとき（runtime.avatar）

人格の多くは言葉ではなく**間・距離・目線**に出るので、そこを数値で渡しています
（導出は `src/persona/avatarProfile.ts`。実機を見ながら調整する前提の初期値です）。

- `motion`: 動きの大きさ・身振りの頻度・待機中の揺らぎ・応答までの間・目線を保つ長さ・姿勢の開き
- `proxemics`: 心地よい対人距離（m）と近づく速さ（m/s）
- `expression`: 何もしていないときの口角・まばたきの回数
- `policy[]`: 価値観から導いた振る舞いの方針。`code`（固定の識別子）と `behavior`（日本語）の2つを持つ

`code` は日本語を解さない制御系でも分岐に使えます。同じ人格データで、
LLMを積んだ端末では会話が、積めない端末では動きと判断が変わる、という形にしてあります。

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

# 管理画面と復旧の中身まで通しで確認する場合（所有権を移す操作を含むので、一度は通しておきたい）
#   .dev.vars に ADMIN_PASSCODE="..." を書いたうえで
E2E_ADMIN_PASSCODE=<同じ値> npm run test:e2e
```

ブランド画像（PWAアイコン・OGP画像）は `npm run brand:assets` で再生成できます（要 Pillow）。

## 管理画面

`/admin` にあります。**合言葉を設定するまで開きません**（未設定は 404）。

```bash
npm run admin:passcode
```

**この引数（`ADMIN_PASSCODE`）は「シークレットの名前」です。合言葉そのものではありません。**
実行すると `Enter a secret value:` というプロンプトが出るので、**そこに合言葉を入力**してください。
`npx wrangler secret put <合言葉>` と書くと、その文字列を名前とするシークレットが作られ、
`ADMIN_PASSCODE` は未設定のまま＝管理画面は開きません（間違えたら `npx wrangler secret delete <名前>` で消せます）。

`npm run admin:passcode` の実体は `wrangler secret put ADMIN_PASSCODE --env=""` です。
`--env=""` を付けているのは、`wrangler.toml` に staging 環境も書いてあるため、
省略すると wrangler がどちらのWorkerに入れるか決められず、本番側に入らないことがあるからです。

設定できたかは `npm run secrets:list`（`ADMIN_PASSCODE` が並べばOK）か、
`/api/health` の `admin` フィールド（`enabled` / `disabled`）で確認できます。
**シークレットの設定にデプロイは不要です**（設定した瞬間から有効）。
逆に、`git pull` しただけではサイトは変わりません。ページの変更を反映するには `npm run deploy` が必要です。
開くときは `https://app.waketama.com/admin?key=合言葉`。合言葉はCookieへ移され、URLからは消えます（12時間有効）。

表示されるのは、集約に同意した分身の数値と、日次の利用状況、問い合わせ、そして復旧の窓口までです。
**会話の本文・記憶・覚え書きは、管理画面のどこにも表示されません。**

### 分身の復旧について

持ち主トークンを失った方に、本人確認のうえで引き継ぎコードを発行できます（管理画面の「分身の復旧」タブ）。

設計上の要点は**復旧に会話の閲覧は要らない**ということです。復旧とは所有権を本人の端末へ戻すことで、
トークンが戻れば会話履歴も記憶も本人が見られる状態に復帰します。だから管理画面には
本人確認に使う項目（名前・見た目・育ち具合・育て始めた時期）までしか出していません。
中身を読める画面を作ると、その画面自体が最大の漏洩経路になります。

なお「絶対に見られない」わけではありません。データを預かっているのは運営なので、
技術的にはアクセスできます。プライバシーポリシーにもそう書いてあります。
仕組みで不可能にしているのではなく、そうしない運用にしている、という区別を崩さないでください。

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
