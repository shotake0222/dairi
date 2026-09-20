# 実機で人格データを動かす — 検証手順書

対象: Raspberry Pi 5 / 4 / Zero 2 W、Raspberry Pi Pico（2）W、ESP32
最終更新: 2026-09-19

---

## 0. この文書が答えること

**「わけたまで集めた人格データで、本当に実機が動くのか」**を、自分の手で確かめるための手順。
「動く」を3段階に分けて、それぞれ別の確かめ方を書いてある。

| 段階 | 確かめること | 必要な機材 | LLM |
|---|---|---|---|
| **A. 振る舞い** | 人格の違いが、動き・間合い・距離の違いとして出るか | Pico / ESP32 でも可 | **不要** |
| **B. 言葉** | その子らしい喋り方になるか | Pi 4 以上（8GB推奨） | 必要（ローカル） |
| **C. 常時オフライン** | ネットが無くても A+B が成立するか | Pi 5 / Pi 4 8GB | 必要（ローカル） |

> **専用の検証機を作るなら**、この手順を1台の機械にまとめたものがある。
> 設計 [DEVICE_DESIGN.md](DEVICE_DESIGN.md) / 仕様 [DEVICE_SPEC.md](DEVICE_SPEC.md) / 作り方 [DEVICE_BUILD.md](DEVICE_BUILD.md)。
> 2体へ同時にイベントを投げて、差を自動で判定し、記録をCSVに落とすところまで入っている。
> こちらの文書は「手元にある機材で、まず確かめる」ための最小手順として残してある。
>
> **サーボやHC-SR04が無くても試したいなら**、ブラウザだけで同じ判定ができる
> アバター実験室がある: [METAVERSE_AVATAR_TEST.md](METAVERSE_AVATAR_TEST.md)（`npm run device:avatar`）。

要点を先に書くと、**Aの段階にLLMは要らない**。
「人格 → 振る舞い」の翻訳はサーバ側（`src/persona/avatarProfile.ts`）で済ませてあり、
機器へ渡すのは**数百バイトの数値と識別子だけ**。だから Pico や ESP32 でも成立する。
これが、フィジカルAI／メタバースへ持ち出せると言っている根拠の実体。

---

## 1. 機種ごとの現実的な線引き

| 機種 | RAM | ローカルLLM | 段階A | 段階B | 備考 |
|---|---|---|---|---|---|
| Raspberry Pi 5 (8GB) | 8GB | ○ 3B〜8B（Q4） | ○ | ○ 実用 | 8Bで概ね 4〜7 tok/s |
| Raspberry Pi 4 (8GB) | 8GB | △ 3B（Q4） | ○ | △ 我慢できる | 3Bで 2〜4 tok/s |
| Raspberry Pi 4 (4GB) | 4GB | △ 1B〜3B（Q4） | ○ | △ | 8Bは載らない |
| Raspberry Pi Zero 2 W | 512MB | × | ○ | × | 言葉はクラウド側に任せる |
| Raspberry Pi Pico 2 W | 520KB | × | ○ | × | MicroPython |
| ESP32 (WROOM-32) | 520KB | × | ○ | × | Arduino |

数値は目安で、量子化・熱・電源で大きく変わる。**段階Aは全機種で成立する**のがこの設計の肝。

> 注意: Pi Zero 2 W / Pico / ESP32 に「小さなLLMを載せる」試みは、やめておくこと。
> 動いたとしても1文に数十秒かかり、人格の違い以前に会話として成立しない。
> 言葉が要る場面は、機器から `/api/chat` を叩く（ネットがある前提）か、
> 段階Aの振る舞いだけで完結させる設計にする方が、体験としてずっとよい。

---

## 2. 用意するもの

### 共通

- 育った分身が1体（できれば**2体、性格が違うもの**）。差を見ないと「動いている」の確認にならない
- その分身の `cid` と持ち主トークン
  - `cid`: チャット画面のURL `?cid=...`
  - トークン: そのブラウザの開発者ツール → Application → Local Storage → `sodatsukake_token_<cid>`
  - **トークンは持ち主の証。人に渡さないこと**

