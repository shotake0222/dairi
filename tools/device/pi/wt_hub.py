#!/usr/bin/env python3
"""
わけたま検証機 WT-4「もり」 — 母艦（Raspberry Pi 4 8GB 想定。PCでも動く）。

**この検証機の本体は、実はここ。**
機器が1台だけ動いても「人格が身体を動かしている」ことの証明にはならない。
証明になるのは、**性格の違う2体に、同じ瞬間に同じイベントを投げて、
違う動きが出ること**。それを撮って、数字で残すための道具。

母艦がやること:
  1. 人格カードを取りに行く（**持ち主トークンを持つのはここだけ**）
  2. 機器用の最小形へ落とす（会話・覚え書き・属性が混ざっていないか検査してから）
  3. 子機へ配る（USBシリアル、または Wi-Fi の GET /persona/<slot>）
  4. **2台へ同じイベントを同時に送る**
  5. 返ってきた act / metric を CSV に残す（docs/EDGE_DEVICE_TEST.md §6 の記録表がそのまま埋まる）
  6. 段階B（言葉）が要るときだけ Ollama に中継する

やらないこと:
  - 子機へトークンを渡す（絶対に。docs/DEVICE_SPEC.md §6）
  - 人格カードそのものを子機へ渡す（あれは持ち主の生活が書いてあるファイル）

使い方:
    # 人格を取ってきて、最小形を2つ作る（トークンは環境変数から。画面に出さない）
    export WAKETAMA_TOKEN_A=... WAKETAMA_TOKEN_B=...
    python3 wt_hub.py fetch --cid <CID_A> --slot a --token-env WAKETAMA_TOKEN_A
    python3 wt_hub.py fetch --cid <CID_B> --slot b --token-env WAKETAMA_TOKEN_B

    # 母艦を起動（子機はUSBシリアル、または --node で同じPC上のノード）
    python3 wt_hub.py serve --port 8770 \
        --serial a=/dev/ttyACM0 --serial b=/dev/ttyUSB0

    # 機材が無いところで通しを確認する（ノードを2つ、GPIOなしで動かす）
    python3 wt_hub.py serve --dry

    # ブラウザで http://<母艦のIP>:8770/ を開くと、押すだけの操作盤が出る
"""

import argparse
import csv
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "common"))

import wt_compact  # noqa: E402
import wt_core  # noqa: E402
import wt_proto  # noqa: E402

DEFAULT_ORIGIN = "https://app.waketama.com"
PERSONA_DIR = os.path.join(HERE, "personas")
RUNS_DIR = os.path.join(HERE, "runs")
CONSOLE = os.path.join(HERE, "console.html")


# --- 1. 人格を取ってくる ------------------------------------------------------


def fetch_persona(origin, cid, token, slot, max_policies=6):
    """人格カードを取り、最小形にして保存する。**トークンはここから先へ出さない。**"""
    url = "%s/api/character/card?format=json&cid=%s&token=%s" % (origin, cid, token)
    with urllib.request.urlopen(url, timeout=30) as res:
        card = json.load(res)

    compact = wt_compact.to_compact(card, max_policies=max_policies)
    report = wt_compact.audit(compact, card)
    if not report["ok"]:
        raise SystemExit("会話や覚え書きが混ざっています。配りません:\n  %s" % "\n  ".join(report["leaks"]))
    if report["over"]:
        raise SystemExit("最小形が %d バイトで上限を超えています（--max-policies を減らしてください）" % report["bytes"])

    os.makedirs(PERSONA_DIR, exist_ok=True)
    path = os.path.join(PERSONA_DIR, "%s.min.json" % slot)
    with open(path, "w", encoding="utf-8") as f:
        f.write(wt_compact.to_json(compact))
    print("%s に保存しました（%d バイト）: %s / %s"
          % (path, report["bytes"], compact["n"], ", ".join(compact["c"])))
    return compact


SAMPLES = {"a": "bold.min.json", "b": "careful.min.json"}
SAMPLE_DIR = os.path.join(HERE, "..", "samples")


def slot_path(slot):
    """その枠の人格ファイル。まだ取ってきていなければ、同梱の見本で代用する。

    見本があるのは、**機材も分身も無い状態で通しを確認できる**ようにするため。
    見本は性格が逆の2体で、合格基準を満たすところまで確認済み（selftest.py）。
    """
    path = os.path.join(PERSONA_DIR, "%s.min.json" % slot)
    if os.path.exists(path):
        return path
    sample = os.path.join(SAMPLE_DIR, SAMPLES.get(slot, ""))
    return sample if os.path.exists(sample) else None


