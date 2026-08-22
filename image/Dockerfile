# The signalk-jukebox container image (ARCHITECTURE.md §2.4): Mopidy +
# Iris + Snapserver in one image.
#
# NOT BUILD-TESTED. No container runtime is available in the environment
# this was written in (no docker/podman). Package names, repo URLs, and
# version pins below are believed correct as of this writing but have not
# been verified by an actual `docker build`. Before relying on this in
# CI, do a real build and fix whatever it surfaces -- treat this as a
# strong first draft, not a working artifact.
#
# Known-uncertain pieces, flagged inline where they occur:
#   - mopidy-spotify's `gst-plugins-spotify` native dependency (a Rust
#     GStreamer plugin, not a apt/pip package as of the research in
#     SPEC.md §13) -- install mechanism needs verifying against
#     mopidy-spotify's current docs at build time, not assumed here.
#   - Exact current Snapcast/shairport-sync package availability for
#     bookworm -- pin versions via build args so they're easy to bump
#     without re-deriving this file.

FROM debian:bookworm-slim AS base

ARG SNAPCAST_VERSION=0.35.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# --- Base tooling + Mopidy (official apt.mopidy.com repo) ----------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg apt-transport-https gettext-base \
        python3 python3-pip python3-venv \
        gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly \
        gstreamer1.0-plugins-bad gstreamer1.0-alsa \
    && curl -fsSL https://apt.mopidy.com/mopidy.gpg -o /usr/share/keyrings/mopidy-archive-keyring.gpg \
    && curl -fsSL https://apt.mopidy.com/bookworm.list -o /etc/apt/sources.list.d/mopidy.list \
    && apt-get update && apt-get install -y --no-install-recommends mopidy \
    && rm -rf /var/lib/apt/lists/*

# --- Mopidy extensions -----------------------------------------------------
# mopidy-local: bundled with mopidy since Mopidy 3 split it out -- installed
# via pip like the rest of the extension set below, not assumed present.
# mopidy-tunein: internet radio (SPEC.md §12 decision -- no credentials).
# mopidy-spotify: SPEC.md §5, §13 -- currently degraded upstream
# (mopidy-spotify#437, open login5 issue); shipped anyway since the
# extension itself works, playback auth is the broken part, and that's a
# runtime/account issue, not a build-time one.
RUN pip install --no-cache-dir --break-system-packages \
        Mopidy-Local \
        Mopidy-TuneIn \
        Mopidy-Spotify \
        Mopidy-Iris

# TODO(verify): Mopidy-Spotify also needs `gst-plugins-spotify` (a Rust
# GStreamer plugin wrapping librespot) as of the v5.0.0 rewrite -- this is
# NOT a standard apt/pip package. Check mopidy-spotify's current README
# for the actual install recipe (likely a prebuilt binary release or a
# `cargo install` build step) before shipping -- not stubbed further here
# because guessing wrong would be worse than leaving it a visible gap.

# --- Snapserver (GitHub release .deb) --------------------------------------
# Pinned >= 0.33.0 deliberately (SPEC.md §13, ARCHITECTURE.md §5): the
# version where the `stream.sandbox_dir` mechanism replaced the earlier
# v0.31.0-v0.32.x process-stream RPC restriction, letting the plugin
# create/remove per-zone `airplay://` streams at runtime instead of
# pre-declaring a fixed pool at container start (SPEC.md §6.4).
RUN ARCH_SUFFIX="$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "amd64")" \
    && curl -fsSL -o /tmp/snapserver.deb \
        "https://github.com/snapcast/snapcast/releases/download/v${SNAPCAST_VERSION}/snapserver_${SNAPCAST_VERSION}-1_${ARCH_SUFFIX}_bookworm.deb" \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/snapserver.deb \
    && rm -f /tmp/snapserver.deb && rm -rf /var/lib/apt/lists/*
# TODO(verify): confirm this exact asset-filename pattern against the
# actual v0.35.0 release page -- snapcast/snapcast's release asset naming
# has changed across versions historically (per the CVE-era changes
# researched in SPEC.md §13), don't assume it's stable across future
# bumps of SNAPCAST_VERSION without checking.

# --- shairport-sync (AirPlay receiver Snapserver's `airplay` stream type
# spawns) -- apt package if bookworm ships one recent enough for the
# metadata-pipe feature this plugin depends on (SPEC.md §6.4); otherwise
# needs building from source. Not verified which applies here.
RUN apt-get update && apt-get install -y --no-install-recommends shairport-sync \
    && rm -rf /var/lib/apt/lists/*
# TODO(verify): confirm the apt-shipped shairport-sync version supports
# `--metadata-enable`/`--metadata-pipename` (long-standing feature, likely
# fine, but not confirmed against bookworm's specific package version).

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY mopidy.conf.template /app/mopidy.conf.template
COPY snapserver.conf.template /app/snapserver.conf.template
RUN chmod +x /app/entrypoint.sh

# Mopidy HTTP/JSON-RPC + Iris (ARCHITECTURE.md §2.2 reverse-proxies this).
# Snapcast stream (1704) / control (1705) ports deliberately NOT exposed
# here -- container.ts's signalkAccessiblePorts only lists 6680 (SPEC.md
# §6, security note); Snapcast reaches the LAN through signalk-container's
# own networking, not this Dockerfile.
EXPOSE 6680

ENTRYPOINT ["/app/entrypoint.sh"]