### 段階A（振る舞い）

- Pi / Pico / ESP32 のいずれか1台
- サーボ1個（SG90など）、LED1個、抵抗330Ω
- サーボの電源は別で取る（USBから取るとリセットが掛かる）

### 段階B・C（言葉）

- Raspberry Pi 4 以上、放熱（ヒートシンク＋ファン）、電源は公式アダプタ
- microSD 32GB 以上（8Bのモデルだけで 5GB 近い）

---

## 3. 段階A — 振る舞いが人格で変わることを確かめる

### A-1. 人格カードを取り出す

```bash
# 手元のPCで
curl -o card.json \
  "https://app.waketama.com/api/character/card?format=json&cid=<CID>&token=<TOKEN>"
```

`card.json` には会話の抜粋・覚え書き・属性が入っている。**これは機器へ焼かないこと。**

### A-2. 機器用の最小形に落とす

```bash
node tools/edge/make_compact.mjs card.json -o persona.min.json
```

出力例（実測）:

```
persona.min.json を書き出しました（248 バイト）
  名前: さきがけ  方針: prefer_novel_options, offer_choices_not_answers, ...
  会話・覚え書き・属性は含まれていません（機器へ焼いて問題ありません）
```

中身はこうなる。**日本語の文章も、会話も、属性も入っていない**（名前だけは呼びかけのため残す）:

```json
{"v":1,"id":"edge-bol","n":"さきがけ","m":[82,66,90,410,1080,59],
 "p":[1.3,0.7],"e":[66,16],"t":[50,90,82,20,50,50],
 "c":["prefer_novel_options","offer_choices_not_answers","tolerate_open_plans",
      "suggest_updates","track_progress","prioritize_enjoyment"]}
```

| キー | 中身 |
|---|---|
| `m` | 動きの大きさ / 身振りの頻度 / 待機の揺らぎ / 返すまでの間(ms) / 目線を保つ長さ(ms) / 姿勢の開き |
| `p` | 心地よい距離(m) / 近づく速さ(m/s) |
| `e` | 何もしていないときの口角 / まばたき（毎分） |
| `t` | 性格6軸（温かさ, 好奇心, 陽気さ, 慎重さ, 自立心, ユーモア） |
| `c` | 振る舞いの方針。**機械が分岐するための固定の識別子**（訳さない） |

漏れの確認は目視ではなく機械でやっている（`tools/edge/compact.mjs` の `auditCompact`）。
CIでも見ている（`src/persona/__tests__/edgeCompact.test.ts`）。

### A-3. まずPCの上で動かす（機材を触る前に）

```bash
python3 tools/edge/rule_runtime.py persona.min.json
```

性格の違う2体を並べると、こう出る（**実際の出力**）:

```
$ python3 tools/edge/rule_runtime.py bold.min.json careful.min.json --events=approach,greet

=== さきがけ ===
方針: prefer_novel_options, offer_choices_not_answers, tolerate_open_plans, ...
[approach] 相手との距離 2.0m
  servo  drive      forward 0.7m/s
[greet]
  wait   410ms
  servo  arm        wave 1/2
  servo  arm        wave 2/2
  servo  gaze       hold 1080ms
  led    mouth      smile 86%

=== しずか ===
方針: confirm_before_change, prefer_familiar_options, notice_others_first, ...
[approach] 相手との距離 2.0m
  servo  head       tilt toward
  （自分からは寄らない）
[greet]
  wait   930ms
  servo  arm        wave 1/1
  servo  gaze       hold 1444ms
  led    mouth      smile 51%
```

**合格の基準**（ここを満たさないなら、データが人格になっていない）:

- 返すまでの間が **1.5倍以上** 違う
- 身振りの回数が違う（2回 vs 1回）
- 近づくかどうかの判断が分かれる
- 方針の識別子に、互いに相手が持たないものがある
- 5つのイベントのうち3つ以上で、手順が違う

