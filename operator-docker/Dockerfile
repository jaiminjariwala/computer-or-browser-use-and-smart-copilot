# Sandboxed virtual desktop for Click Operator,
# now with a hybrid DOM perception layer.
#
#   Xvfb        offscreen X display (:99) at a fixed resolution
#   fluxbox     tiny window manager
#   x11vnc      exposes the display over VNC (:5900)
#   noVNC       browser VNC client over HTTP (:6080) for the live view
#   xdotool     synthesizes real mouse/keyboard input (visible cursor)
#   scrot       screenshots of the display
#   chromium    the browser the agent drives (launched with remote debugging so
#               the control server can read the DOM over CDP for hybrid perception)
#
# The control server (control_server.py) exposes:
#   GET  /health      readiness
#   GET  /screenshot  PNG of the desktop
#   GET  /dom         interactive elements with SCREEN coordinates (hybrid perception)
#   POST /action      maps an Action to xdotool (mouse glides smoothly to targets)
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xdotool \
    scrot \
    novnc \
    websockify \
    python3 \
    python3-websocket \
    chromium \
    dbus-x11 \
    x11-utils \
    x11-xserver-utils \
    fonts-dejavu \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/operator
COPY control_server.py /opt/operator/control_server.py
COPY entrypoint.sh /opt/operator/entrypoint.sh
RUN chmod +x /opt/operator/entrypoint.sh

# 6080 = noVNC live view; 5000 = control API; 9222 = Chromium CDP (internal).
EXPOSE 6080 5000

ENTRYPOINT ["/opt/operator/entrypoint.sh"]
