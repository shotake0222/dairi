// わけたま検証機 — C++版エンジンをホストで動かして、Python版と突き合わせるための道具。
//
// これ自体は機器に載らない。**写し間違いを見つけるためだけ**に存在する。
// tools/device/selftest.py が g++ でビルドして呼び、出力を1文字ずつ比べる。
//
//     g++ -std=c++11 -O0 -o /tmp/wt_hostcheck tools/device/hostcheck.cpp
//     /tmp/wt_hostcheck persona.min.json greet
//
// 出力は1行1動作:  servo\tarm\twave 1/2
//
// JSONの読み取りは、この最小形の決まった形だけを相手にする手抜き実装。
// ArduinoJson をホストへ持ってくるより、こちらの方が壊れたときに分かりやすい。

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "esp32/wt_device/wt_core.h"

static std::string readAll(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "開けません: %s\n", path);
    exit(2);
  }
  std::string out;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
  fclose(f);
  return out;
}

/** "m":[1,2,3] のような数の並びを取り出す。 */
static std::vector<double> numbers(const std::string &src, const char *key) {
  std::vector<double> out;
  std::string needle = std::string("\"") + key + "\":[";
  size_t at = src.find(needle);
  if (at == std::string::npos) return out;
  at += needle.size();
  size_t end = src.find(']', at);
  std::string body = src.substr(at, end - at);
  size_t pos = 0;
  while (pos < body.size()) {
    size_t comma = body.find(',', pos);
    if (comma == std::string::npos) comma = body.size();
    out.push_back(atof(body.substr(pos, comma - pos).c_str()));
    pos = comma + 1;
  }
  return out;
}

/** "c":["a","b"] の文字列の並びを取り出す。 */
static std::vector<std::string> strings(const std::string &src, const char *key) {
  std::vector<std::string> out;
  std::string needle = std::string("\"") + key + "\":[";
  size_t at = src.find(needle);
  if (at == std::string::npos) return out;
  at += needle.size();
  size_t end = src.find(']', at);
  std::string body = src.substr(at, end - at);
  size_t pos = 0;
  while (true) {
    size_t open = body.find('"', pos);
    if (open == std::string::npos) break;
    size_t close = body.find('"', open + 1);
    if (close == std::string::npos) break;
    out.push_back(body.substr(open + 1, close - open - 1));
    pos = close + 1;
  }
  return out;
}

struct PrintDriver : public WtDriver {
  void servo(const char *name, const char *value) override { printf("servo\t%s\t%s\n", name, value); }
  void led(const char *name, const char *value) override { printf("led\t%s\t%s\n", name, value); }
  void wait(int ms) override { printf("wait\t\t%d\n", ms); }
  void note(const char *text) override { (void)text; }  // 人が読む用なので比べない
};

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: wt_hostcheck persona.min.json <event> [arg]\n");
    return 1;
  }
  std::string src = readAll(argv[1]);

  WtPersona p;
  memset(&p, 0, sizeof(p));
  std::vector<double> m = numbers(src, "m"), pr = numbers(src, "p"),
                      e = numbers(src, "e"), t = numbers(src, "t");
  if (m.size() < 6 || pr.size() < 2 || e.size() < 2 || t.size() < 6) {
    fprintf(stderr, "最小形の形が違います\n");
    return 2;
  }
  p.energy = (int)m[0];
  p.gestureRate = (int)m[1];
  p.idleVariance = (int)m[2];
  p.responseDelayMs = (int)m[3];
  p.gazeHoldMs = (int)m[4];
  p.posture = (int)m[5];
  p.distanceM = (float)pr[0];
  p.approachMps = (float)pr[1];
  p.smile = (int)e[0];
  p.blinkPerMin = (int)e[1];
  p.warmth = (int)t[0];
  p.curiosity = (int)t[1];
  p.cheerfulness = (int)t[2];
  p.caution = (int)t[3];
  p.independence = (int)t[4];
  p.humor = (int)t[5];

  std::vector<std::string> codes = strings(src, "c");
  p.policyCount = 0;
  for (size_t i = 0; i < codes.size() && p.policyCount < WT_MAX_POLICIES; i++) {
    snprintf(p.policies[p.policyCount], WT_CODE_LEN, "%s", codes[i].c_str());
    p.policyCount++;
  }

  PrintDriver d;
  bool hasArg = argc > 3;
  double arg = hasArg ? atof(argv[3]) : 0.0;
  if (!wtDispatch(p, d, argv[2], arg, hasArg)) {
    fprintf(stderr, "知らないイベント: %s\n", argv[2]);
    return 3;
  }
  return 0;
}
