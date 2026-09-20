// わけたま検証機 — 振る舞いエンジン（C++版）
//
// tools/device/common/wt_core.py を、そのまま C++ に写したもの。
// **2つの実装が同じ答えを出すことは機械で確かめている**
// （tools/device/selftest.py が、この1ファイルを g++ でホスト側にビルドして、
//   Python版と1文字単位で突き合わせる）。
// 写し間違いを人の目で探すのは無理なので、そこは任せない。
//
// Arduino に依存しない。ここには include も delay も無い。
// 実機で動かす側（wt_device.ino）が WtDriver を継承して出力を書く。
//
// 数値の書き方について:
//   Python の "%s" % round(x, 2) は 0.7 を "0.7"、1.0 を "1.0" と書く（末尾の0を落とす）。
//   printf("%.2f") だと "0.70" になって食い違うので、fmtShort() で合わせてある。

#ifndef WT_CORE_H
#define WT_CORE_H

#include <math.h>
#include <stdio.h>
#include <string.h>

#define WT_CORE_VERSION "wt-core/1.0"
#define WT_CONTRACT_VERSION 1
#define WT_MAX_POLICIES 8
#define WT_CODE_LEN 28

struct WtPersona {
  char id[9];
  char name[33];
  // m: energy, gestureRate, idleVariance, responseDelayMs, gazeHoldMs, postureOpenness
  int energy, gestureRate, idleVariance, responseDelayMs, gazeHoldMs, posture;
  // p: comfortableDistanceM, approachSpeedMps
  float distanceM, approachMps;
  // e: baselineSmile, blinkRatePerMin
  int smile, blinkPerMin;
  // t: warmth, curiosity, cheerfulness, caution, independence, humor
  int warmth, curiosity, cheerfulness, caution, independence, humor;
  char policies[WT_MAX_POLICIES][WT_CODE_LEN];
  int policyCount;
};

inline bool wtHas(const WtPersona &p, const char *code) {
  for (int i = 0; i < p.policyCount; i++) {
    if (strcmp(p.policies[i], code) == 0) return true;
  }
  return false;
}

/** 出力の口。実機ではこれを継承して、サーボとLEDを書く。 */
struct WtDriver {
  virtual ~WtDriver() {}
  virtual void servo(const char *name, const char *value) = 0;
  virtual void led(const char *name, const char *value) = 0;
  virtual void wait(int ms) = 0;
  virtual void note(const char *text) { (void)text; }
};

/** Python の str(round(x, n)) と同じ書き方（末尾の0を落とすが、小数点以下は1桁は残す）。 */
inline void wtFmtShort(char *out, size_t n, double v, int decimals) {
  char buf[32];
  snprintf(buf, sizeof(buf), "%.*f", decimals, v);
  size_t len = strlen(buf);
  if (strchr(buf, '.')) {
    while (len > 1 && buf[len - 1] == '0' && buf[len - 2] != '.') {
      buf[--len] = '\0';
    }
  }
  snprintf(out, n, "%s", buf);
}

// --- イベント → 動き ---------------------------------------------------------
// wt_core.py と同じ順番・同じ値。片方だけ直さないこと。

inline void wtOnIdle(const WtPersona &p, WtDriver &d) {
  double amplitude = floor((p.idleVariance / 100.0 * 12) * 10 + 0.5) / 10.0;
  int periodMs = (int)(4000 - p.energy * 20);
  char amp[16], v[48];
  wtFmtShort(amp, sizeof(amp), amplitude, 1);
  snprintf(v, sizeof(v), "\xc2\xb1%s deg / %dms", amp, periodMs);  // ±
  d.servo("body_sway", v);
  snprintf(v, sizeof(v), "%d%%", p.smile);
  d.led("cheek", v);
  int blink = p.blinkPerMin > 1 ? p.blinkPerMin : 1;
  d.wait((int)(60000 / blink));
}

