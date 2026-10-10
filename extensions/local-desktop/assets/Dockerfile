# Bot computer image for the local-desktop worker provider.
# The provider tags it by the hash of this directory, so any edit here
# produces a new image on the next provision.
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# XFCE on TigerVNC, plus the X11 and accessibility libraries the CUA driver loads.
RUN set -eux; \
  apt-get update -o Acquire::Retries=3; \
  apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    at-spi2-core ca-certificates curl dbus-x11 fonts-dejavu-core libxext6 libxi6 \
    libxkbcommon0 mousepad python3-gi thunar tigervnc-standalone-server tigervnc-tools \
    x11-utils xdotool xfce4-panel xfce4-session xfce4-settings xfce4-terminal xfdesktop4 \
    xfwm4 xz-utils; \
  rm -rf /var/lib/apt/lists/*

# The provider copies the Gateway's NODE_EXTRA_CA_CERTS here (empty when unset) so
# downloads also work behind a TLS-inspecting proxy the host already trusts.
COPY extra-ca-certificates.pem /tmp/extra-ca-certificates.pem
RUN set -eu; \
  cd /usr/local/share/ca-certificates; \
  awk '/BEGIN CERTIFICATE/ { n++ } n { print > ("openclaw-extra-" n ".crt") }' /tmp/extra-ca-certificates.pem; \
  rm /tmp/extra-ca-certificates.pem; \
  update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# The guest OpenClaw node installs its own exact version from the Gateway; the
# image only supplies a supported Node runtime, pinned by checksum.
RUN set -eux; \
  version=24.21.0; \
  case "$(dpkg --print-architecture)" in \
    amd64) arch=x64; sum=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;; \
    arm64) arch=arm64; sum=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 ;; \
    *) echo "unsupported architecture" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --retry 3 -o /tmp/node.tar.xz "https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.xz"; \
  echo "${sum}  /tmp/node.tar.xz" | sha256sum -c -; \
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
  rm /tmp/node.tar.xz; \
  node --version

# Ubuntu ships uid 1000 as "ubuntu"; the bot account takes it so volume files
# keep one owner across image rebuilds.
RUN userdel --remove ubuntu && useradd --create-home --shell /bin/bash --uid 1000 bot \
  && install -d -o bot -g bot -m 700 /var/lib/openclaw-desktop

COPY desktop-start.sh /usr/local/lib/openclaw-desktop/start.sh

USER bot
WORKDIR /home/bot
ENTRYPOINT ["/bin/sh", "/usr/local/lib/openclaw-desktop/start.sh"]
