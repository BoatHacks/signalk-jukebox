#!/bin/bash
# Container entrypoint (ARCHITECTURE.md §2.4, §7). Renders both config
# templates, wires up the Mopidy->Snapserver audio pipe, then runs
# Snapserver/Mopidy under real supervision (see the bottom of this file).
#
# bash, not sh: `wait -n` below is a bashism (Debian's dash has no
# equivalent) and is the only portable-enough way to block on "whichever
# of these background jobs exits first" without a real init/supervisor
# dependency.

set -e

# Rapid-exit-loop detection for mopidy's respawn below (see the bottom of
# this file), mirroring signalk-jukebox-wyoming-bridge's own
# startSnapclient()/nextRapidExitState() pattern (bridge.mjs) for the same
# problem: respawn a crashed child in place rather than always treating its
# exit as fatal, but stop respawning (and fall back to the old
# whole-container-restart behavior) if it's crashing immediately, over and
# over, since that's a real broken state no amount of respawning fixes.
# `next_rapid_exit_state` is a pure function specifically so it can be
# sourced and unit-tested without actually running mopidy (see
# test/entrypoint-mopidy-respawn.test.ts).
# Whole seconds, not bridge.mjs's milliseconds: `date +%s%3N` (the obvious
# ms-precision equivalent) is a GNU date extension -- BSD date (macOS,
# where plugin-ci's cross-platform test matrix also runs this repo's own
# `npm test`, unlike the container image itself which is always Debian) just
# emits the literal "N" instead of substituting it, breaking the arithmetic
# below outright. Second precision is still plenty to tell "crashed
# instantly" from "ran for a while" against a 3-second threshold.
RAPID_EXIT_THRESHOLD_S=3
MAX_CONSECUTIVE_RAPID_EXITS=5

# Prints "<new count> <give_up:0|1>" for the given run duration (whole
# seconds) and previous consecutive-rapid-exit count. A run lasting at
# least RAPID_EXIT_THRESHOLD_S resets the count to 0, same as
# nextRapidExitState's `ranMs < RAPID_EXIT_THRESHOLD_MS` check.
next_rapid_exit_state() {
  local ran_s="$1" previous_count="$2" count give_up
  if [ "$ran_s" -lt "$RAPID_EXIT_THRESHOLD_S" ]; then
    count=$((previous_count + 1))
  else
    count=0
  fi
  give_up=0
  if [ "$count" -ge "$MAX_CONSECUTIVE_RAPID_EXITS" ]; then
    give_up=1
  fi
  echo "$count $give_up"
}

# Mopidy is supervised in its own loop, not just backgrounded once like
# Snapserver: confirmed live on halpi2, 2026-09-22, that a single
# mislabeled internet-radio stream aborting mopidy (SIGABRT, a gstav1parse
# assertion -- see Dockerfile's GST_PLUGIN_FEATURE_RANK comment, which
# closes off that specific bug too) took the whole container down with it
# via the `wait -n`/exit below, silencing Snapserver and every zone
# (MopidyOnly, Alerts, Silence, MusicAndAlerts alike) even though only
# mopidy itself was actually broken. A single bad stream has nothing to do
# with whether Snapserver or audio distribution is healthy, so it shouldn't
# be able to take either down. `supervise_mopidy` respawns mopidy in place
# on any exit, using the same rapid-exit-loop/give-up logic as
# signalk-jukebox-wyoming-bridge's snapclient respawn (bridge.mjs) -- only
# a genuinely broken, immediately-crash-looping mopidy falls through to the
# old fatal behavior in the main body below.
#
# `supervise_mopidy` runs as a backgrounded subshell, which gets its own
# copy of every variable -- it can't just set MOPIDY_PID/SHUTTING_DOWN and
# have the caller's shell see the update. Two small files stand in for that
# shared state instead: MOPIDY_PID_FILE always holds the currently-running
# mopidy's pid (so a caller can kill the *current* one, not a stale pid
# captured before the first respawn), and MOPIDY_SHUTDOWN_FLAG's mere
# existence tells the loop to stop respawning and exit cleanly instead.
# Overridable via env (defaults unchanged in the real container) so
# test/entrypoint-mopidy-respawn.test.ts can point `supervise_mopidy` at
# per-test paths instead of the real /tmp ones.
MOPIDY_PID_FILE="${MOPIDY_PID_FILE:-/tmp/mopidy.pid}"
MOPIDY_SHUTDOWN_FLAG="${MOPIDY_SHUTDOWN_FLAG:-/tmp/mopidy.shutting-down}"

