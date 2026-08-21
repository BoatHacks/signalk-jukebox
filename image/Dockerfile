# The signalk-jukebox container image (ARCHITECTURE.md §2.4): Mopidy +
# Iris + Snapserver in one image, with Snapserver's AirPlay stream pool
# (SPEC.md §6.4) statically declared at build/start time.
#
# TODO(implementation): not built yet. This is a placeholder marking where
# the image lives, per ARCHITECTURE.md §7's file structure. Needs, at
# minimum:
#   - Mopidy + mopidy-local + mopidy-tunein (or chosen radio extension,
#     SPEC.md §13 open question) + mopidy-spotify, all installed but
#     individually toggled via env/config at container start (SPEC.md §2).
#   - Iris installed as Mopidy's web frontend.
#   - Snapserver, configured with Mopidy's output as its "jukebox" stream
#     source, plus `airplay.maxZones` statically-declared airplay-type
#     streams (SPEC.md §6.4) -- the pool size needs to be baked into the
#     generated snapserver.conf from JUKEBOX_AIRPLAY_MAX_ZONES (see
#     src/container.ts's buildConfig env vars).
#   - An entrypoint script that renders snapserver.conf and mopidy.conf
#     from mopidy.conf.template + env vars before starting both processes.

FROM debian:bookworm-slim

# TODO: everything below.
