FROM ubuntu:jammy

ENV DEBIAN_FRONTEND=noninteractive

# Display, window manager, VNC, accessibility, fonts, apps
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb bspwm sxhkd xdotool xwallpaper x11-xserver-utils \
    x11vnc novnc websockify \
    ttyd tmux \
    dbus dbus-x11 at-spi2-core \
    xfce4-settings gnome-themes-extra \
    fonts-inter fonts-jetbrains-mono \
    xfce4-terminal mousepad thunar gnome-calculator \
    surf epiphany-browser \
    polybar socat \
    gcc pkg-config libdbus-1-dev libatspi2.0-dev libglib2.0-dev \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Native C tool
COPY atspi-tool.c /tmp/build/
RUN gcc -O2 -o /opt/atspi-tool /tmp/build/atspi-tool.c $(pkg-config --cflags --libs atspi-2 gobject-2.0 dbus-1) -lm && \
    rm -rf /tmp/build

COPY atspi-wrapper.sh /usr/local/bin/atspi
RUN chmod +x /usr/local/bin/atspi

# Desktop config
COPY assets/wallpaper.png /usr/local/share/mim/wallpaper.png
COPY desktop/ /usr/local/share/mim/desktop/
RUN chmod +x /usr/local/share/mim/desktop/bspwmrc /usr/local/share/mim/desktop/mim-status.sh

# WM config symlinks + dark theme
RUN mkdir -p /root/.config/bspwm /root/.config/sxhkd /root/.config/polybar \
             /root/.config/xfce4/xfconf/xfce-perchannel-xml && \
    ln -sfn /usr/local/share/mim/desktop/bspwmrc /root/.config/bspwm/bspwmrc && \
    ln -sfn /usr/local/share/mim/desktop/sxhkdrc /root/.config/sxhkd/sxhkdrc && \
    ln -sfn /usr/local/share/mim/desktop/polybar.ini /root/.config/polybar/config.ini && \
    printf '<?xml version="1.0" encoding="UTF-8"?>\n\
<channel name="xsettings" version="1.0">\n\
  <property name="Net" type="empty">\n\
    <property name="ThemeName" type="string" value="Adwaita-dark"/>\n\
    <property name="IconThemeName" type="string" value="Adwaita"/>\n\
  </property>\n\
  <property name="Gtk" type="empty">\n\
    <property name="FontName" type="string" value="Inter 10"/>\n\
    <property name="MonospaceFontName" type="string" value="JetBrains Mono 10"/>\n\
  </property>\n\
</channel>\n' > /root/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml

WORKDIR /app
RUN mkdir -p /shared

# Node dependencies (cached unless package.json changes)
COPY package.json ./
RUN npm install

# Everything else
COPY . .

EXPOSE 6080 7080 7681
ENTRYPOINT ["/app/docker-entrypoint.sh"]
