#!/usr/bin/env bash
# Boot the sandboxed virtual desktop and all its services, then hand off to the
# control server (kept in the foreground so the container's lifetime tracks it).
set -e

WIDTH="${SCREEN_WIDTH:-1280}"
HEIGHT="${SCREEN_HEIGHT:-800}"
DEPTH="${SCREEN_DEPTH:-24}"
export DISPLAY="${DISPLAY:-:99}"

echo "[entrypoint] starting Xvfb on ${DISPLAY} at ${WIDTH}x${HEIGHT}x${DEPTH}"
Xvfb "${DISPLAY}" -screen 0 "${WIDTH}x${HEIGHT}x${DEPTH}" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &

# Wait for the X display to accept connections before starting anything on it.
for _ in $(seq 1 50); do
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then break; fi
    sleep 0.2
done

echo "[entrypoint] setting a visible desktop background"
xsetroot -solid "#20203a" >/dev/null 2>&1 || true

echo "[entrypoint] starting fluxbox window manager"
fluxbox >/tmp/fluxbox.log 2>&1 &

echo "[entrypoint] starting x11vnc on :5900"
# -cursor most makes the mouse cursor render in the live view so the user can
# watch it move as the agent acts.
x11vnc -display "${DISPLAY}" -forever -shared -nopw -rfbport 5900 -cursor most -quiet >/tmp/x11vnc.log 2>&1 &

echo "[entrypoint] starting noVNC (websockify) on :6080"
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

# Launch Chromium with remote debugging so the control server can read the DOM
# over CDP (hybrid perception). --no-sandbox is required in an unprivileged
# container. Keep the toolbar so the agent can use the address bar.
echo "[entrypoint] launching Chromium (with remote debugging)"
(
    sleep 1
    chromium \
        --no-sandbox \
        --disable-gpu \
        --no-first-run \
        --no-default-browser-check \
        --disable-dev-shm-usage \
        --remote-debugging-port=9222 \
        --remote-debugging-address=127.0.0.1 \
        --remote-allow-origins=* \
        --user-data-dir=/tmp/chrome-profile \
        --window-position=0,0 \
        --window-size="${WIDTH},${HEIGHT}" \
        "https://duckduckgo.com/" >/tmp/chromium.log 2>&1 &
) || true

# Make the Chromium window fill the whole screen so the live view looks like a
# browser (Operator-style), hiding the bare desktop.
(
    for _ in $(seq 1 40); do
        WID="$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)"
        if [ -n "${WID}" ]; then
            xdotool windowsize "${WID}" "${WIDTH}" "${HEIGHT}" windowmove "${WID}" 0 0 windowactivate "${WID}"
            break
        fi
        sleep 0.5
    done
) >/tmp/maximize.log 2>&1 &

echo "[entrypoint] starting control server on :5000"
exec python3 /opt/operator/control_server.py
