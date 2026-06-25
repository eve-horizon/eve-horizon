FROM eclipse-temurin:21-jdk-jammy AS build
RUN mkdir -p /toolchain && cp -a /opt/java/openjdk /toolchain/jdk

# env.sh for runtime setup
RUN printf '#!/bin/sh\nexport JAVA_HOME=/opt/eve/toolchains/java/jdk\nexport PATH="${JAVA_HOME}/bin:${PATH}"\n' > /toolchain/env.sh

FROM busybox:stable
COPY --from=build /toolchain /toolchain
