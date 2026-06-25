FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git cmake make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch v1.8.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper \
    && cd /tmp/whisper \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build -j$(nproc) --target whisper-cli \
    && mkdir -p /toolchain/bin /toolchain/models /toolchain/lib \
    && cp build/bin/whisper-cli /toolchain/bin/ \
    && cp /usr/bin/ffmpeg /toolchain/bin/ \
    && cp /usr/bin/ffprobe /toolchain/bin/ \
    && rm -rf /tmp/whisper

RUN curl -L -o /toolchain/models/ggml-small.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin

# Copy shared libraries required by ffmpeg, ffprobe, and whisper-cli
RUN for bin in /toolchain/bin/ffmpeg /toolchain/bin/ffprobe /toolchain/bin/whisper-cli; do \
      ldd "$bin" 2>/dev/null | awk '/=>/ {print $3}' | while read -r lib; do \
        [ -f "$lib" ] && cp -n "$lib" /toolchain/lib/ 2>/dev/null || true; \
      done; \
    done

# env.sh for runtime setup
RUN printf '#!/bin/sh\nexport PATH="/opt/eve/toolchains/media/bin:${PATH}"\nexport LD_LIBRARY_PATH="/opt/eve/toolchains/media/lib:${LD_LIBRARY_PATH:-}"\nexport WHISPER_MODELS_DIR="/opt/eve/toolchains/media/models"\n' > /toolchain/env.sh

FROM busybox:stable
COPY --from=build /toolchain /toolchain