def load_slot(slot):
    path = slot_path(slot)
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# --- 2. 子機との接続 ----------------------------------------------------------


class Node(object):
    """子機1台ぶんの口。シリアルでも、同じPC上のプロセスでも同じ扱いにする。"""

    def __init__(self, slot, on_line):
        self.slot = slot
        self.on_line = on_line
        self.alive = False

    def send(self, obj):
        raise NotImplementedError

    def close(self):
        pass


class SerialNode(Node):
    def __init__(self, slot, device, on_line, baud=115200):
        Node.__init__(self, slot, on_line)
        import serial  # pyserial。無ければ pip install pyserial

        self.ser = serial.Serial(device, baud, timeout=1)
        self.alive = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while self.alive:
            try:
                raw = self.ser.readline().decode("utf-8", "replace")
            except Exception:
                break
            msg = wt_proto.decode(raw)
            if msg:
                self.on_line(self.slot, msg)

    def send(self, obj):
        self.ser.write(wt_proto.encode(obj).encode("utf-8"))

    def close(self):
        self.alive = False
        try:
            self.ser.close()
        except Exception:
            pass


class LocalNode(Node):
    """同じ機械の上で wt_node.py を --serve で動かす。機材が無くても通しを試せる。"""

    def __init__(self, slot, persona_path, on_line, dry=True):
        Node.__init__(self, slot, on_line)
        cmd = [sys.executable, os.path.join(HERE, "wt_node.py"),
               "--persona", persona_path, "--serve"]
        if dry:
            cmd.append("--dry")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.alive = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for raw in self.proc.stdout:
            msg = wt_proto.decode(raw)
            if msg:
                self.on_line(self.slot, msg)
        self.alive = False

    def send(self, obj):
        try:
            self.proc.stdin.write(wt_proto.encode(obj))
            self.proc.stdin.flush()
        except Exception:
            self.alive = False

    def close(self):
        self.alive = False
        try:
            self.proc.terminate()
        except Exception:
            pass


# --- 3. 母艦 ------------------------------------------------------------------


