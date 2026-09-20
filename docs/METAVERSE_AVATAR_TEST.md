# メタバースのアバターでも検証する — アバター実験室

最終更新: 2026-09-20

関連: [DEVICE_DESIGN.md](DEVICE_DESIGN.md)（実機の設計）・[EDGE_DEVICE_TEST.md](EDGE_DEVICE_TEST.md)（段階A/B/C）・
[TEXT_TO_BEHAVIOR.md](TEXT_TO_BEHAVIOR.md)（会話→動きの理屈）・[SALES_DELIVERY.md](SALES_DELIVERY.md)（アバターも買い手の一つ）

---

## 0. この文書が答えること

**「サーボやLEDの実機だけでなく、メタバースの3Dアバターでも同じ人格が動くと言えるのか」**を、
自分の手で確かめるための道具と手順。

答えは「言える」。理由は単純で、DEVICE_DESIGN.md の検証機がもともと**体を選ばない設計**に
なっているため。エンジン（`wt_core`）は「サーボを何度回すか」を知らず、
「近づく／笑う／身振りをする」という**抽象的な指示**だけを出す。それを実際の角度や色に
落とす層（`wt_actuate`）だけを載せ替えれば、体が変わっても人格は乗る。

物理の検証機（Pico / ESP32 / Pi）が「サーボ・LED版」だとすれば、
このアバター実験室は**同じ規則の「Three.js版」**。ブラウザだけで動き、追加の部品は要らない。

---

## 1. なぜ同じエンジンのままアバターに載せられるか

DEVICE_DESIGN.md §2 で決めた境界は、体が実機でも仮想でも変わらない。

```
わけたま（Cloudflare）
   │  人格カード（会話・覚え書き・属性を含む）
   ▼
母艦（操作する人のPC）                  ← ★ ここまで
   │  wt_compact.py（or compact.mjs） … 数値と方針コードだけの約250バイトへ
   ▼
実行層（Pico / ESP32 / Pi / ブラウザ）  ← ★ ここから先は数値しかない
```

アバターに渡すのも、実機とまったく同じ**約250バイトの最小形**（9個の数値＋方針コード）。
人格カードの実物や、それを取り出すための操作（token・API呼び出し）はブラウザ側に一切持ち込まない。
実験室で読み込むのは、あらかじめ書き出しておいた `.min.json`（見本は `tools/device/samples/`）だけ。

エンジン本体（`wt_core`）は4つの言語に写してあり、**どれも同じ規則**であることを機械で確かめている
（DEVICE_DESIGN.md §6）。今回、その並びに5つ目の写しを足した。

| # | 言語 | 場所 | 載る先 |
|---|---|---|---|
| 1 | Python | `tools/device/common/wt_core.py` | 母艦・PC上の確認（正） |
| 2 | Python（簡易版） | `tools/edge/rule_runtime.py` | 参照実装 |
| 3 | C++ | `tools/device/esp32/wt_device/wt_core.h` | WT-2（ESP32） |
| **4** | **JavaScript** | **`tools/device/web/wt_core.mjs`** | **このアバター実験室** |

規則そのもの（イベントの分岐、`compare()` の5基準）は一字一句 Python 版の写し。
**動きの意味を1つも変えていない**——変えたのは「その指示をどう見せるか」という実行層だけ。

---

## 2. Driverをすべて非同期にした（唯一のコード上の違い）

物理版（`wt_actuate.py`）は、サーボへの命令もスリープも**その場で止まる同期呼び出し**でよい。
1個のマイコンが順番に1つずつ実行するだけだから。

ブラウザはそうはいかない。腕を振る・体を傾けるといった動きは、
`setTimeout` を挟んだ**時間のかかる非同期処理**として書くしかない。
ここで、待ち（`wait`）だけを非同期にして残りを同期のままにすると、こうなる：

```js
// もし servo() を待たずに呼ぶと…
for (const i of gestures) d.servo("arm", `wave ${i}/${n}`); // 全部ほぼ同時に発火してしまう
```

`onGreet` は身振りの回数だけ `servo("arm", ...)` を連続で呼ぶ。物理版はサーボの動作が
ブロッキングなので自然に1回ずつ順番になるが、アバター側で `servo()` を待たずに呼ぶと、
アニメーションが全部重なって同時に始まり、**「2回振る」と「1回振る」の違いが画面に出ない**。