inline void wtOnApproach(const WtPersona &p, WtDriver &d, double distanceM) {
  char v[48];
  if (distanceM > p.distanceM) {
    bool forward = (p.independence >= 55 || wtHas(p, "prefer_novel_options")) &&
                   !wtHas(p, "confirm_before_change");
    if (forward) {
      double room = distanceM - p.distanceM;
      double raw = (double)p.approachMps < room ? (double)p.approachMps : room;
      double step = floor(raw * 100 + 0.5) / 100.0;
      char s[16];
      wtFmtShort(s, sizeof(s), step, 2);
      snprintf(v, sizeof(v), "forward %sm/s", s);
      d.servo("drive", v);
    } else {
      d.servo("head", "tilt toward");
      d.note("（自分からは寄らない）");
    }
  } else {
    if (p.caution >= 60) {
      double back = floor((p.distanceM - distanceM) * 100 + 0.5) / 100.0;
      snprintf(v, sizeof(v), "back %.2fm", back);
      d.servo("drive", v);
    } else {
      d.servo("head", "face");
    }
  }
}

inline void wtOnGreet(const WtPersona &p, WtDriver &d) {
  char v[48];
  d.wait(p.responseDelayMs);
  int gestures = (int)(p.gestureRate / 25.0);
  if (gestures < 0) gestures = 0;
  for (int i = 0; i < gestures; i++) {
    snprintf(v, sizeof(v), "wave %d/%d", i + 1, gestures);
    d.servo("arm", v);
  }
  snprintf(v, sizeof(v), "hold %dms", p.gazeHoldMs);
  d.servo("gaze", v);
  int smile = p.smile + p.cheerfulness / 4;
  if (smile > 100) smile = 100;
  snprintf(v, sizeof(v), "smile %d%%", smile);
  d.led("mouth", v);
  if (wtHas(p, "keep_light_and_playful")) d.servo("body", "bounce");
}

inline void wtOnChange(const WtPersona &p, WtDriver &d) {
  if (wtHas(p, "confirm_before_change")) {
    d.servo("head", "shake slight");
    d.note("→ まず確かめる（confirm_before_change）");
  } else if (wtHas(p, "prefer_novel_options")) {
    d.servo("head", "nod fast");
    d.note("→ 乗る（prefer_novel_options）");
  } else {
    d.servo("head", "nod");
    d.note("→ ふつうに受ける");
  }
}

inline void wtOnSilence(const WtPersona &p, WtDriver &d, double seconds) {
  char v[48];
  double patience = 3 + (100 - p.energy) / 20.0;
  if (seconds < patience) {
    snprintf(v, sizeof(v), "hold %dms", p.gazeHoldMs);
    d.servo("gaze", v);
    return;
  }
  if (wtHas(p, "take_initiative") || (p.curiosity >= 65 && !wtHas(p, "follow_the_lead"))) {
    d.servo("head", "turn toward");
    int smile = p.smile + 10;
    if (smile > 100) smile = 100;
    snprintf(v, sizeof(v), "smile %d%%", smile);
    d.led("mouth", v);
    d.servo("arm", "beckon");
    d.note("→ 自分から切り出す");
  } else if (wtHas(p, "follow_the_lead") || p.caution >= 60) {
    d.servo("body", "settle");
    int cheek = p.smile - 10;
    if (cheek < 0) cheek = 0;
    snprintf(v, sizeof(v), "%d%%", cheek);
    d.led("cheek", v);
    d.note("→ 待つ");
  } else {
    d.servo("gaze", "glance");
    d.note("→ ちらと見るだけ");
  }
}

inline bool wtDispatch(const WtPersona &p, WtDriver &d, const char *event, double arg, bool hasArg) {
  if (strcmp(event, "idle") == 0) {
    wtOnIdle(p, d);
  } else if (strcmp(event, "approach") == 0) {
    wtOnApproach(p, d, hasArg ? arg : 2.0);
  } else if (strcmp(event, "greet") == 0) {
    wtOnGreet(p, d);
  } else if (strcmp(event, "change") == 0) {
    wtOnChange(p, d);
  } else if (strcmp(event, "silence") == 0) {
    wtOnSilence(p, d, hasArg ? arg : 10.0);
  } else {
    return false;
  }
  return true;
}

#endif  // WT_CORE_H
