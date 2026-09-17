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
ARG SNAPWEB_VERSION=0.9.3
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

# --- Snapweb (official web GUI for Snapserver, ARCHITECTURE.md §2.4) ------
# A prebuilt static app (architecture-independent `_all.deb`, unlike
# Snapserver's own per-arch package above) -- confirmed against the actual
# v0.9.3 release page. Installs to /usr/share/snapweb; snapserver.conf.
# template's `[http]` section points `doc_root` there, so Snapserver serves
# it itself alongside its own JSON-RPC control endpoint on the same port --
# no separate web server or reverse proxy needed.
RUN curl -fsSL -o /tmp/snapweb.deb \
        "https://github.com/snapcast/snapweb/releases/download/v${SNAPWEB_VERSION}/snapweb_${SNAPWEB_VERSION}-1_all.deb" \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/snapweb.deb \
    && rm -f /tmp/snapweb.deb && rm -rf /var/lib/apt/lists/*

# --- shairport-sync + nqptp (AirPlay receiver Snapserver's `airplay`
# stream type spawns) -- built from source, not trixie's own apt package
# (4.3.7-1): that package has no AirPlay 2 support at all, and recent iOS
# versions have progressively stopped listing AirPlay-1-only ("classic")
# receivers in the Control Center picker (confirmed against a real iOS 26
# device: the zone simply never appeared). AirPlay 2 needs shairport-sync
# built with --with-airplay-2 plus nqptp, its companion PTP clock-sync
# daemon -- one nqptp instance total, not one per zone, shared by every
# AirPlay-2-mode shairport-sync process (spawned per zone by Snapserver)
# over POSIX shared memory; started once in entrypoint.sh, matching this
# image's existing dbus-daemon/avahi-daemon singleton pattern.
#
# Pinned tags (confirmed building clean on aarch64/trixie): shairport-sync
# 5.5.2, nqptp 1.2.8. --with-airplay-2 pulls in a real FFmpeg dependency
# (libavcodec/libavformat/libavutil, for AirPlay 2's audio decoding) not
# needed by the classic-only build -- a meaningfully heavier dependency
# set than the apt package had, confirmed by build-testing. Build-only
# packages are purged after `make install` so they don't inflate the
# final image; this Dockerfile is still single-stage (SPEC.md's deferred
# multi-stage rework covers the rest of the image, not just this one
# component).
ARG SHAIRPORT_SYNC_VERSION=5.5.2
ARG NQPTP_VERSION=1.2.8
# dbus-daemon and avahi-daemon themselves (as opposed to their client
# libraries, e.g. libavahi-client3, which the linked binary pulls in on
# its own) were never installed directly anywhere in this file -- the
# apt shairport-sync package this replaces pulled both in transitively as
# its own dependencies. Confirmed by build-testing: dropping that apt
# package silently left avahi-daemon (the actual daemon binary
# entrypoint.sh runs) missing entirely, failing with "avahi-daemon:
# command not found" at container start. dbus-daemon happened to survive
# only because something else in this same install still pulls it in
# transitively -- listed explicitly below too so that isn't relied on.
RUN apt-get update && apt-get install -y --no-install-recommends \
        avahi-daemon dbus \
        build-essential git autoconf automake libtool pkg-config \
        libpopt-dev libconfig-dev libavahi-client-dev libssl-dev \
        libsoxr-dev libplist-dev libsodium-dev libgcrypt20-dev uuid-dev \
        xxd libplist-utils libglib2.0-dev \
        libavutil-dev libavcodec-dev libavformat-dev \
    && cd /tmp \
    && git clone --branch "${NQPTP_VERSION}" --depth 1 \
        https://github.com/mikebrady/nqptp.git \
    && cd nqptp && autoreconf -fi && ./configure && make -j"$(nproc)" \
    && make install \
    && cd /tmp \
    && git clone --branch "${SHAIRPORT_SYNC_VERSION}" --depth 1 \
        https://github.com/mikebrady/shairport-sync.git \
    && cd shairport-sync && autoreconf -fi \
    && ./configure \
        --with-avahi --with-ssl=openssl --with-soxr --with-metadata \
        --with-stdout --with-pipe --with-dbus-interface \
        --with-mpris-interface --with-airplay-2 \
    && make -j"$(nproc)" && make install \
    && cd / && rm -rf /tmp/nqptp /tmp/shairport-sync \
    && apt-get purge -y --auto-remove \
        build-essential git autoconf automake libtool pkg-config \
    && rm -rf /var/lib/apt/lists/*
# Only the build toolchain above is purged, not the -dev packages
# themselves -- confirmed by build-testing that purging those too
# (e.g. libavutil-dev) makes apt's --auto-remove treat their pulled-in
# runtime libraries (libswresample.so.5, etc.) as orphaned and delete
# them as well, since apt has no idea the manually-built shairport-sync
# binary still links against them at runtime. The extra header-only
# weight from keeping the -dev packages is a smaller tradeoff than that
# breakage; a real image-size pass (already deferred, see this file's
# other comments) would replace this whole approach with a multi-stage
# build instead.

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