そこで `web/wt_core.mjs` では、`Driver.servo()` / `Driver.led()` / `Driver.wait()` の
**3つすべてを `Promise<void> | void` を返せる形にし、エンジン側の呼び出しをすべて `await` 付き**にした。

- テスト用の `Collector`（アクション列を記録するだけ）は今まで通り同期メソッドのまま
  — `await` は non-Promise を返しても素通りするだけなので、記録される手順は変わらない
- 実ブラウザ用の `AvatarDriver` は `servo()`/`led()` の内部でアニメーションを `await` し切る
  — これで「1個の動きが終わってから次の指示が来る」という、物理版と同じ順序が保証される

この変更をしても Python 版との一致が崩れていないことは、
`python3 tools/device/selftest.py` の新しい §4（次項）が確かめている。

---

## 3. 9個の数値 → 3Dアバターの動き

DEVICE_DESIGN.md §3-1（サーボ・LED版の割り当て）と対になる、アバター版の割り当て。
数値の意味そのものは変えず、**受け取り側（`tools/device/web/wt_avatar.mjs`）だけを差し替えている**。

| 数値 | 物理版（サーボ・LED） | アバター版（Three.js） |
|---|---|---|
| `energy` | 待機の周期（サーボ） | 待機の周期（体の揺れ、同じ式） |
| `gestureRate` | 手を振る回数（腕サーボ） | 同じ回数だけ腕ノードを振る |
| `idleVariance` | 待機の揺れ幅（角度） | torsoの回転角として同じ幅 |
| `responseDelayMs` | 話しかけてから動くまで | 同じmsだけ`await`してから動く |
| `gazeHoldMs` | 目のLEDが点いている長さ | 目ノードの発光を同じ時間だけ保つ |
| `postureOpenness` | 体サーボの中心角 | （現状は姿勢の基準角には未使用。§7参照） |
| `comfortableDistanceM` | 寄るか下がるかの境目 | 同じ境目で「近づく／待つ」を判断 |
| `approachSpeedMps` | **前傾の深さで代用**（車輪が無い） | **実際に踏み出す距離**（`torso.position.z`） |
| `baselineSmile` | 口のLEDの明るさ | 口ノードの発光・色で同じ％を表す |
| `blinkRatePerMin` | 待機1周の長さ | 同じ式で待機1周の長さ |

### 3-1. 物理版との意図的な違い（劣化ではなく利点として書く）

- **`drive`（近づく／下がる）が本物の移動になる。** 物理版は車輪が無いので前傾で代用し、
  「代用した」とログに残す設計にした（DEVICE_DESIGN.md §3）。アバターには車輪の制約が無いので、
  `torso.position.z` を実際に動かす。**「代用しなくて済む」こと自体が、仮想空間へ持ち出す利点の実例**になっている
- **`head`（nod/shake/tilt/turn/face）が専用の関節を持つ。** 物理版は配線1本（体サーボ共用）で
  頭と体を兼ねているが、アバターには頭ノードが独立してあるので、そのまま別ノードに割り当てられる
- **表現の粒度が細かい。** 物理版はLED2個（口・目）だが、アバターは発光の強さ・色・トーラス形状の
  変化まで使える。ただし**判定基準（§4）は物理版と同じ5項目のまま**——表現が豊かでも、
  判定を甘くする理由にはしていない

---

## 4. 動かし方

```bash
npm run device:avatar
# = python3 -m http.server 8780 --directory tools/device
```

ブラウザで `http://localhost:8780/web/avatar-lab.html` を開く。

追加の部品もインストールも不要。Three.js は `tools/device/web/vendor/` に同梱してあり、
CDNには出ない（ライセンスは同フォルダの `THREE_LICENSE.txt`）。オフラインの現場でも動く。

開くと自動で見本の2体（`bold.min.json` / `careful.min.json`）が両方の枠に読み込まれ、
判定パネルに5項目の結果が出る。

| できること | やり方 |
|---|---|
| イベントを2体へ同時に送る | 「話しかける」「近づく」などのボタン |
| 差の自動判定を見る | 下の「判定」カード。5項目とも `wt_core.compare()` の結果そのもの |
| 手順の記録を見る | 「動いた記録」の表。物理版の `console.html` と同じ形式 |
| 自分の人格を試す | 枠のテキストエリアに `.min.json` を貼って「この人格を読み込む」 |
| 倍速で見る | 「速度」セレクタ（既定は4倍速のデモ用） |