supervise_mopidy() {
  local rapid_exit_count=0 started_at ran_s status count give_up pid
  while true; do
    started_at=$(date +%s)
    mopidy --config /data/mopidy.conf &
    pid=$!
    echo "$pid" > "$MOPIDY_PID_FILE"
    # `set -e` (inherited from the parent shell) would otherwise abort this
    # whole subshell right at `wait`, the instant mopidy exits nonzero --
    # skipping the respawn below entirely and silently leaving mopidy dead
    # with nothing watching it, the exact opposite of this function's job.
    set +e
    wait "$pid"
    status=$?
    set -e
    if [ -e "$MOPIDY_SHUTDOWN_FLAG" ]; then
      return 0
    fi
    ran_s=$(( $(date +%s) - started_at ))
    read -r count give_up < <(next_rapid_exit_state "$ran_s" "$rapid_exit_count")
    rapid_exit_count="$count"
    if [ "$give_up" = "1" ]; then
      echo "mopidy exited ($status) $count times in a row within ${RAPID_EXIT_THRESHOLD_S}s of starting; giving up and exiting to restart the whole container" >&2
      return "$status"
    fi
    echo "mopidy exited ($status) after ${ran_s}s; respawning in place" >&2
  done
}

stop_mopidy_supervisor() {
  touch "$MOPIDY_SHUTDOWN_FLAG"
  kill "$(cat "$MOPIDY_PID_FILE" 2>/dev/null)" 2>/dev/null || true
}

# Everything below only runs when this script is actually executed (the
# container's real entrypoint), not when it's sourced by the test above to
# reach the functions above in isolation.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0
fi

# /data is mounted persistently by container.ts (dataMount, resolveMount
# against this plugin's own app.getDataDirPath()) -- Mopidy's own data_dir
# (mopidy.conf.template) and Snapserver's datadir (snapserver.conf.template,
# server.json: client/group registration, volume, mute, and each zone's
# current stream assignment) both live under it, so both now survive a
# real container recreate, not just a plain restart of the same container.
mkdir -p /data /data/snapserver /cache /data/playlists

# Seed the default internet-radio playlist once, on first run only --
# never overwrite it on a later start, so a user's own edits (adding/
# removing stations via Mopidy-MusicBox-Webclient) survive a container
# recreate instead of being clobbered back to the shipped default. Gated
# on JUKEBOX_RADIO_ENABLED (settings.backends.radio.enabled) the same as
# every other backend toggle -- if radio is off, don't seed it; turning
# it on later seeds it at that point instead.
if [ "$JUKEBOX_RADIO_ENABLED" = "true" ] && [ ! -f /data/playlists/internet-radio.m3u ]; then
  cp /app/default-playlists/internet-radio.m3u /data/playlists/internet-radio.m3u
fi

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

rm -f "$MOPIDY_PID_FILE" "$MOPIDY_SHUTDOWN_FLAG"
supervise_mopidy &
MOPIDY_SUPERVISOR_PID=$!

# Real supervision, not `exec mopidy`: that used to replace this shell
# as PID 1, so a killed Snapserver (confirmed live on halpi2,
# 2026-09-11: repeated OOM kills, anon-rss ~450-470MB against this
# container's 512m cap) became a permanent zombie nothing noticed or
# restarted -- Mopidy alone kept the container looking "Up" and healthy
# while audio distribution was silently dead. `wait -n` blocks for
# whichever of Snapserver or the mopidy supervisor (see the functions
# above) exits first; either way this script then exits too, taking the
# container down with it so podman's own `restart: unless-stopped` policy
# (container.ts's buildConfig) recreates a clean instance instead of the
# crash going undetected. The mopidy supervisor only ever exits on its own
# for the give-up case in `supervise_mopidy` (a genuinely crash-looping
# mopidy) or when this trap below tells it to stop respawning -- a single
# ordinary mopidy crash never reaches this `wait -n` at all.
trap 'stop_mopidy_supervisor; kill "$SNAPSERVER_PID" "$SILENCE_PID" "$MOPIDY_SUPERVISOR_PID" 2>/dev/null || true' TERM INT

# `set -e` would otherwise abort this script right at `wait -n` the
# instant either child exits nonzero (e.g. OOM-killed), skipping the
# cleanup and explicit exit below -- suspend it just for this one call.
set +e
wait -n "$SNAPSERVER_PID" "$MOPIDY_SUPERVISOR_PID"
STATUS=$?
set -e

stop_mopidy_supervisor
kill "$SNAPSERVER_PID" "$SILENCE_PID" "$MOPIDY_SUPERVISOR_PID" 2>/dev/null || true
exit "$STATUS"
