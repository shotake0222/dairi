# わけたま検証機 — 仕様書

最終更新: 2026-09-20
対象: WT-1（Pico 2 W）/ WT-2（ESP32）/ WT-3（Pi Zero 2 W・Pi 4）/ WT-4（母艦）

設計の意図は [DEVICE_DESIGN.md](DEVICE_DESIGN.md)、作り方は [DEVICE_BUILD.md](DEVICE_BUILD.md)。
ここは**実装が従う決まりごと**だけを書く。ここと実装が食い違ったら、実装を直す。

---

## 1. 用語

| 語 | 意味 |
|---|---|
| 人格カード | `/api/character/card?format=json` の出力。会話の抜粋・覚え書き・属性を含む数十KB。**機器へ渡さない** |
| 最小形（compact） | 機器へ渡す 約250バイトのJSON。数値と方針コードだけ |
| 母艦（hub） | 人格カードを取り、最小形にし、子機へ配り、記録する機械。トークンを持つ唯一の場所 |
| 子機（node） | 最小形を受け取って動く機械。WT-1〜3 |
| 枠（slot） | 子機の識別子。`a` / `b`。2体比較のための呼び名 |
| イベント | 子機が受け取る状況。`idle` / `approach` / `greet` / `change` / `silence` |

---

## 2. 最小形（compact v1）

出所は `tools/device/contract.json`。**この表と食い違う実装はバグ。**

```json
{"v":1,"id":"5b0a7533","n":"さきがけ","m":[77,73,85,458,1212,65],
 "p":[1.3,0.7],"e":[65,17],"t":[55,88,74,26,84,66],
 "c":["prefer_novel_options","take_initiative","prioritize_enjoyment"]}
```

| キー | 型 | 中身 |
|---|---|---|
| `v` | int | 形式の版。**1 以外は読まない**（読んだら別の意味の数値で動く） |
| `id` | string(8) | ログで見分けるための短いID。元の `cid` は載せない |
| `n` | string(16) | 名前。呼びかけ・表示のためだけ |
| `m` | int[6] | energy / gestureRate / idleVariance / responseDelayMs / gazeHoldMs / postureOpenness |
| `p` | number[2] | comfortableDistanceM / approachSpeedMps |
| `e` | int[2] | baselineSmile / blinkRatePerMin |
| `t` | int[6] | warmth / curiosity / cheerfulness / caution / independence / humor |
| `c` | string[≤6] | 方針コード。**訳さない。機器はこの文字列で分岐する** |

### 2-1. 制限

| 項目 | 値 | 理由 |
|---|---|---|
| 最大サイズ | **512 バイト** | ESP32 の `StaticJsonDocument<768>` と Pico の読み込みに余裕を残す |
| 方針コードの数 | 6 まで | 全員に全部付くと、方針の意味が消える |
| 文字コード | UTF-8、1行、改行なし | シリアルで1行として送るため |

### 2-2. 入れてはいけないもの

会話・覚え書き（notes）・記憶（memories）・属性（attributes）・systemPrompt・持ち主トークン・`cid` の全体。

`wt_compact.audit()`（Python）と `auditCompact()`（JS）が機械で検査し、
1つでも見つかったら**配布を止める**。目視に任せない。

---

## 3. ピン割り当て

出所は `tools/device/pinmap.json`。図（`docs/device/*.svg`）とファームの定数
（`wt_pins.py` / `wt_pins.h`）は、そこから生成される。**手で書かない。**

| 役割 | Pico (GP) | ESP32 (GPIO) | Pi (BCM) | 種別 |
|---|---|---|---|---|
| SERVO_BODY | 16 | 13 | 17 | PWM出力 |
| SERVO_ARM | 17 | 27 | 27 | PWM出力 |
| LED_MOUTH | 15 | 25 | 18 | PWM出力 |
| LED_EYE | 14 | 26 | 13 | PWM出力 |
| BTN_TALK | 18 | 33 | 22 | 入力・プルアップ |
| SONAR_TRIG | 20 | 32 | 23 | 出力 |
| SONAR_ECHO | 21 | 35 | 24 | 入力（**要 分圧**） |
| BUZZER | 22 | 4 | 25 | PWM出力（任意） |
| LED_ALIVE | オンボード | 2 | — | 出力 |

