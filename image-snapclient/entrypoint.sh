#!/bin/sh
# Local snapclient entrypoint (SPEC.md §9, §12; src/local-snapclient.ts
# builds the env this reads). Connects to the main jukebox container's
# Snapcast stream port and plays through this host's own sound card --
# for a boat with speakers wired directly to the SignalK server machine,
# not a separate physical Snapclient device.

set -e

if [ -z "${SNAPCAST_HOST:-}" ]; then
  echo "SNAPCAST_HOST is required (host:port of the jukebox container's published Snapcast stream port)" >&2
  exit 1
fi

if [ -z "${SOUND_CARD:-}" ]; then
  echo "SOUND_CARD is required (an ALSA device string, e.g. plughw:CARD=wm8960soundcard,DEV=0 -- see this host's 'aplay -L' output)" >&2
  exit 1
fi

SNAPCAST_PORT="${SNAPCAST_PORT:-1704}"

exec snapclient "tcp://${SNAPCAST_HOST}:${SNAPCAST_PORT}" \
  --soundcard "${SOUND_CARD}" \
  --logsink=stdout
