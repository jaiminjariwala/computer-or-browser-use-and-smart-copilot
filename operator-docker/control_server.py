#!/usr/bin/env python3
"""In-container control server for the Click Operator virtual desktop.

  GET  /health      -> {"ok": true}
  GET  /screenshot  -> image/png
  GET  /dom         -> {"elements":[{text,x,y,w,h}, ...]}  (hybrid perception)
  POST /action      -> {"ok": true} | {"ok": false}        (xdotool, smooth glide)

The mouse glides smoothly to each target so the motion is visible in the live
view. /dom reads Chromium's DOM over CDP and returns interactive elements in
SCREEN coordinates (aligned with the screenshot + xdotool), so the agent can be
guided by structured text instead of relying solely on the screenshot.
"""
import json
import os
import subprocess
import tempfile
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from websocket import create_connection  # python3-websocket
except Exception:  # pragma: no cover
    create_connection = None

DISPLAY = os.environ.get("DISPLAY", ":99")
PORT = int(os.environ.get("CONTROL_PORT", "5000"))
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
ENV = {**os.environ, "DISPLAY": DISPLAY}

KEY_ALIASES = {
    "cmd": "ctrl", "command": "ctrl", "meta": "super", "super": "super",
    "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "option": "alt",
    "shift": "shift", "enter": "Return", "return": "Return", "tab": "Tab",
    "esc": "Escape", "escape": "Escape", "space": "space",
    "backspace": "BackSpace", "delete": "Delete",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
}


def xdotool(*args):
    subprocess.run(["xdotool", *args], env=ENV, check=True)


def cursor_pos():
    out = subprocess.run(["xdotool", "getmouselocation", "--shell"], env=ENV,
                         check=True, capture_output=True, text=True).stdout
    vals = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            vals[k] = v
    return int(vals.get("X", 0)), int(vals.get("Y", 0))


def glide(x, y, steps=14, delay=0.012):
    """Move the pointer smoothly to (x, y) so the motion is visible in the view."""
    x, y = int(x), int(y)
    sx, sy = cursor_pos()
    for i in range(1, steps + 1):
        nx = round(sx + (x - sx) * i / steps)
        ny = round(sy + (y - sy) * i / steps)
        xdotool("mousemove", str(nx), str(ny))
        time.sleep(delay)


def to_keysym(token):
    key = token.strip().lower()
    return KEY_ALIASES.get(key, token if len(token) == 1 else token.capitalize())


def run_action(action):
    kind = action.get("kind")
    at = action.get("at") or {}
    x, y = at.get("x"), at.get("y")

    if kind == "screenshot":
        return
    if kind == "wait":
        time.sleep(min(float(action.get("ms", 0)) / 1000.0, 10.0))
        return
    if kind == "mouse_move":
        glide(x, y)
        return
    if kind == "left_click":
        glide(x, y)
        xdotool("click", "1")
        return
    if kind == "right_click":
        glide(x, y)
        xdotool("click", "3")
        return
    if kind == "double_click":
        glide(x, y)
        xdotool("click", "--repeat", "2", "1")
        return
    if kind == "drag":
        f, t = action.get("from") or {}, action.get("to") or {}
        glide(f.get("x"), f.get("y"))
        xdotool("mousedown", "1")
        glide(t.get("x"), t.get("y"))
        xdotool("mouseup", "1")
        return
    if kind == "type":
        xdotool("type", "--", str(action.get("text", "")))
        return
    if kind == "key":
        chord = "+".join(to_keysym(k) for k in action.get("keys", []))
        if chord:
            xdotool("key", chord)
        return
    if kind == "scroll":
        if x is not None and y is not None:
            glide(x, y)
        dy = int(action.get("dy", 0))
        button = "5" if dy > 0 else "4"
        for _ in range(max(1, abs(dy) // 100)):
            xdotool("click", button)
        return
    raise ValueError(f"unsupported action kind: {kind}")


def take_screenshot():
    path = tempfile.mktemp(suffix=".png")
    subprocess.run(["scrot", "-o", path], env=ENV, check=True)
    with open(path, "rb") as f:
        data = f.read()
    os.unlink(path)
    return data


# JS that returns the browser's interactive elements in VIEWPORT coords plus the
# chrome height (outerHeight - innerHeight), so the server can convert to screen.
DOM_JS = r"""
(() => {
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';
  const els = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const t = (el.innerText || el.value || el.getAttribute('aria-label') ||
               el.getAttribute('placeholder') || el.getAttribute('title') || '')
              .trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!t) continue;
    els.push({ t, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
               w: Math.round(r.width), h: Math.round(r.height) });
    if (els.length >= 60) break;
  }
  return { chromeH: Math.max(0, outerHeight - innerHeight), els };
})()
"""


def cdp_eval():
    if create_connection is None:
        return None
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json", timeout=3))
    page = next((t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
    if not page:
        return None
    ws = create_connection(page["webSocketDebuggerUrl"], timeout=4)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": DOM_JS, "returnByValue": True}}))
        for _ in range(50):
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                return msg.get("result", {}).get("result", {}).get("value")
    finally:
        ws.close()
    return None


def dom_elements():
    """Interactive elements in SCREEN coordinates (aligned with the screenshot)."""
    data = cdp_eval()
    if not data:
        return []
    chrome_h = int(data.get("chromeH", 0))
    # The Chromium window top on screen (fluxbox may offset it); its content
    # viewport starts chrome_h below the window top.
    try:
        wid = subprocess.run(["xdotool", "search", "--onlyvisible", "--class", "chromium"],
                             env=ENV, capture_output=True, text=True).stdout.split()[0]
        geo = subprocess.run(["xdotool", "getwindowgeometry", "--shell", wid],
                             env=ENV, capture_output=True, text=True).stdout
        pos = {k: int(v) for k, v in (l.split("=", 1) for l in geo.splitlines() if "=" in l)}
        win_x, win_y = pos.get("X", 0), pos.get("Y", 0)
    except Exception:
        win_x, win_y = 0, 0
    out = []
    for e in data.get("els", []):
        out.append({
            "text": e["t"],
            "x": win_x + e["x"],
            "y": win_y + chrome_h + e["y"],
            "w": e["w"],
            "h": e["h"],
        })
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
            return
        if self.path == "/screenshot":
            try:
                png = take_screenshot()
            except Exception as err:
                self._json(500, {"ok": False, "error": str(err)})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
            return
        if self.path == "/dom":
            try:
                self._json(200, {"ok": True, "elements": dom_elements()})
            except Exception as err:
                self._json(200, {"ok": True, "elements": [], "error": str(err)})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/action":
            self._json(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            action = json.loads(self.rfile.read(length) or "{}")
            run_action(action)
            self._json(200, {"ok": True})
        except Exception as err:
            self._json(400, {"ok": False, "error": str(err)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
