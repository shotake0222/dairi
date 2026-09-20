/*
  わけたま検証機 WT-2「ふたば」 — ESP32-WROOM-32 用ファーム

  WT-1（Pico）との違いは Wi-Fi があること。**それだけ。**
  振る舞いの規則は wt_core.h（＝ tools/device/common/wt_core.py と同じもの）で、
  ネットが落ちても消えない。落ちて消えるなら、それは人格ではなく通信の話。

  Wi-Fi は2つのことにしか使わない:
    1. 母艦（WT-4）から人格の最小形を取りに行く（GET /persona/<slot>）
    2. 動いた記録を母艦へ流す（POST /act）
  **トークンも、人格カードそのものも、この機器には入れない。**
  入れてよいのは数百バイトの最小形だけ（docs/DEVICE_SPEC.md §6）。

  必要なもの:
    - ライブラリ: ArduinoJson (v6), ESP32Servo
    - ボード: ESP32 Dev Module / 115200 bps
    - 配線: docs/device/wt2_esp32_wiring.svg（ピンは wt_pins.h。手で書き換えないこと）

  人格の入れ替え: シリアルモニタに最小形のJSONを1行貼る。
  同じ配線・同じファームのまま別の子になる。
*/

#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <ctype.h>
#include <stdlib.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include "wt_core.h"
#include "wt_pins.h"

// --- ここだけ現場で書き換える -------------------------------------------------
static const char *WIFI_SSID = "";      // 空なら Wi-Fi を使わない（単体で動く）
static const char *WIFI_PASS = "";
static const char *HUB = "";            // 例 "192.168.1.20:8770"。空なら取りに行かない
static const char *SLOT = "a";          // 母艦から見たこの機体の名前（a / b）

// 単体で動かすとき用。tools/device/common/wt_compact.py の出力をそのまま貼る
static const char *PERSONA_JSON =
    "{\"v\":1,\"id\":\"sample\",\"n\":\"さきがけ\",\"m\":[77,73,85,458,1212,65],"
    "\"p\":[1.3,0.7],\"e\":[65,17],\"t\":[55,88,74,26,84,66],"
    "\"c\":[\"prefer_novel_options\",\"take_initiative\",\"prioritize_enjoyment\"]}";

static const int ARM_HOME = 90, ARM_UP = 130, ARM_DOWN = 55;
static const int BODY_HOME = 90, LEAN_FORWARD = 18, LEAN_BACK = 14;
static const int GESTURE_HALF_MS = 180;
static const unsigned long SILENCE_AFTER_MS = 20000;
static const unsigned long SONAR_EVERY_MS = 700;

// --- 状態 ---------------------------------------------------------------------

WtPersona persona;
bool personaReady = false;
Servo bodyServo, armServo;
int bodyCenter = BODY_HOME;
unsigned long lastTouch = 0, lastSonar = 0, lastApproach = 0, eventStart = 0;
long firstActMs = -1;
float prevDist = -1;
bool silenced = false, autoIdle = true, wasPressed = false;

// --- 出力の口 -----------------------------------------------------------------

static void setLed(int pin, int percent) {
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  analogWrite(pin, percent * 255 / 100);
}

static void setServo(Servo &s, int deg) {
  if (deg < 0) deg = 0;
  if (deg > 180) deg = 180;
  s.write(deg);
}

/** 数字を1つ取り出す（"hold 1080ms" → 1080）。 */
static float firstNumber(const char *text, float fallback) {
  const char *p = text;
  while (*p && !isdigit((unsigned char)*p)) p++;
  if (!*p) return fallback;
  return atof(p);
}

static void emitAct(const char *kind, const char *name, const char *value) {
  if (firstActMs < 0 && (strcmp(kind, "servo") == 0 || strcmp(kind, "led") == 0)) {
    firstActMs = (long)(millis() - eventStart);
  }
  StaticJsonDocument<192> doc;
  doc["t"] = "act";
  doc["o"] = kind;
  doc["n"] = name;
  doc["v"] = value;
  doc["ms"] = (unsigned long)(millis() - eventStart);
  serializeJson(doc, Serial);
  Serial.println();
}