### 3-1. 触ってはいけないピン（ESP32）

| ピン | 何が起きるか |
|---|---|
| 0, 2, 5, 12, 15 | 起動時の状態を見ている。サーボを繋ぐと書き込みに失敗する／起動しない |
| 6〜11 | 内蔵フラッシュ。触ると起動しなくなる |
| 34〜39 | 入力専用。プルアップも無い。ECHO にだけ使う |

`selftest.py` §6 がこれを毎回確かめる。

### 3-2. HC-SR04 の ECHO

HC-SR04 の ECHO は **5V を出す**。3.3V の石に直結すると壊れる。
10kΩ と 20kΩ で分圧して約 3.3V にする。

```
ECHO ──[10kΩ]──┬── 石のピンへ
               │
            [20kΩ]
               │
              GND
```

---

## 4. 通信の取り決め（WTP/1）

1行 = 1つのJSON、改行区切り。USBシリアル（115200 8N1）でも、TCPでも、HTTPのボディでも同じ。
実装は `tools/device/common/wt_proto.py`。

### 4-1. 母艦 → 子機

| `t` | 形 | 意味 |
|---|---|---|
| `persona` | `{"t":"persona","d":{最小形}}` | 人格を入れ替える。すぐ効く |
| `event` | `{"t":"event","e":"greet"}` / `{"e":"approach","dist":2.0}` / `{"e":"silence","sec":30}` | イベントを起こす |
| `ping` | `{"t":"ping"}` | 生きているか |
| `stop` | `{"t":"stop"}` | 全出力を安全な位置へ（腕を下ろし、体を正面、LED消灯） |
| `mode` | `{"t":"mode","auto":false}` | 自走（待機ループ）の入切 |

**最小形をそのまま1行貼っても人格として受け取る。** シリアルモニタから人が手で
差し替えられるようにするため（`wt_proto.decode()` が `{"v":1,...}` を `persona` に読み替える）。

### 4-2. 子機 → 母艦

| `t` | 形 | 意味 |
|---|---|---|
| `ok` | `{"t":"ok","persona":"5b0a7533","bytes":256}` | 人格を受け取った |
| `err` | `{"t":"err","m":"..."}` | 読めなかった。**動きは止めない**（前の人格のまま） |
| `pong` | `{"t":"pong","fw":"wt-pico/1.0","up":12345,"proto":"WTP/1"}` | 生きている |
| `act` | `{"t":"act","o":"servo","n":"arm","v":"wave 1/2","ms":12}` | 1つの動作。**記録の素** |
| `metric` | `{"t":"metric","e":"greet","first_ms":458,"total_ms":2392}` | イベントから最初に動くまで／全部終わるまで |
| `log` | `{"t":"log","m":"..."}` | 人が読む用 |

`first_ms` を機器が自分で測るのは、**人がストップウォッチで測ると100msは平気でずれる**から。
記録表の「応答までの時間」はこの値を使う。

### 4-3. 壊れた行

`decode()` は例外を投げずに `None` を返す。シリアルは本当に壊れる（起動時のノイズ、
抜けたケーブル）。ここで落ちると、原因が配線かコードか分からなくなる。

### 4-4. 母艦の HTTP

| メソッド・パス | 用途 |
|---|---|
| `GET /` | 操作盤（`console.html`） |
| `GET /persona/<slot>` | 子機が Wi-Fi で人格を取りに来る。**最小形だけを返す** |
| `GET /state` | 子機の生死・人格名・直近の記録 |
| `GET /compare` | 2体の差の判定（§6 の合格基準） |
| `POST /event` | `{"e":"greet","arg":null}` を**全子機へ同時送出** |
| `POST /push` | 人格を配り直す |
| `POST /stop` | 全子機を安全位置へ |

