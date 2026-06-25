FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl ca-certificates \
    && pip3 install --break-system-packages uv \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /toolchain/bin /toolchain/lib /toolchain/share \
    && cp -a /usr/bin/python3* /toolchain/bin/ \
    && ln -s python3 /toolchain/bin/python \
    && cp -a /usr/bin/pip3 /toolchain/bin/ \
    && ln -s pip3 /toolchain/bin/pip \
    && cp -a /usr/local/bin/uv /toolchain/bin/ \
    && cp -a /usr/lib/python3* /toolchain/lib/ \
    && cp -a /usr/share/python3 /toolchain/share/ 2>/dev/null || true

# Copy shared libraries needed by python3
RUN for bin in /toolchain/bin/python3 /toolchain/bin/uv; do \
      ldd "$bin" 2>/dev/null | awk '/=>/ {print $3}' | while read -r lib; do \
        [ -f "$lib" ] && cp -n "$lib" /toolchain/lib/ 2>/dev/null || true; \
      done; \
    done

# env.sh for runtime PATH/env setup
RUN printf '#!/bin/sh\nexport PATH="/opt/eve/toolchains/python/bin:${PATH}"\nexport PYTHONPATH="/opt/eve/toolchains/python/lib"\n' > /toolchain/env.sh

FROM busybox:stable
COPY --from=build /toolchain /toolchain
