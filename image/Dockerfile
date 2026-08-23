# The signalk-jukebox container image (ARCHITECTURE.md §2.4): Mopidy +
# Mopidy-MusicBox-Webclient + Snapserver in one image.
#
# Base is Debian trixie, not bookworm: Mopidy 4.x (required by the current
# Mopidy-Spotify 5.0.0, which requires mopidy>=4.0.0) itself requires
# Python >= 3.13, which bookworm doesn't ship (3.11) and trixie does
# (3.13). apt.mopidy.com is not used at all -- confirmed by build-testing
# that its repo (both bookworm and trixie dists) is stuck serving Mopidy
# 3.4.2, which forces pip's resolver down to the old pyspotify/libspotify-
# based Mopidy-Spotify 4.1.1 (the deprecated backend SPEC.md §13 already
# flagged, not the "gst-plugins-spotify Rust plugin" version this file
# previously guessed at -- that concern turned out to be moot, 5.0.0 has
# no native dependency at all). Mopidy and every extension below come from
# PyPI instead, resolving cleanly together on Python 3.13.
#
# No Mopidy-Iris, no Mopidy-TuneIn: confirmed by build-testing that both
# still call Mopidy-3-era internals (`mopidy.internal`,
# `mopidy.models.serialize`) that Mopidy 4 removed -- Iris tracks this as
# an open, unresolved upstream issue (jaedb/Iris#999), and TuneIn crashes
# identically. TuneIn (station directory/search) is dropped outright:
# Mopidy's built-in `stream` extension already plays any http(s) audio URL
# with no extension at all, which is most of what TuneIn added on top of;
# only the searchable station directory is lost.
#
# Iris is replaced by Mopidy-MusicBox-Webclient (registers via the same
# `http:app` mechanism Iris itself uses, at /musicbox_webclient/) -- unlike
# Iris/TuneIn, confirmed by build-testing (and a GitHub code search of its
# whole repo) that it does NOT touch mopidy.internal/models.serialize
# anywhere, so it loads cleanly against Mopidy 4. It hits one separate,
# unrelated break instead: its __init__.py does `import pkg_resources` for
# its own version string, and setuptools >= 80 (current PyPI) dropped
# pkg_resources entirely -- confirmed by build-testing both that setuptools
# 84.0.0 lacks it (ModuleNotFoundError, extension fails to load) and that
# 79.0.1 still has it (loads cleanly). Pinned below for exactly that reason;
# lift the pin if a future Mopidy-MusicBox-Webclient release drops the
# pkg_resources import (its own upstream has had no real commit since
# 2020-06-23, so don't expect that soon).
#
# Its web UI is entirely WebSocket-driven (Mopidy.js /mopidy/ws, confirmed
# by reading its whole JS source: zero HTTP/AJAX fallback anywhere) --
# unlike the polling-based UI it replaces, it can't be reached through this
# plugin's own reverse proxy (proxy.ts can't forward a WS upgrade; see that
# file). container.ts instead publishes MOPIDY_PORT directly to the LAN
# (0.0.0.0), and the config panel links straight at that -- bypassing
# SignalK's own auth for this port, an accepted trade-off (Mopidy has none
# of its own either way; see container.ts's own comment on this).

FROM debian:trixie-slim AS base

ARG SNAPCAST_VERSION=0.35.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# --- Base tooling + GStreamer/gi bindings for Mopidy -----------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gettext-base \
        python3 python3-pip python3-venv python3-gi python3-gst-1.0 \
        gir1.2-gst-plugins-base-1.0 gir1.2-gstreamer-1.0 \
        gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly \
        gstreamer1.0-plugins-bad gstreamer1.0-alsa \
    && rm -rf /var/lib/apt/lists/*

# --- Mopidy + extensions (all from PyPI, see base-image note above) -------
# mopidy-local: bundled with mopidy since Mopidy 3 split it out -- installed
# via pip like the rest of the extension set below, not assumed present.
# mopidy-spotify: SPEC.md §5, §13 -- currently degraded upstream
# (mopidy-spotify#437, open login5 issue); shipped anyway since the
# extension itself works, playback auth is the broken part, and that's a
# runtime/account issue, not a build-time one.
RUN pip install --no-cache-dir --break-system-packages \
        Mopidy \
        Mopidy-Local \
        Mopidy-Spotify

# --- Web client (Mopidy-MusicBox-Webclient) -- see base-image note above --
# setuptools<80 pinned first: Mopidy-MusicBox-Webclient's __init__.py does
# `import pkg_resources`, which setuptools>=80 no longer ships.
RUN pip install --no-cache-dir --break-system-packages \
        "setuptools<80" \
        Mopidy-MusicBox-Webclient

# --- Snapserver (GitHub release .deb) --------------------------------------
# Pinned >= 0.33.0 deliberately (SPEC.md §13, ARCHITECTURE.md §5): the
# version where the `stream.sandbox_dir` mechanism replaced the earlier
# v0.31.0-v0.32.x process-stream RPC restriction, letting the plugin
# create/remove per-zone `airplay://` streams at runtime instead of
# pre-declaring a fixed pool at container start (SPEC.md §6.4). Asset
# filename pattern (`_<arch>_trixie.deb`) confirmed against the actual
# v0.35.0 release page for both amd64 and arm64.
RUN ARCH_SUFFIX="$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64")" \
    && curl -fsSL -o /tmp/snapserver.deb \
        "https://github.com/snapcast/snapcast/releases/download/v${SNAPCAST_VERSION}/snapserver_${SNAPCAST_VERSION}-1_${ARCH_SUFFIX}_trixie.deb" \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/snapserver.deb \
    && rm -f /tmp/snapserver.deb && rm -rf /var/lib/apt/lists/*

# --- shairport-sync (AirPlay receiver Snapserver's `airplay` stream type
# spawns) -- confirmed available via trixie's own apt repo (4.3.7-1), well
# past the metadata-pipe feature's introduction.
RUN apt-get update && apt-get install -y --no-install-recommends shairport-sync \
    && rm -rf /var/lib/apt/lists/*

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