母艦は**認証を持たない**。同じ場所のLANでしか使わない前提で、
インターネットへ出す用途には作っていない（出すなら前段に認証を置くこと）。

---

## 5. イベントと分岐

実装は `wt_core.py`（Python）と `wt_core.h`（C++）。**両方が同じ答えを出すことを
`selftest.py` §3 が毎回確かめる。**

| イベント | 引数 | 使う値 | 分岐 |
|---|---|---|---|
| `idle` | — | idleVariance, energy, baselineSmile, blinkRatePerMin | 揺れ幅と周期、口の明るさ |
| `approach` | `dist`(m) | comfortableDistanceM, approachSpeedMps, independence, caution, `prefer_novel_options`, `confirm_before_change` | 寄る／待つ／下がる |
| `greet` | — | responseDelayMs, gestureRate, gazeHoldMs, baselineSmile, cheerfulness, `keep_light_and_playful` | 間の取り方、身振りの回数 |
| `change` | — | `confirm_before_change`, `prefer_novel_options` | 確かめる／乗る／ふつうに受ける |
| `silence` | `sec` | energy, curiosity, caution, `take_initiative`, `follow_the_lead` | 自分から切り出す／待つ／ちらと見る |

### 5-1. 揺らぎを入れない

同じ人格・同じイベントなら、**いつでも同じ手順**が出ること。乱数で自然さを足したくなるが、
入れた瞬間に「差が人格から来ている」ことを測れなくなる。
自然さは展示用の別の層でやる（この機械の仕事ではない）。

### 5-2. 間引き

`approach` は、距離が 0.3m 以上変わったか、前回から5秒空いたときだけ発火する。
間引かないと、人が前に立っている限り撃ち続け、`silence` が永遠に来ない。

---

## 6. 合格の基準（`wt_core.compare`）

| 項目 | 基準 |
|---|---|
| 返すまでの間 | 1.5倍以上ちがう |
| 身振りの回数 | `gestureRate/25` の値がちがう |
| 近づく判断 | `approach` の手順がちがう |
| 方針コード | 互いに、相手に無いコードを1つ以上持つ |
| 手順 | 5イベント中3つ以上で手順がちがう |

5つすべてで `pass: true`。1つでも欠けたら不合格として扱い、
**機械ではなく比べた2体を疑う**（育ちが浅い／性格が近すぎる）。

---

## 7. 安全側の決まり

| 決まり | 理由 |
|---|---|
| 持ち主トークンを子機へ渡さない。ファームに置き場所を作らない | 機器は人の手に渡る。渡った先で分身が乗っ取られる |
| 人格カードそのものを子機へ渡さない | 持ち主の生活が書いてある |
| `v != 1` の最小形は読み込まない | 並びが変わったのに古いファームが動くと、別の意味の数値で動く |
| `err` を返しても動きは止めない | 展示の最中に人格が読めなくても、前の人格で動き続ける方がよい |
| `stop` で腕を下ろし、体を正面、LED消灯 | サーボが端に張り付いたまま発熱するのを避ける |
| サーボの電源は別系統、GNDのみ共通 | 電圧降下で再起動する。Pi では SD カードが壊れることがある |
| 母艦の記録に会話は入らない | 記録するのは動作と時間だけ（`act` / `metric`） |

---

## 8. 版

| 版 | 変えたもの |
|---|---|
| compact v1 | 現行。`m`/`p`/`e`/`t`/`c` の並び（`contract.json`） |
| WTP/1 | 現行。§4 の行プロトコル |
| wt-core/1.0 | 現行。§5 のイベントと分岐 |

**並びを変えるときは `contract.json` の `version` を上げる。**
上げると古いファームは読み込みを拒否する（黙って別の値で動くより、動かない方がよい）。
