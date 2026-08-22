#!/bin/sh
# Container entrypoint (ARCHITECTURE.md §2.4, §7). Renders both config
# templates, wires up the Mopidy->Snapserver audio pipe and the AirPlay
# sandbox dir, then runs both processes.
#
# TODO(verify): the two-process supervision below (background Snapserver,
# foreground Mopidy, trap-based cleanup) is a minimal first draft, not a
# real process supervisor -- signal handling for a PID-1 process with two
# children is easy to get subtly wrong. Consider replacing with a proper
# supervisor (s6, dumb-init + a small wrapper, or similar) before relying
# on clean shutdown/restart behavior in production.

set -e

mkdir -p /data /cache /app/sandbox /var/run/dbus

# shairport-sync hard-requires a working Avahi client to advertise itself
# over mDNS -- confirmed by build-testing (SPEC.md §13): without this, it
# refuses to start at all ("fatal error: Could not establish mDNS
# advertisement!") and Snapcast's airplay stream type retries it in a
# tight crash loop, spawning zombie processes every ~100ms. avahi-daemon
# itself needs the D-Bus system bus present first.
dbus-daemon --system --fork
avahi-daemon --no-chroot -D

# Snapserver's runtime-created airplay:// streams (SPEC.md §6.4, §13) must
# reference an executable inside sandbox_dir -- copied, not symlinked, to
# avoid any ambiguity in how the containment check resolves symlinks.
cp "$(command -v shairport-sync)" /app/sandbox/shairport-sync

# Mopidy -> Snapserver audio pipe (mopidy.conf.template's [audio] output,
# snapserver.conf.template's [stream] source).
rm -f /tmp/snapfifo
mkfifo /tmp/snapfifo

envsubst < /app/mopidy.conf.template > /data/mopidy.conf
envsubst < /app/snapserver.conf.template > /etc/snapserver.conf

snapserver --config /etc/snapserver.conf &
SNAPSERVER_PID=$!
trap 'kill "$SNAPSERVER_PID" 2>/dev/null || true' TERM INT EXIT

exec mopidy --config /data/mopidy.conf