/** wt_core の指示を、この機体の2サーボ・2LEDへ割り当てる（wt_actuate.py と同じ割り当て）。 */
struct RigDriver : public WtDriver {
  void servo(const char *name, const char *value) override {
    emitAct("servo", name, value);
    if (strcmp(name, "arm") == 0) {
      setServo(armServo, ARM_UP);
      delay(GESTURE_HALF_MS);
      setServo(armServo, ARM_DOWN);
      delay(GESTURE_HALF_MS);
      setServo(armServo, ARM_HOME);
    } else if (strcmp(name, "body_sway") == 0) {
      int amp = (int)firstNumber(value, 4);
      const char *slash = strchr(value, '/');
      int period = slash ? (int)firstNumber(slash, 2400) : 2400;
      int half = period / 2 < 60 ? 60 : period / 2;
      setServo(bodyServo, bodyCenter + amp);
      delay(half);
      setServo(bodyServo, bodyCenter - amp);
      delay(half);
    } else if (strcmp(name, "drive") == 0) {
      // 車輪は無いので前傾／後傾で代用する（代用したことは act ログに残る）
      bool fwd = strncmp(value, "forward", 7) == 0;
      setServo(bodyServo, fwd ? bodyCenter - LEAN_FORWARD : bodyCenter + LEAN_BACK);
      delay(400);
      setServo(bodyServo, bodyCenter);
    } else if (strcmp(name, "head") == 0) {
      if (strncmp(value, "nod", 3) == 0) {
        int times = strstr(value, "fast") ? 2 : 1;
        int gap = strstr(value, "fast") ? 90 : 140;
        for (int i = 0; i < times; i++) {
          setServo(bodyServo, bodyCenter - 10);
          delay(gap);
          setServo(bodyServo, bodyCenter);
          delay(gap);
        }
      } else if (strncmp(value, "shake", 5) == 0) {
        int seq[4] = {-6, 6, -4, 0};
        for (int i = 0; i < 4; i++) {
          setServo(bodyServo, bodyCenter + seq[i]);
          delay(110);
        }
      } else if (strncmp(value, "tilt", 4) == 0 || strncmp(value, "turn", 4) == 0) {
        setServo(bodyServo, bodyCenter - 8);
        delay(200);
      } else {
        setServo(bodyServo, bodyCenter);
      }
    } else if (strcmp(name, "gaze") == 0) {
      if (strncmp(value, "glance", 6) == 0) {
        setLed(PIN_LED_EYE, 100);
        delay(160);
        setLed(PIN_LED_EYE, 0);
      } else {
        setLed(PIN_LED_EYE, 100);
        delay((int)firstNumber(value, 800));
        setLed(PIN_LED_EYE, 0);
      }
    } else if (strcmp(name, "body") == 0) {
      if (strncmp(value, "bounce", 6) == 0) {
        int seq[4] = {12, -8, 5, 0};
        for (int i = 0; i < 4; i++) {
          setServo(bodyServo, bodyCenter + seq[i]);
          delay(90);
        }
      } else {
        setServo(bodyServo, bodyCenter);
        delay(200);
      }
    }
  }

  void led(const char *name, const char *value) override {
    emitAct("led", name, value);
    int pct = (int)firstNumber(value, persona.smile);
    if (strcmp(name, "eye") == 0) {
      setLed(PIN_LED_EYE, pct);
    } else {
      setLed(PIN_LED_MOUTH, pct);
    }
  }

  void wait(int ms) override {
    emitAct("wait", "", "");
    delay(ms);
  }

  void note(const char *text) override { emitAct("note", "", text); }
};

RigDriver driver;

// --- 人格 ---------------------------------------------------------------------

static bool loadPersona(const char *json) {
  StaticJsonDocument<768> doc;  // 最小形は 512 バイト以下（contract.json の上限）
  if (deserializeJson(doc, json)) return false;
  if (doc["v"].as<int>() != WT_CONTRACT_VERSION) return false;  // 形式が変わったら動かさない

  JsonArray m = doc["m"], p = doc["p"], e = doc["e"], t = doc["t"];
  if (m.size() < 6 || p.size() < 2 || e.size() < 2 || t.size() < 6) return false;

  snprintf(persona.id, sizeof(persona.id), "%s", doc["id"] | "");
  snprintf(persona.name, sizeof(persona.name), "%s", doc["n"] | "");
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

  persona.policyCount = 0;
  for (JsonVariant v : doc["c"].as<JsonArray>()) {
    if (persona.policyCount >= WT_MAX_POLICIES) break;
    snprintf(persona.policies[persona.policyCount], WT_CODE_LEN, "%s", v.as<const char *>());
    persona.policyCount++;
  }

  bodyCenter = BODY_HOME - (50 - persona.posture) / 4;
  setServo(bodyServo, bodyCenter);
  setServo(armServo, ARM_HOME);
  setLed(PIN_LED_MOUTH, persona.smile);
  setLed(PIN_LED_EYE, 0);
  personaReady = true;

  StaticJsonDocument<128> ack;
  ack["t"] = "ok";
  ack["persona"] = persona.id;
  ack["bytes"] = (int)strlen(json);
  serializeJson(ack, Serial);
  Serial.println();
  return true;
}