`file://` で直接開くと人格の読み込み（`fetch`）がブラウザにブロックされるため、
必ず簡易サーバ経由で開くこと。

---

## 5. Python版との一致を機械で確かめる

`tools/device/selftest.py` に、物理版（C++）と同じ枠組みで**JS版の突き合わせ**を追加した。

```bash
npm run device:selftest
```

```
4. wt_core.py ↔ web/wt_core.mjs（JS・メタバースのアバター）
  [ok]   5イベント×2体すべて一致
  [ok]   compare() の判定が一致 5項目とも同じ真偽値
```

やっていることは C++ 版の突き合わせ（DEVICE_DESIGN.md §6 の3番目）と同じ発想：

1. 見本の2体それぞれに、5イベント（idle/approach/greet/change/silence）を投げる
2. `node tools/device/webcheck.mjs <person.json> <event> [arg]` で JS版の出力（servo/led/waitの列）を取り、
   Python版の `wt_core.plan()` の出力と1個ずつ突き合わせる
3. `node tools/device/webcheck.mjs compare a.json b.json` で JS版の `compare()` 判定を取り、
   Python版の判定（5項目の真偽値）と突き合わせる

**人の目で見比べるのはここでも諦めている。** C++版と同じ理由——同じ規則を複数の言語で
書く以上、ずれに気づけるのは機械だけ。

---

## 6. この作りの限界（先に書く）

- **顔・体は既製モデルではなくプリミティブ（球・カプセル・トーラス）。** 見た目の作り込みで
  「人格が動いている」ことがぼやけないよう、あえて最小限にしてある。VRM等の凝ったモデルに
  差し替える場合も、割り当てる先（§3の表）は変わらない
- **`postureOpenness` を姿勢の基準角として使っていない。** 物理版はサーボの中心角に使うが、
  アバター版はまだ待機の揺れにしか反映していない。表情豊かなアバターへ広げるときの伸びしろ
- **物理演算・衝突が無い。** 実際に歩く・ぶつかる判定はしていない。§1の境界の話と同じ理由で、
  この実験室は「人格の差が動きの差になるか」だけを見る道具にしてある
- **1本の腕・1個の関節構成。** 物理版に合わせて最小限にしてあるため、より多い自由度
  （両腕・脚・表情筋）を使う実際のメタバース向けアバターへ広げるには、§3の割り当てを増やす必要がある

これらは隠さずに相手へ伝えること。TEXT_TO_BEHAVIOR.md §8 と同じ姿勢。

---

## 7. 新しいアバター／リグへ載せる手順

DEVICE_DESIGN.md や TEXT_TO_BEHAVIOR.md §7（新しいロボットへ載せる手順）と同じ考え方。

1. そのアバターで**変えられるもの**を洗い出す（関節・発光・移動・カメラ演出等）
2. §3 の9個を、それぞれに割り当てる（0〜100 をアバターの可動域へ線形に写すだけでよい）
3. `wt_core.mjs` が出すイベントのうち、そのアバターに起きるものだけを実装する
   （`AvatarDriver` を参考に、`Driver` を継承して `servo`/`led`/`wait` を実装するだけでよい）
4. **性格が逆の2体で動かして、差が目で分かるか**を確かめる（`avatar-lab.html` がそのまま使える）
5. 差が出ないなら、割り当てた範囲が狭すぎる。可動域いっぱいまで使う

規則そのもの（`wt_core.mjs`）には触らない。触っていいのは実行層（`AvatarDriver` 相当）だけ
——ここを守らないと、C++版・Python版との一致が崩れ、`npm run device:selftest` が落ちる。

---

## 8. ファイルの場所

| 目的 | 場所 |
|---|---|
| 振る舞いエンジン（JS。Python版の1:1移植） | `tools/device/web/wt_core.mjs` |
| 指示→3D変形の割り当て（Three.js） | `tools/device/web/wt_avatar.mjs` |
| ブラウザの実験室（操作盤） | `tools/device/web/avatar-lab.html` |
| Three.js 同梱（CDN不要） | `tools/device/web/vendor/three.module.min.js` |
| Node からJS版を叩くCLI（selftest用） | `tools/device/webcheck.mjs` |
| 自己点検（JS版の突き合わせを含む） | `tools/device/selftest.py`（`npm run device:selftest`） |
| 見本の人格2体（実機と共用） | `tools/device/samples/` |
| 起動コマンド | `npm run device:avatar` |
