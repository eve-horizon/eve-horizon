FROM eclipse-temurin:21-jdk-jammy AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && curl -sSL https://github.com/JetBrains/kotlin/releases/download/v2.0.21/kotlin-compiler-2.0.21.zip -o /tmp/kotlin.zip \
    && mkdir -p /tmp/kotlin && unzip -q /tmp/kotlin.zip -d /tmp/kotlin \
    && mkdir -p /toolchain/kotlin/bin /toolchain/kotlin/lib /toolchain/jdk \
    && cp -a /tmp/kotlin/kotlinc/bin/* /toolchain/kotlin/bin/ \
    && cp -a /tmp/kotlin/kotlinc/lib/* /toolchain/kotlin/lib/ \
    && cp -a /opt/java/openjdk/* /toolchain/jdk/ \
    && rm -rf /tmp/kotlin /tmp/kotlin.zip /var/lib/apt/lists/*

# env.sh for runtime setup (JAVA_HOME from kotlin takes precedence)
RUN printf '#!/bin/sh\nexport JAVA_HOME=/opt/eve/toolchains/kotlin/jdk\nexport PATH="/opt/eve/toolchains/kotlin/kotlin/bin:${JAVA_HOME}/bin:${PATH}"\n' > /toolchain/env.sh

FROM busybox:stable
COPY --from=build /toolchain /toolchain
