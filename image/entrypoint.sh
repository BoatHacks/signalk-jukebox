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

# /data is mounted persistently by container.ts (dataMount, resolveMount
# against this plugin's own app.getDataDirPath()) -- Mopidy's own data_dir
# (mopidy.conf.template) and Snapserver's datadir (snapserver.conf.template,
# server.json: client/group registration, volume, mute, and each zone's
# current stream assignment) both live under it, so both now survive a
# real container recreate, not just a plain restart of the same container.
mkdir -p /data /data/snapserver /cache /app/sandbox /var/run/dbus

# /run (and so /var/run/dbus) is part of this container's writable layer,
# not a tmpfs reset on every start -- a `podman start` (as opposed to a
# fresh `podman run`) reuses it as-is. An ungraceful stop (OOM, SIGKILL,
# host reboot) leaves dbus-daemon's own pidfile behind with no process to
# match it; the next boot's `dbus-daemon --system --fork` then refuses to
# start at all ("pid file ... exists"), taking the whole entrypoint down
# with it under `set -e`. Confirmed on halpi2's sk-jukebox container after
# exactly this kind of restart. Harmless to remove unconditionally: a
# fresh container has no such file, and dbus-daemon recreates it itself on
# a successful start.
rm -f /run/dbus/pid

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

# Silence stream (SPEC.md §6, §12) -- a zone parked here (routes.ts's
# /source endpoint, "silence") hears literally nothing, not even
# announcements, e.g. a sleeping cabin. All-zero bytes are digital silence
# in S16LE PCM, so `cat /dev/zero` into this FIFO is a genuine, real audio
# source Snapserver reads continuously -- no synth/audio tooling needed.
# Paced by the FIFO's own kernel buffer: `cat` blocks once it fills
# (~64KB default), resuming only as Snapserver actually reads, so this
# naturally matches playback speed without the writer needing to know the
# sample rate at all. Started before snapserver so its `pipe://` reader
# doesn't block waiting for a writer to open the other end.
rm -f /tmp/silencefifo
mkfifo /tmp/silencefifo
cat /dev/zero > /tmp/silencefifo &
SILENCE_PID=$!

envsubst < /app/mopidy.conf.template > /data/mopidy.conf
envsubst < /app/snapserver.conf.template > /etc/snapserver.conf

snapserver --config /etc/snapserver.conf &
SNAPSERVER_PID=$!
trap 'kill "$SNAPSERVER_PID" "$SILENCE_PID" 2>/dev/null || true' TERM INT EXIT

exec mopidy --config /data/mopidy.conf