> 以前ここは「2倍以上」だった。ある1回の実測（410ms vs 930ms）をそのまま線にしたもので、
> **きつすぎた**（別の回の 458ms vs 890ms ＝ 1.94倍が不合格になる）。
> 実測の2体は 1.9〜2.3倍に散らばるので、「はっきり違うと分かる」線として 1.5倍を採る。

判定は目で見ない。`tools/device/common/wt_core.py` の `compare()` が5項目を機械で見る:

```bash
python3 tools/device/pi/wt_hub.py compare     # 合格／不合格が項目ごとに出る
```

`--diff` を付けると差だけ並ぶ:

```bash
python3 tools/edge/rule_runtime.py bold.min.json careful.min.json --diff
```

### A-4. Raspberry Pi（Zero 2 W でも可）で動かす

`rule_runtime.py` の `out_servo` / `out_led` / `out_wait` を GPIO に差し替えるだけ。

```bash
sudo apt install -y python3-gpiozero
scp persona.min.json tools/edge/rule_runtime.py pi@raspberrypi.local:~/
ssh pi@raspberrypi.local 'python3 rule_runtime.py persona.min.json'
```

実物を動かす版（`rule_runtime.py` の先頭3関数を置き換える）:

```python
from gpiozero import Servo, PWMLED
_servo = Servo(17)
_led = PWMLED(18)

def out_servo(name, value):
    if name == "body_sway":
        _servo.value = 0.3
def out_led(name, value):
    _led.value = min(1.0, int(str(value).rstrip("%")) / 100)
def out_wait(ms):
    import time; time.sleep(ms / 1000)
```

### A-5. ESP32 で動かす

1. Arduino IDE に ESP32 ボードを追加、ライブラリ `ArduinoJson`（v6以降）と `ESP32Servo` を入れる
2. `tools/edge/esp32_waketama/esp32_waketama.ino` を開く
3. `PERSONA_JSON` に `persona.min.json` の中身を1行で貼る
4. 書き込み → シリアルモニタ 115200bps

差し替えの確認: シリアルモニタに別の `persona.min.json` を1行で貼ると、その場で人格が入れ替わる。
**同じ配線・同じファームで、動きだけが変わる**のが見どころ。

メモリは `StaticJsonDocument<768>` で足りている（最小形が 250 バイト前後のため）。

### A-6. Raspberry Pi Pico（MicroPython）で動かす

```bash
# Thonny か mpremote で転送
mpremote cp persona.min.json :persona.min.json
mpremote cp tools/edge/pico_waketama.py :main.py
mpremote reset
```

---

## 4. 段階B — その子らしく喋ることを確かめる（Raspberry Pi 4 以上）

### B-1. Ollama を入れる

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:3b-instruct-q4_K_M    # Pi 4 (4GB) 向け
# ollama pull llama3.1:8b-instruct-q4_K_M # Pi 5 (8GB) 向け
```

### B-2. 人格を焼いたモデルを作る

わけたまは Ollama の Modelfile をそのまま出力できる。

```bash
curl -o Modelfile \
  "https://app.waketama.com/api/character/card?format=modelfile&base=qwen2.5:3b-instruct-q4_K_M&cid=<CID>&token=<TOKEN>"

ollama create waketama-mychild -f Modelfile
ollama run waketama-mychild
```

Modelfile には性格・口調・価値観の行動指示・覚え書き・会話の例が入る。
**この時点でネットは要らない。** 以降、機内モードでも喋る。

### B-3. 「本当にこの子か」を数字で確かめる

思い込みで「らしくなった」と言わないために、判定の道具を用意してある。

```bash
# 手元のPCから、Pi の Ollama を指して実行
PERSONA_LLM_URL=http://raspberrypi.local:11434/v1/chat/completions \
  npm run persona:check