class Hub(object):
    def __init__(self, origin=DEFAULT_ORIGIN):
        self.origin = origin
        self.nodes = {}
        self.records = []
        self.lock = threading.Lock()
        os.makedirs(RUNS_DIR, exist_ok=True)
        self.run_path = os.path.join(RUNS_DIR, time.strftime("%Y%m%d-%H%M%S") + ".csv")
        with open(self.run_path, "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerow(["at", "slot", "type", "event", "kind", "name", "value", "first_ms", "total_ms"])

    def on_line(self, slot, msg):
        """子機からの1行。**ここで記録に落とす**ので、あとから手で書き写さなくてよい。"""
        row = [time.strftime("%H:%M:%S"), slot, msg.get("t", ""), msg.get("e", ""),
               msg.get("o", ""), msg.get("n", ""), msg.get("v", msg.get("m", "")),
               msg.get("first_ms", ""), msg.get("total_ms", "")]
        with self.lock:
            self.records.append(row)
            self.records = self.records[-500:]
            with open(self.run_path, "a", encoding="utf-8", newline="") as f:
                csv.writer(f).writerow(row)

    def attach_serial(self, slot, device):
        self.nodes[slot] = SerialNode(slot, device, self.on_line)

    def attach_local(self, slot, persona_path, dry=True):
        self.nodes[slot] = LocalNode(slot, persona_path, self.on_line, dry=dry)

    def push_personas(self):
        for slot, node in self.nodes.items():
            data = load_slot(slot)
            if data:
                node.send({"t": wt_proto.T_PERSONA, "d": data})

    def broadcast(self, event, arg=None):
        """**同時に投げる**。順番に投げると、遅れが性格の差に見えてしまう。"""
        msg = {"t": wt_proto.T_EVENT, "e": event}
        if arg is not None:
            msg["dist" if event == "approach" else "sec"] = float(arg)
        threads = []
        for node in self.nodes.values():
            th = threading.Thread(target=node.send, args=(msg,))
            threads.append(th)
        for th in threads:
            th.start()
        for th in threads:
            th.join(timeout=2)

    def compare(self):
        """2体を並べて、差が出ているかを判定する（合格基準は wt_core.compare）。"""
        slots = sorted(self.nodes.keys()) or ["a", "b"]
        if len(slots) < 2:
            return {"error": "2体ぶんの人格が要ります"}
        a, b = load_slot(slots[0]), load_slot(slots[1])
        if not a or not b:
            return {"error": "人格が足りません（wt_hub.py fetch を2回）"}
        return wt_core.compare(wt_core.Persona(a), wt_core.Persona(b))


# --- 4. HTTP（操作盤 + 子機への配布） -----------------------------------------


class Handler(BaseHTTPRequestHandler):
    hub = None

    def log_message(self, *args):
        pass  # アクセスログは要らない（会話が写ることは無いが、静かな方がよい）

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            with open(CONSOLE, encoding="utf-8") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if path.startswith("/persona/"):
            data = load_slot(path.rsplit("/", 1)[1])
            if not data:
                return self._send(404, json.dumps({"error": "no persona"}))
            return self._send(200, json.dumps(data, separators=(",", ":"), ensure_ascii=False))
        if path == "/state":
            with self.hub.lock:
                rows = self.hub.records[-80:]
            return self._send(200, json.dumps({
                "nodes": {s: n.alive for s, n in self.hub.nodes.items()},
                "personas": {s: (load_slot(s) or {}).get("n", "") for s in ("a", "b")},
                "rows": rows,
                "run": os.path.basename(self.hub.run_path),
            }, ensure_ascii=False))
        if path == "/compare":
            return self._send(200, json.dumps(self.hub.compare(), ensure_ascii=False))
        return self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if path == "/event":
            self.hub.broadcast(body.get("e", "greet"), body.get("arg"))
            return self._send(200, json.dumps({"ok": True}))
        if path == "/push":
            self.hub.push_personas()
            return self._send(200, json.dumps({"ok": True}))
        if path == "/stop":
            for node in self.hub.nodes.values():
                node.send({"t": wt_proto.T_STOP})
            return self._send(200, json.dumps({"ok": True}))
        return self._send(404, json.dumps({"error": "not found"}))


# --- 5. 入口 ------------------------------------------------------------------


def cmd_fetch(args):
    token = os.environ.get(args.token_env or "")
    if not token:
        raise SystemExit("トークンが環境変数 %s にありません。画面に出さないため引数では受け取りません"
                         % (args.token_env or "(未指定)"))
    fetch_persona(args.origin, args.cid, token, args.slot, args.max_policies)
    return 0


def cmd_serve(args):
    hub = Hub(origin=args.origin)
    if args.dry:
        for slot in ("a", "b"):
            path = slot_path(slot)
            if path:
                hub.attach_local(slot, path, dry=True)
        if not hub.nodes:
            raise SystemExit("人格がありません（先に fetch するか、tools/device/samples を置いてください）")
    for pair in args.serial or []:
        slot, device = pair.split("=", 1)
        hub.attach_serial(slot, device)

    hub.push_personas()
    Handler.hub = hub
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print("母艦を起動しました: http://0.0.0.0:%d/  記録: %s" % (args.port, hub.run_path))
    print("子機: %s" % (", ".join(hub.nodes) or "（まだ繋がっていません）"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for node in hub.nodes.values():
            node.close()
    return 0


def cmd_compare(args):
    hub = Hub(origin=args.origin)
    result = hub.compare()
    if "error" in result:
        raise SystemExit(result["error"])
    print("=== %s vs %s ===" % (result["a"], result["b"]))
    for label, x, y in result["rows"]:
        print("  %-18s %-10s %-10s%s" % (label, x, y, "  ← 同じ" if x == y else ""))
    print("  片方だけの方針  A:%s  B:%s" % (result["only_a"] or "-", result["only_b"] or "-"))
    print("")
    for name, ok, detail in result["checks"]:
        print("  [%s] %s %s" % ("合格" if ok else "不合格", name, detail))
    print("\n判定: %s" % ("合格" if result["pass"] else "不合格（育ちが浅いか、性格が近すぎます）"))
    return 0 if result["pass"] else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="わけたま検証機の母艦")
    ap.add_argument("--origin", default=DEFAULT_ORIGIN)
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="人格カードを取って最小形にする")
    f.add_argument("--cid", required=True)
    f.add_argument("--slot", default="a")
    f.add_argument("--token-env", required=True, help="トークンが入っている環境変数の名前")
    f.add_argument("--max-policies", type=int, default=6)
    f.set_defaults(func=cmd_fetch)

    s = sub.add_parser("serve", help="子機を繋いで操作盤を出す")
    s.add_argument("--port", type=int, default=8770)
    s.add_argument("--serial", action="append", help="slot=/dev/ttyACM0 の形で指定（複数可）")
    s.add_argument("--dry", action="store_true", help="機材なしで同じPC上にノードを2つ立てる")
    s.set_defaults(func=cmd_serve)

    c = sub.add_parser("compare", help="2体の差が合格基準を満たすか判定する")
    c.set_defaults(func=cmd_compare)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
