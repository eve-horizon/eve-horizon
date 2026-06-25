FROM rust:slim-bookworm AS build
RUN rustup component add rustfmt clippy \
    && rustup component remove rust-docs 2>/dev/null || true \
    && mkdir -p /toolchain \
    && cp -a /usr/local/cargo /toolchain/cargo \
    && cp -a /usr/local/rustup /toolchain/rustup

# env.sh for runtime setup
RUN printf '#!/bin/sh\nexport RUSTUP_HOME=/opt/eve/toolchains/rust/rustup\nexport CARGO_HOME=/opt/eve/toolchains/rust/cargo\nexport PATH="${CARGO_HOME}/bin:${PATH}"\n' > /toolchain/env.sh

FROM busybox:stable
COPY --from=build /toolchain /toolchain
