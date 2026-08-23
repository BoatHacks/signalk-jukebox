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

# A fixed, known Snapcast client id -- NOT the display name (that's
# Client.SetName, set server-side by src/local-snapclient.ts once this
# client connects). --hostID only overrides `client.id`, confirmed by
# hand: it has no effect on `client.host.name`, which is what Snapcast
# falls back to displaying when config.name is unset -- an unpredictable
# podman-assigned container hostname (e.g. "16684a3df93c"), not something
# --hostID fixes on its own. Having a fixed, known id here is what lets
# the plugin find "the" local snapclient's zone deterministically to rename
# it, since there is always exactly one of these per plugin instance.
exec snapclient "tcp://${SNAPCAST_HOST}:${SNAPCAST_PORT}" \
  --soundcard "${SOUND_CARD}" \
  --hostID jukebox-local-snapclient \
  --logsink=stdout
