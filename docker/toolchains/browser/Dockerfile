FROM debian:bookworm-slim AS build

ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/toolchain/browsers

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates fontconfig fonts-liberation \
    fonts-dejavu-core fonts-noto-color-emoji file \
    && python3 -m pip install --break-system-packages "playwright==${PLAYWRIGHT_VERSION}" \
    && python3 -m playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    mkdir -p /toolchain/bin /toolchain/python /toolchain/lib /toolchain/fonts; \
    cp /usr/bin/fc-match /toolchain/bin/; \
    python3 -m pip install --break-system-packages --target /toolchain/python "playwright==${PLAYWRIGHT_VERSION}"; \
    cp -a /usr/share/fonts/truetype /toolchain/fonts/; \
    find /toolchain/browsers -type f -exec sh -c 'for f do ldd "$f" 2>/dev/null || :; done' sh {} + \
      | awk '/=> \/[^ ]+/ {print $3}' | sort -u \
      | while IFS= read -r lib; do cp -L "$lib" "/toolchain/lib/$(basename "$lib")"; done; \
    find /toolchain/python -name '*.so' -type f -exec sh -c 'for f do ldd "$f" 2>/dev/null || :; done' sh {} + \
      | awk '/=> \/[^ ]+/ {print $3}' | sort -u \
      | while IFS= read -r lib; do cp -L "$lib" "/toolchain/lib/$(basename "$lib")"; done; \
    ldd /toolchain/bin/fc-match | awk '/=> \/[^ ]+/ {print $3}' \
      | while IFS= read -r lib; do cp -L "$lib" "/toolchain/lib/$(basename "$lib")"; done; \
    printf '%s\n' '<?xml version="1.0"?>' '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
      '<fontconfig><dir>/opt/eve/toolchains/browser/fonts</dir><cachedir>/tmp/eve-browser-fontcache</cachedir></fontconfig>' \
      > /toolchain/fonts/fonts.conf

COPY bin/eve-browser-python /toolchain/bin/eve-browser-python
COPY probe.py /toolchain/probe.py
RUN chmod 755 /toolchain/bin/eve-browser-python \
    && printf '%s\n' 'export PATH="/opt/eve/toolchains/browser/bin:${PATH}"' > /toolchain/env.sh

FROM busybox:stable
COPY --from=build /toolchain /toolchain
