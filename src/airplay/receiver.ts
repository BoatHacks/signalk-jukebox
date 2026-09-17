// AirPlay device naming (SPEC.md §6.4, §9). A single, statically-declared
// AirPlay input (snapserver.conf.template's own `source = airplay://...`
// line, container.ts's JUKEBOX_AIRPLAY_DEVICENAME env var) rather than a
// per-zone receiver -- confirmed live that a per-zone auto-provisioned
// design (an earlier version of this module) works, but isn't what's
// wanted: one AirPlay input, manually assignable to any zone (src/
// routes.ts's /source endpoint) or folded into MusicAndAlerts, not one
// receiver per physical speaker cluttering the AirPlay picker with an
// entry per zone.

export function receiverName(
  pattern: string,
  boatName: string,
  zoneName: string,
): string {
  return pattern
    .replace("{boatName}", boatName)
    .replace("{zoneName}", zoneName);
}
