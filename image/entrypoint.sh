#!/bin/sh
# Container entrypoint (ARCHITECTURE.md §2.4, §7). NOT verified against a
# real build/run -- no container runtime was available when this was
# written. Renders both config templates, wires up the Mopidy->Snapserver
# audio pipe and the AirPlay sandbox dir, then runs both processes.
#
# TODO(verify): the two-process supervision below (background Snapserver,
# foreground Mopidy, trap-based cleanup) is a minimal first draft, not a
# real process supervisor -- signal handling for a PID-1 process with two
# children is easy to get subtly wrong. Consider replacing with a proper
# supervisor (s6, dumb-init + a small wrapper, or similar) before relying
# on clean shutdown/restart behavior in production.

set -e

mkdir -p /data /cache /app/sandbox

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
