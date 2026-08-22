# signalk-jukebox-snapclient (ARCHITECTURE.md §2.4-adjacent): a minimal
# standalone Snapcast client, published as its own image so the plugin can
# optionally run one on the same host as the SignalK server itself --
# "local snapclient" (SPEC.md §9, §12) -- for a boat with speakers wired
# directly to that machine's own sound card, without requiring a separate
# physical Snapclient device.
#
# Same base and Snapcast version pin as image/Dockerfile, for the same
# reason (confirmed by build-testing, ARCHITECTURE.md §2.4): trixie ships
# a modern-enough Snapcast release; the exact `_<arch>_trixie.deb` asset
# naming is confirmed against the real release page.

FROM debian:trixie-slim

ARG SNAPCAST_VERSION=0.35.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates alsa-utils \
    && ARCH_SUFFIX="$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64")" \
    && curl -fsSL -o /tmp/snapclient.deb \
        "https://github.com/snapcast/snapcast/releases/download/v${SNAPCAST_VERSION}/snapclient_${SNAPCAST_VERSION}-1_${ARCH_SUFFIX}_trixie.deb" \
    && apt-get install -y --no-install-recommends /tmp/snapclient.deb \
    && rm -f /tmp/snapclient.deb && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
