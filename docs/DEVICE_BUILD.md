# わけたま検証機 — 作り方と検証の手順

最終更新: 2026-09-20

先に読むもの: [DEVICE_DESIGN.md](DEVICE_DESIGN.md)（何を証明する機械か）・
[DEVICE_SPEC.md](DEVICE_SPEC.md)（決まりごと）

この文書は**手を動かす順番**だけを書く。上から順にやれば動く。

---

## 0. まず、機材を買う前に

機材が1つも無くても、ここまでは今すぐできる。

```bash
npm run device:selftest     # 7項目の自己点検。全部 [ok] になること
npm run device:demo         # 見本の2体を、画面の上で動かして差を見る
```

`device:demo` は同じPCの上に子機を2つ立てて、操作盤（http://localhost:8770/）を出す。
ボタンを押すと**2体へ同時に**イベントが飛び、手順の違いと「返すまでの間」が並ぶ。
ここで差が見えないなら、機材を買っても見えない。

---

## 1. 買う

[DEVICE_DESIGN.md §4](DEVICE_DESIGN.md) の部品表。最初の1台なら WT-1（Pico）だけでよい（約4,500円）。

**削ってはいけないもの**: サーボ用の 5V 2A 電源、470µF、ECHO の分圧抵抗（10k/20k）。
ここを省くと「動き出した瞬間に再起動する」「測距だけ動かない」で半日溶ける。

---

## 2. 人格を2体用意する

差を見る機械なので、**性格の違う2体**が要る。会話35回（おしゃべり期）以上の子で。

```bash
# 母艦（または手元のPC）で。トークンは環境変数に入れる。引数で渡さない（履歴に残る）
export WAKETAMA_TOKEN_A='...'   # /chat の localStorage sodatsukake_token_<cid>
export WAKETAMA_TOKEN_B='...'

python3 tools/device/pi/wt_hub.py fetch --cid <CID_A> --slot a --token-env WAKETAMA_TOKEN_A
python3 tools/device/pi/wt_hub.py fetch --cid <CID_B> --slot b --token-env WAKETAMA_TOKEN_B

# 比べる価値のある2体かどうかを先に見る
python3 tools/device/pi/wt_hub.py compare
```

`compare` が不合格なら、**機材を触る前に別の2体を選ぶ**。
出力は `tools/device/pi/personas/{a,b}.min.json`（数百バイト）。
中身を開いて、会話や覚え書きが入っていないことを自分の目でも一度見ておくとよい。

> 育った分身がまだ無ければ、見本（`tools/device/samples/`）で全部通せる。
> 見本は性格が逆の2体で、合格基準を満たすことを確認済み。

---

## 3. 組む

配線図は機種ごとに用意してある。**ピン番号は図が正**（ファームの定数も同じ場所から生成している）。

| 機種 | 図 |
|---|---|
| WT-1 Pico | [device/wt1_pico_wiring.svg](device/wt1_pico_wiring.svg) |
| WT-2 ESP32 | [device/wt2_esp32_wiring.svg](device/wt2_esp32_wiring.svg) |
| WT-3 Pi | [device/wt3_pi_wiring.svg](device/wt3_pi_wiring.svg) |

順番は、**電源 → GND → 信号 → 最後に基板へ給電**。逆にやると、繋いでいる途中で動く。

1. ブレッドボードの電源レールに、5V 2A のACアダプタを繋ぐ（DCジャック→端子台）
2. **基板の GND と、電源レールの GND を繋ぐ**（ここを忘れるとサーボが痙攣する）
3. 470µF を電源レールに1本（**足の向きに注意**。長い足が＋）
4. サーボ2個: 赤→5Vレール、茶→GNDレール、橙→図のピン
5. LED 2個: 足の長い方→図のピン、短い方→330Ω→GND
6. タクトスイッチ: 片側→図のピン、もう片側→GND（プルアップは石の内蔵を使う）
7. HC-SR04: VCC→5V、GND→GND、TRIG→図のピン、**ECHO→10kΩ→図のピン、そこから20kΩ→GND**
8. 最後に、基板へ USB を挿す

組んだら、**基板を挿す前に電源レールの電圧をテスターで確認**（5.0V前後）。

---

## 4. 焼く

### 4-1. WT-1（Pico 2 W / MicroPython）

```bash
# MicroPython を入れた Pico に、5つのファイルを置く
mpremote cp tools/device/common/wt_core.py    :wt_core.py
mpremote cp tools/device/common/wt_proto.py   :wt_proto.py
mpremote cp tools/device/common/wt_actuate.py :wt_actuate.py
mpremote cp tools/device/pico/wt_pins.py      :wt_pins.py
mpremote cp tools/device/pico/main.py         :main.py
mpremote cp tools/device/pi/personas/a.min.json :persona.min.json
mpremote reset
```

シリアル（115200）を開くと `{"t":"log","m":"wt-pico/1.0 起動（WTP/1）"}` が出る。

### 4-2. WT-2（ESP32 / Arduino）