static void fire(const char *event, double arg, bool hasArg) {
  if (!personaReady) return;
  eventStart = millis();
  firstActMs = -1;
  wtDispatch(persona, driver, event, arg, hasArg);

  StaticJsonDocument<160> doc;
  doc["t"] = "metric";
  doc["e"] = event;
  doc["first_ms"] = firstActMs < 0 ? 0 : firstActMs;
  doc["total_ms"] = (unsigned long)(millis() - eventStart);
  serializeJson(doc, Serial);
  Serial.println();

  lastTouch = millis();
  silenced = false;
}

// --- 入力 ---------------------------------------------------------------------

static float readDistanceM() {
  digitalWrite(PIN_SONAR_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_SONAR_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_SONAR_TRIG, LOW);
  unsigned long us = pulseIn(PIN_SONAR_ECHO, HIGH, 30000);
  if (us == 0) return -1;
  return (float)(us * 0.0343 / 2 / 100.0);
}

static void handleLine(const String &line) {
  StaticJsonDocument<768> doc;
  if (deserializeJson(doc, line)) return;
  const char *t = doc["t"] | "";
  if (doc["v"].as<int>() == WT_CONTRACT_VERSION && doc.containsKey("m")) {
    loadPersona(line.c_str());  // 最小形を素で貼られたとき
  } else if (strcmp(t, "persona") == 0) {
    String inner;
    serializeJson(doc["d"], inner);
    loadPersona(inner.c_str());
  } else if (strcmp(t, "event") == 0) {
    bool hasDist = doc.containsKey("dist");
    bool hasSec = doc.containsKey("sec");
    double arg = hasDist ? (double)(doc["dist"] | 0.0) : (double)(doc["sec"] | 0.0);
    fire(doc["e"] | "greet", arg, hasDist || hasSec);
  } else if (strcmp(t, "ping") == 0) {
    StaticJsonDocument<128> r;
    r["t"] = "pong";
    r["fw"] = "wt-esp32/1.0";
    r["up"] = millis();
    r["proto"] = "WTP/1";
    serializeJson(r, Serial);
    Serial.println();
  } else if (strcmp(t, "stop") == 0) {
    autoIdle = false;
    setServo(armServo, ARM_HOME);
    setServo(bodyServo, BODY_HOME);
    setLed(PIN_LED_MOUTH, 0);
    setLed(PIN_LED_EYE, 0);
  } else if (strcmp(t, "mode") == 0) {
    autoIdle = doc["auto"] | true;
  }
}

/** 母艦から最小形を取りに行く。失敗しても単体で動き続ける（それが要点）。 */
static void fetchPersona() {
  if (WiFi.status() != WL_CONNECTED || strlen(HUB) == 0) return;
  HTTPClient http;
  String url = String("http://") + HUB + "/persona/" + SLOT;
  http.begin(url);
  int code = http.GET();
  if (code == 200) loadPersona(http.getString().c_str());
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_LED_MOUTH, OUTPUT);
  pinMode(PIN_LED_EYE, OUTPUT);
  pinMode(PIN_LED_ALIVE, OUTPUT);
  pinMode(PIN_BTN_TALK, INPUT_PULLUP);
  pinMode(PIN_SONAR_TRIG, OUTPUT);
  pinMode(PIN_SONAR_ECHO, INPUT);
  bodyServo.attach(PIN_SERVO_BODY);
  armServo.attach(PIN_SERVO_ARM);

  if (strlen(WIFI_SSID) > 0) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  }

  if (!loadPersona(PERSONA_JSON)) Serial.println("{\"t\":\"err\",\"m\":\"PERSONA_JSON を読めません\"}");
  fetchPersona();
  lastTouch = millis();
  fire("greet", 0, false);
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() > 2) handleLine(line);
  }

  bool pressed = digitalRead(PIN_BTN_TALK) == LOW;
  if (pressed && !wasPressed) fire("greet", 0, false);
  wasPressed = pressed;

  if (millis() - lastSonar > SONAR_EVERY_MS) {
    lastSonar = millis();
    float d = readDistanceM();
    // 立っているだけで撃ち続けないよう、0.3m 動いたか5秒空いたときだけ
    bool news = (prevDist < 0 || fabs(d - prevDist) > 0.3) && (millis() - lastApproach > 5000);
    if (d > 0.05 && d < 4.0) {
      prevDist = d;
      if (news) {
        lastApproach = millis();
        fire("approach", d, true);
      }
    }
  }

  if (autoIdle && !silenced && millis() - lastTouch > SILENCE_AFTER_MS) {
    silenced = true;
    fire("silence", (millis() - lastTouch) / 1000.0, true);
  }

  digitalWrite(PIN_LED_ALIVE, (millis() / 1000) % 2);
  if (autoIdle && personaReady) wtOnIdle(persona, driver);
}
