#!/bin/bash
# Install desktop packages and MIM desktop config inside a Debian/Ubuntu container.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v apt-get >/dev/null 2>&1; then
  echo "install-desktop.sh must run inside a Debian/Ubuntu container" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update -qq
sudo apt-get install -y -qq \
  bspwm \
  sxhkd \
  xwallpaper \
  polybar \
  gnome-themes-extra \
  fonts-inter \
  fonts-jetbrains-mono \
  imagemagick

sudo install -d -m 755 /usr/local/share/mim /usr/local/share/mim/desktop
sudo install -m 644 "$REPO_DIR/assets/wallpaper.png" /usr/local/share/mim/wallpaper.png
sudo install -m 755 "$REPO_DIR/desktop/bspwmrc" /usr/local/share/mim/desktop/bspwmrc
sudo install -m 644 "$REPO_DIR/desktop/sxhkdrc" /usr/local/share/mim/desktop/sxhkdrc
sudo install -m 644 "$REPO_DIR/desktop/polybar.ini" /usr/local/share/mim/desktop/polybar.ini
sudo install -m 755 "$REPO_DIR/desktop/mim-status.sh" /usr/local/share/mim/desktop/mim-status.sh

mkdir -p "$HOME/.config/bspwm" "$HOME/.config/sxhkd" "$HOME/.config/polybar"
ln -sfn /usr/local/share/mim/desktop/bspwmrc "$HOME/.config/bspwm/bspwmrc"
ln -sfn /usr/local/share/mim/desktop/sxhkdrc "$HOME/.config/sxhkd/sxhkdrc"
ln -sfn /usr/local/share/mim/desktop/polybar.ini "$HOME/.config/polybar/config.ini"

xfconf_set() {
  channel="$1"
  prop="$2"
  type="$3"
  value="$4"
  xfconf-query -c "$channel" -p "$prop" -s "$value" 2>/dev/null \
    || xfconf-query -c "$channel" -p "$prop" --create -t "$type" -s "$value" 2>/dev/null \
    || true
}

if command -v xfconf-query >/dev/null 2>&1; then
  xfconf_set xsettings /Net/ThemeName string Adwaita-dark
  xfconf_set xsettings /Net/IconThemeName string Adwaita
  xfconf_set xsettings /Gtk/FontName string "Inter 10"
  xfconf_set xsettings /Gtk/MonospaceFontName string "JetBrains Mono 10"
fi

if command -v gsettings >/dev/null 2>&1; then
  gsettings set org.gnome.desktop.interface gtk-theme "Adwaita-dark" 2>/dev/null || true
  gsettings set org.gnome.desktop.interface color-scheme "prefer-dark" 2>/dev/null || true
fi

echo "installed MIM desktop config"