1. Arduino IDE に ESP32 ボードを追加
2. ライブラリ: **ArduinoJson (v6)** と **ESP32Servo**
3. `tools/device/esp32/wt_device/` を開く（`.ino` と `wt_core.h` と `wt_pins.h` が同じ階層に要る）
4. `PERSONA_JSON` に `a.min.json` の中身を1行で貼る
5. Wi-Fi で母艦から受け取るなら `WIFI_SSID` / `WIFI_PASS` / `HUB`（例 `192.168.1.20:8770`）/ `SLOT` を埋める
6. 書き込み → シリアルモニタ 115200

### 4-3. WT-3（Pi Zero 2 W / Pi 4）

```bash
sudo apt install -y python3-gpiozero pigpio python3-pigpio
sudo systemctl enable --now pigpiod          # サーボのガタつきが消える

scp -r tools/device pi@raspberrypi.local:~/wt
ssh pi@raspberrypi.local
GPIOZERO_PIN_FACTORY=pigpio python3 ~/wt/device/pi/wt_node.py --persona ~/wt/device/samples/bold.min.json
```

---

## 5. 通す

### 5-1. 1台で（差し替えが効くこと）

シリアルモニタに、**もう1体の最小形を1行貼る**。同じ配線・同じファームのまま、
待機の揺れ幅と、話しかけたときの間が変わる。

**これが一番わかりやすい見どころ。** 撮るならここ。

### 5-2. 2台同時で（本番）

```bash
# 母艦。子機をUSBで繋いでいる場合
python3 tools/device/pi/wt_hub.py serve --port 8770 \
    --serial a=/dev/ttyACM0 --serial b=/dev/ttyUSB0
```

ブラウザで `http://<母艦のIP>:8770/` を開く。

1. 「話しかける」を押す → **2体が同時に反応し、動き出すまでの間が違う**
2. 「近づく (2.0m)」→ 片方は寄り、片方は待つ
3. 「黙る (30秒)」→ 片方が自分から切り出す
4. 画面下の「判定」が全部 **合格** になっていること
5. 記録は `tools/device/pi/runs/<日時>.csv` に落ちている

### 5-3. ネットを切る

```bash
sudo nmcli radio wifi off      # 母艦の Wi-Fi を切る
```

USBシリアルで繋がっている子機は、そのまま動き続ける。
Pico と ESP32 は母艦を落としても単体で動く（人格は本体に入っている）。
**ここまで通れば「クラウドが無くても、この子はこの子として動く」と言える。**

---

## 6. 記録する

`runs/<日時>.csv` に動作と時間が全部入っている。報告に使うのは次の表。
数字は CSV から拾う（手で測らない）。

| 項目 | どこから |
|---|---|
| 日付 / 担当 | |
| 機種 / RAM / 電源 | |
| 人格の `id`（最小形の `id`） | `personas/*.min.json` |
| 最小形のバイト数 | `fetch` の出力 |
| 返すまでの間（2体ぶん） | CSV の `metric` 行 `first_ms` |
| 1イベントの所要（2体ぶん） | CSV の `metric` 行 `total_ms` |
| 合格した項目 / 落ちた項目 | 操作盤の「判定」 |
| 連続稼働（時間） / 発熱（℃） | `vcgencmd measure_temp`（Pi） |
| 代用したもの | CSV に `drive(...)→lean` が出ていれば、そう書く |
| 気づいたこと | |

段階B（言葉）まで見るなら [EDGE_DEVICE_TEST.md §4](EDGE_DEVICE_TEST.md) へ。

---

## 7. つまずきやすいところ

| 症状 | 原因 | 対処 |
|---|---|---|
| 動き出した瞬間に再起動する | サーボの電流を基板から取っている | 別電源にする。470µF を入れる |
| サーボが小刻みに震え続ける | GND が共通になっていない／ソフトPWM | GND を繋ぐ。Pi は pigpio を使う |
| ESP32 に書き込めない | 起動時に見ているピン（0,2,5,12,15）を使った | `pinmap.json` のピンに戻す。`npm run device:selftest` が検出する |
| 測距だけ効かない | ECHO を直結した（5V） | 10k/20k で分圧する。石が壊れていないか確認 |
| `{"t":"err","m":"人格を読めません"}` | 最小形が壊れている／`v` が 1 でない | `wt_hub.py fetch` を取り直す |
| 2体を並べても差が出ない | 育ちが浅い／性格が近い | `wt_hub.py compare` で先に選ぶ。35回以上の子で |
| ESP32 だけ動きが違う | C++ 版の写し間違い | `npm run device:selftest` の §3。ここが落ちているはず |
| 図のピンとファームが違う | どちらかを手で書き換えた | `npm run device:docs` で作り直す。ピンは `pinmap.json` が唯一の出所 |
| 母艦が子機を見つけない | `/dev/tty*` の名前が違う | `ls /dev/tty*` で確認。Pico は `ACM`、ESP32 は `USB` が多い |
| `ModuleNotFoundError: serial` | pyserial が無い | `pip3 install pyserial` |

---

## 8. 片付け

- `stop` を押してから電源を抜く（サーボが端で張り付いたまま発熱するのを避ける）
- `personas/` と `runs/` は git に入らない（`.gitignore` 済み）。**最小形にも人格の癖は残るので、配らない**
- 展示で使った分身のトークンは、母艦から消す（`unset WAKETAMA_TOKEN_A`、履歴も）
