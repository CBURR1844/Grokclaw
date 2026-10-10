#!/bin/sh
# Starts one private X desktop and keeps the container alive while it runs.
# /tmp/openclaw-desktop is the contract with the provider: session.env for
# processes started with `docker exec`, vnc-password for the node's RFB relay,
# and ready once the X server accepts clients.
set -eu
umask 077
run=/tmp/openclaw-desktop
rm -rf "$run"
mkdir -p "$run/xdg"

# VncAuth uses at most 8 characters. The node reads the plaintext copy; TigerVNC
# reads the obfuscated one.
password=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8)
printf '%s\n' "$password" > "$run/vnc-password"
printf '%s\n' "$password" | vncpasswd -f > "$run/vnc.passwd"

export DISPLAY=:1 XDG_RUNTIME_DIR="$run/xdg"
eval "$(dbus-launch --sh-syntax)"
{
  echo "DISPLAY=$DISPLAY"
  echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
  echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
} > "$run/session.env"

# VncAuth must be the only offered type: the node refuses VeNCrypt and no-auth servers.
Xtigervnc :1 -localhost=1 -rfbport 5900 -SecurityTypes VncAuth -PasswordFile "$run/vnc.passwd" \
  -geometry 1280x800 -depth 24 -AlwaysShared -AcceptSetDesktopSize -nolisten tcp &
xvnc=$!
tries=0
until xdpyinfo >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ] || ! kill -0 "$xvnc" 2>/dev/null; then
    echo "X server did not start" >&2
    exit 1
  fi
  sleep 0.1
done
startxfce4 >"$run/xfce.log" 2>&1 &
touch "$run/ready"
wait "$xvnc"