```

出るもの:

| 指標 | 意味 | 合格の目安 |
|---|---|---|
| 到達率 | カードに入れた事実が、応答に現れる割合 | **80%以上** |
| 弁別性 | 性格の違う2体が、違う答えを返す割合 | **70%以上** |
| 落とし穴 | 知らないはずのことを喋っていないか | **0件** |

サーバ側（Workers AI）での基準値は同じコマンドで取れるので、
**同じ人格カードで、クラウドとエッジの数字を並べて比べられる**。
これが「載せ替えても人格が保たれる」ことの証拠になる。

---

## 5. 段階C — 常時オフラインでの通し確認

1. Pi を Wi-Fi から切る（`sudo nmcli radio wifi off`）
2. `ollama run waketama-mychild` で 10 往復ほど話す → **喋れること**
3. 同じ Pi 上で `python3 rule_runtime.py persona.min.json` → **動くこと**
4. 電源を落として入れ直す → 1〜3 が再現すること

ここまで通れば、「クラウドが無くても、この子はこの子として動く」と言える。

**残る差**: オフラインでは新しく覚えない（覚え書きの更新はサーバ側の処理）。
続きを覚えさせたいときは、オンラインに戻して会話するか、
覚え書きを手で書く（`/profile` の「あなたが書く土台」）。

---

## 6. 記録の取り方（このまま社外へ出せる形）

検証のたびに、この表を埋めて残すこと。数字が無い報告は、次に誰も再現できない。

| 項目 | 記入 |
|---|---|
| 日付 / 担当 | |
| 機種 / RAM / 電源 | |
| OS / カーネル | |
| モデル（段階B） | |
| 人格カードの `cid` 下4桁 | |
| 最小形のバイト数 | |
| 応答までの時間（段階A, ms） | |
| 1文の生成時間（段階B, 秒） | |
| 到達率 / 弁別性 / 落とし穴 | |
| 連続稼働（時間） / 発熱（℃） | |
| 気づいたこと | |

---

## 7. つまずきやすいところ

| 症状 | 原因 | 対処 |
|---|---|---|
| `runtime.avatar がありません` | 古い形式の人格カード | カードを取り直す |
| 最小形が 512 バイトを超える | 方針が多すぎる | `toCompact(card, { maxPolicies: 4 })` |
| ESP32 が書き込み直後に落ちる | サーボの電流をUSBから取っている | サーボの電源を別系統に |
| 2体を比べても差が出ない | 育ちが浅い（会話が少ない） | 会話回数35回（おしゃべり期）以上の子で比べる |
| Ollama が OOM で落ちる | モデルが大きすぎる | 量子化を下げる（q4_K_M → q4_0）か 3B へ |
| Pi 4 が数分で遅くなる | サーマルスロットリング | ヒートシンク＋ファン。`vcgencmd measure_temp` で確認 |
| 到達率が低い | 覚え書きが薄い | `/profile` の「あなたが書く土台」を先に埋める |

---

## 8. 関連するファイル

| 目的 | 場所 |
|---|---|
| 人格 → 振る舞いの翻訳（サーバ側） | `src/persona/avatarProfile.ts` |
| その翻訳の全体像（会話→数値→動作） | `docs/TEXT_TO_BEHAVIOR.md` |
| 人格カードの組み立て | `src/persona/personaCard.ts` |
| 機器用の最小形への変換 | `tools/edge/compact.mjs` |
| 変換のCLI（漏れの確認つき） | `tools/edge/make_compact.mjs` |
| 参照実装（LLMなし・Python） | `tools/edge/rule_runtime.py` |
| ESP32 のスケッチ | `tools/edge/esp32_waketama/esp32_waketama.ino` |
| Pico（MicroPython） | `tools/edge/pico_waketama.py` |
| 到達率・弁別性の測定 | `tools/persona-runtime-check.mjs`（`npm run persona:check`） |
| 最小形の自動検証 | `src/persona/__tests__/edgeCompact.test.ts` |
| メタバースのアバターでの同じ検証 | `docs/METAVERSE_AVATAR_TEST.md`（`npm run device:avatar`） |
| **検証機（WT-1〜4）の設計・仕様・作り方** | `docs/DEVICE_DESIGN.md` / `DEVICE_SPEC.md` / `DEVICE_BUILD.md` |
| 検証機のファームと母艦 | `tools/device/` |
| 検証機の自己点検 | `tools/device/selftest.py`（`npm run device:selftest`） |
