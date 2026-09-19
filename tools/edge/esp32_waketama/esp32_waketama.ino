/*
  わけたま — ESP32 で人格データを動かす最小のスケッチ。

  何を確かめるためのものか:
    ESP32にはLLMは載らない。載せる必要も無い、というのがこの実装の主張で、
    「人格 → 振る舞い」の翻訳はサーバ側（src/persona/avatarProfile.ts）で済ませてあるので、
    機器は数百バイトの数値を読んで動くだけでよい。
    **ネットワークが落ちても、この子らしさは消えない。**

  必要なもの:
    - ESP32 開発ボード（ESP32-WROOM-32 など）
    - サーボ 1個（GPIO 13）、LED 1個（GPIO 2。多くのボードは内蔵LED）
    - ライブラリ: ArduinoJson (v6 以降), ESP32Servo

  人格の入れ方（2通り）:
    A) 下の PERSONA_JSON に、tools/edge/make_compact.mjs の出力をそのまま貼る（オフライン）
    B) シリアルモニタに persona.min.json の1行を貼り付ける（差し替えを試すとき）

  注意:
    ここに貼るJSONには会話も覚え書きも属性も入っていない（make_compact.mjs が確認する）。
    人格カードそのものを機器へ焼かないこと。あれは持ち主の生活が書かれたファイル。
*/

#include <ArduinoJson.h>
#include <ESP32Servo.h>

static const int PIN_SERVO = 13;
static const int PIN_LED = 2;

// tools/edge/make_compact.mjs の出力をそのまま貼る
static const char *PERSONA_JSON =
    "{\"v\":1,\"id\":\"sample\",\"n\":\"さきがけ\",\"m\":[82,66,90,410,1080,59],"
    "\"p\":[1.3,0.7],\"e\":[66,16],\"t\":[50,90,82,20,50,50],"
    "\"c\":[\"prefer_novel_options\",\"tolerate_open_plans\"]}";

struct Persona {
  int energy, gestureRate, idleVariance, responseDelayMs, gazeHoldMs, posture;
  float distanceM, approachMps;
  int smile, blinkPerMin;
  int warmth, curiosity, cheerfulness, caution, independence, humor;
  bool preferNovel, confirmBeforeChange, keepLight;
} persona;

Servo bodyServo;

static bool hasCode(JsonArray codes, const char *code) {
  for (JsonVariant v : codes) {
    if (strcmp(v.as<const char *>(), code) == 0) return true;
  }
  return false;
}

static bool loadPersona(const char *json) {
  // 最小形は数百バイトなので、静的な確保で足りる（ヒープを断片化させない）
  StaticJsonDocument<768> doc;
  if (deserializeJson(doc, json)) return false;
  if (doc["v"].as<int>() != 1) return false;  // 形式が変わったら動かさない

  JsonArray m = doc["m"], p = doc["p"], e = doc["e"], t = doc["t"];
  persona.energy = m[0];
  persona.gestureRate = m[1];
  persona.idleVariance = m[2];
  persona.responseDelayMs = m[3];
  persona.gazeHoldMs = m[4];
  persona.posture = m[5];
  persona.distanceM = p[0];
  persona.approachMps = p[1];
  persona.smile = e[0];
  persona.blinkPerMin = e[1];
  persona.warmth = t[0];
  persona.curiosity = t[1];
  persona.cheerfulness = t[2];
  persona.caution = t[3];
  persona.independence = t[4];
  persona.humor = t[5];

  JsonArray codes = doc["c"];
  persona.preferNovel = hasCode(codes, "prefer_novel_options");
  persona.confirmBeforeChange = hasCode(codes, "confirm_before_change");
  persona.keepLight = hasCode(codes, "keep_light_and_playful");

  Serial.printf("人格を読み込みました: %s\n", doc["n"].as<const char *>());
  return true;
}

/** 待機。ここが一番「その子らしさ」が出るので、置物にしない。 */
static void idleBreath() {
  int amplitude = persona.idleVariance * 12 / 100;  // 度
  int period = 4000 - persona.energy * 20;          // ミリ秒
  int center = 90 - (50 - persona.posture) / 4;     // 縮こまっている子は少し前傾

  bodyServo.write(center + amplitude);
  analogWrite(PIN_LED, persona.smile * 255 / 100);
  delay(period / 2);
  bodyServo.write(center - amplitude);
  delay(period / 2);
}

/** 話しかけられたときの反応。間の取り方と身振りの量に差が出る。 */
static void greet() {
  delay(persona.responseDelayMs);  // 慎重な子ほど、ここが長い
  int gestures = persona.gestureRate / 25;
  for (int i = 0; i < gestures; i++) {
    bodyServo.write(120);
    delay(180);
    bodyServo.write(60);
    delay(180);
  }
  bodyServo.write(90);
  analogWrite(PIN_LED, 255);
  delay(persona.gazeHoldMs);
  analogWrite(PIN_LED, persona.smile * 255 / 100);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_LED, OUTPUT);
  bodyServo.attach(PIN_SERVO);

  if (!loadPersona(PERSONA_JSON)) {
    Serial.println("人格を読み込めませんでした。PERSONA_JSON を確認してください");
  }
  Serial.println("シリアルに persona.min.json の1行を貼ると差し替えできます");
  greet();
}

void loop() {
  // 差し替え: シリアルから1行のJSONを受け取る
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() > 2 && loadPersona(line.c_str())) greet();
  }
  idleBreath();
}
