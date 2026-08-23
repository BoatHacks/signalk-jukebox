import React, { useState } from "react";
import {
  panelStyles as S,
  SectionTitle,
  StatusCard,
  FieldRow,
  Hint,
  VersionSelect,
  UpdateControls,
  CollapsibleSection,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";
import { mergeSettings, type PluginSettings, type Zone } from "../types.js";

// Custom config panel (ARCHITECTURE.md §7, signalk-container-helper's own
// documented Module Federation pattern) -- replaces the auto-generated
// JSON-schema form the plugin's `schema()` export still provides as a
// fallback (index.ts keeps both; nothing depends on only one existing).

const BASE = "/plugins/signalk-jukebox";

interface PlaybackStatus {
  state?: string;
  track?: { name?: string; artist?: string };
  volume?: number;
  muted?: boolean;
}

interface Props {
  configuration: Partial<PluginSettings> | null;
  save: (config: PluginSettings) => void;
}

export default function PluginConfigurationPanel({
  configuration,
  save,
}: Props) {
  const [cfg, setCfg] = useState<Partial<PluginSettings>>(configuration ?? {});
  const [saved, setSaved] = useState("");

  const { status, loading } = useStatusPoll<PlaybackStatus>(
    `${BASE}/api/status`,
    { fallback: {} },
  );
  const versions = useVersions(`${BASE}/api/versions`);
  const { status: zones } = useStatusPoll<Zone[]>(`${BASE}/api/zones`, {
    fallback: [],
  });
  const { status: satellites } = useStatusPoll<{ ids: string[] }>(
    `${BASE}/api/satellites`,
    { fallback: { ids: [] } },
  );

  const reachable = status !== null;
  const trackName = status?.track?.name;

  // mergeSettings deep-merges each nested group against SCHEMA_DEFAULTS --
  // the same function index.ts uses server-side. Required here too, not
  // just a shallow `cfg.backends ?? {...defaults}`: a saved config can be
  // *partially* populated (e.g. backends.local set from an older save,
  // backends.spotify never written at all), and a shallow per-group `??`
  // only guards a group being entirely absent, not one of its own
  // nested fields -- confirmed by a real crash report ("Cannot read
  // properties of undefined (reading 'enabled')") reading
  // backends.spotify.enabled when backends existed but backends.spotify
  // didn't.
  const merged = mergeSettings(cfg);
  const { backends, n2k, airplay, vhf, voiceDucking, localSnapclient } = merged;

  const patch = (next: Partial<PluginSettings>) =>
    setCfg((prev) => ({ ...prev, ...next }));

  return (
    <div style={S.root}>
      <SectionTitle>Jukebox Status</SectionTitle>
      <StatusCard
        icon="J"
        iconBackground={reachable ? "#2563eb" : undefined}
        title="Jukebox"
        meta={
          loading
            ? "Checking..."
            : !reachable
              ? "Not reachable"
              : trackName
                ? `${status?.state}: ${trackName}`
                : (status?.state ?? "unknown")
        }
        state={loading ? undefined : reachable ? "ok" : "error"}
        link={
          reachable ? { href: `${BASE}/jukebox/`, label: "Open ↗" } : undefined
        }
      />

      {reachable && (
        <UpdateControls
          checkUrl={`${BASE}/api/update/check`}
          applyUrl={`${BASE}/api/update/apply`}
          tag={cfg.imageTag}
          onApplied={(tag) => patch({ imageTag: tag })}
        />
      )}

      <SectionTitle>Settings</SectionTitle>

      <FieldRow label="Music library path">
        <input
          style={S.input}
          value={cfg.libraryPath ?? ""}
          onChange={(e) => patch({ libraryPath: e.target.value })}
          placeholder="/host/path/to/music"
        />
      </FieldRow>

      <FieldRow label="Image version">
        <VersionSelect
          value={cfg.imageTag ?? "auto"}
          onChange={(tag) => patch({ imageTag: tag })}
          versions={versions.versions}
          loading={versions.loading}
          error={versions.versionsError}
          onRefresh={() => void versions.refresh()}
        />
      </FieldRow>

      <FieldRow label="Local library">
        <input
          type="checkbox"
          style={S.checkbox}
          checked={backends.local.enabled}
          onChange={(e) =>
            patch({
              backends: { ...backends, local: { enabled: e.target.checked } },
            })
          }
        />
      </FieldRow>

      <FieldRow label="Internet radio">
        <input
          type="checkbox"
          style={S.checkbox}
          checked={backends.radio.enabled}
          onChange={(e) =>
            patch({
              backends: { ...backends, radio: { enabled: e.target.checked } },
            })
          }
        />
      </FieldRow>

      <FieldRow
        label="Spotify"
        hint="currently degraded upstream -- SPEC.md §5, §13"
      >
        <input
          type="checkbox"
          style={S.checkbox}
          checked={backends.spotify.enabled}
          onChange={(e) =>
            patch({
              backends: {
                ...backends,
                spotify: { ...backends.spotify, enabled: e.target.checked },
              },
            })
          }
        />
      </FieldRow>
      {backends.spotify.enabled && (
        <>
          <FieldRow label="Spotify client ID">
            <input
              style={S.input}
              value={backends.spotify.clientId ?? ""}
              onChange={(e) =>
                patch({
                  backends: {
                    ...backends,
                    spotify: { ...backends.spotify, clientId: e.target.value },
                  },
                })
              }
            />
          </FieldRow>
          <FieldRow label="Spotify client secret">
            <input
              style={S.input}
              type="password"
              value={backends.spotify.clientSecret ?? ""}
              onChange={(e) =>
                patch({
                  backends: {
                    ...backends,
                    spotify: {
                      ...backends.spotify,
                      clientSecret: e.target.value,
                    },
                  },
                })
              }
            />
          </FieldRow>
        </>
      )}

      <FieldRow label="AirPlay zones">
        <input
          type="checkbox"
          style={S.checkbox}
          checked={airplay.enabled}
          onChange={(e) =>
            patch({ airplay: { ...airplay, enabled: e.target.checked } })
          }
        />
      </FieldRow>
      {airplay.enabled && (
        <>
          <FieldRow label="Zone name pattern">
            <input
              style={S.input}
              value={airplay.namePattern}
              onChange={(e) =>
                patch({ airplay: { ...airplay, namePattern: e.target.value } })
              }
            />
          </FieldRow>
          <FieldRow
            label="Host networking"
            hint="required for AirPlay discovery -- see warning below"
          >
            <input
              type="checkbox"
              style={S.checkbox}
              checked={airplay.hostNetworking}
              onChange={(e) =>
                patch({
                  airplay: { ...airplay, hostNetworking: e.target.checked },
                })
              }
            />
          </FieldRow>
          {!airplay.hostNetworking && (
            <div style={S.infoBanner}>
              AirPlay receivers won&apos;t be discoverable by iPhones/iPads on
              the boat WiFi with this off. mDNS advertisement and each
              zone&apos;s dynamically-chosen RTSP/RTP ports don&apos;t reach the
              LAN through this container&apos;s default networking at all --
              there&apos;s no fixed port list to publish the way Snapcast&apos;s
              stream port can be, since each zone&apos;s AirPlay receiver is
              created on demand.
            </div>
          )}
          {airplay.hostNetworking && (
            <div style={S.warnBanner}>
              <div style={S.warnBannerTitle}>Host networking is on</div>
              This container shares the host&apos;s network namespace and full
              port space with every other process on this machine, instead of
              being isolated on its own bridged network. Required for AirPlay
              discovery to work at all; only disable if you don&apos;t need
              AirPlay.
            </div>
          )}
        </>
      )}

      <CollapsibleSection title="NMEA2000 / Fusion-Link">
        <FieldRow label="Enable">
          <input
            type="checkbox"
            style={S.checkbox}
            checked={n2k.enabled}
            onChange={(e) =>
              patch({ n2k: { ...n2k, enabled: e.target.checked } })
            }
          />
        </FieldRow>
        <FieldRow label="Device name">
          <input
            style={S.input}
            value={n2k.deviceName}
            onChange={(e) =>
              patch({ n2k: { ...n2k, deviceName: e.target.value } })
            }
          />
        </FieldRow>
        <FieldRow label="Device instance">
          <input
            style={S.input}
            type="number"
            value={n2k.deviceInstance}
            onChange={(e) =>
              patch({ n2k: { ...n2k, deviceInstance: Number(e.target.value) } })
            }
          />
        </FieldRow>
      </CollapsibleSection>

      <CollapsibleSection title="VHF radio ducking">
        <FieldRow label="Pause on VHF traffic">
          <input
            type="checkbox"
            style={S.checkbox}
            checked={vhf.enabled}
            onChange={(e) =>
              patch({ vhf: { ...vhf, enabled: e.target.checked } })
            }
          />
        </FieldRow>
        <FieldRow label="Resume delay (seconds)">
          <input
            style={S.input}
            type="number"
            value={vhf.resumeDelaySeconds}
            onChange={(e) =>
              patch({
                vhf: { ...vhf, resumeDelaySeconds: Number(e.target.value) },
              })
            }
          />
        </FieldRow>
      </CollapsibleSection>

      <CollapsibleSection title="Voice-assistant ducking">
        <FieldRow label="Enable">
          <input
            type="checkbox"
            style={S.checkbox}
            checked={voiceDucking.enabled}
            onChange={(e) =>
              patch({
                voiceDucking: { ...voiceDucking, enabled: e.target.checked },
              })
            }
          />
        </FieldRow>
        <FieldRow label="Duck volume (%)">
          <input
            style={S.input}
            type="number"
            value={voiceDucking.duckVolumePercent}
            onChange={(e) =>
              patch({
                voiceDucking: {
                  ...voiceDucking,
                  duckVolumePercent: Number(e.target.value),
                },
              })
            }
          />
        </FieldRow>
        <FieldRow label="Resume delay (seconds)">
          <input
            style={S.input}
            type="number"
            value={voiceDucking.resumeDelaySeconds}
            onChange={(e) =>
              patch({
                voiceDucking: {
                  ...voiceDucking,
                  resumeDelaySeconds: Number(e.target.value),
                },
              })
            }
          />
        </FieldRow>

        <Hint>
          Per-satellite zone mapping (optional -- unmapped satellites duck all
          zones)
        </Hint>
        {voiceDucking.satelliteZoneMap.map((pair, i) => {
          // Discovered ids only exist while that satellite/zone is
          // currently known to SignalK/Snapserver -- a mapping saved
          // earlier for one that's offline right now would otherwise
          // vanish from a controlled <select>'s options and silently
          // reset to blank, so the saved value is always included too.
          const satelliteOptions = new Set(satellites?.ids ?? []);
          if (pair.satelliteId) satelliteOptions.add(pair.satelliteId);
          const zoneOptions = new Map(
            (zones ?? []).map((zone) => [zone.id, zone.name]),
          );
          if (pair.zoneId && !zoneOptions.has(pair.zoneId)) {
            zoneOptions.set(pair.zoneId, pair.zoneId);
          }

          return (
            <div key={i} style={S.fieldRow}>
              <select
                style={S.inputSmall}
                value={pair.satelliteId}
                onChange={(e) => {
                  const next = [...voiceDucking.satelliteZoneMap];
                  next[i] = { ...pair, satelliteId: e.target.value };
                  patch({
                    voiceDucking: { ...voiceDucking, satelliteZoneMap: next },
                  });
                }}
              >
                <option value="">voice.satellites.&lt;id&gt;</option>
                {[...satelliteOptions].map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <select
                style={S.inputSmall}
                value={pair.zoneId}
                onChange={(e) => {
                  const next = [...voiceDucking.satelliteZoneMap];
                  next[i] = { ...pair, zoneId: e.target.value };
                  patch({
                    voiceDucking: { ...voiceDucking, satelliteZoneMap: next },
                  });
                }}
              >
                <option value="">zone</option>
                {[...zoneOptions].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <Button
                variant="danger"
                small
                onClick={() => {
                  const next = voiceDucking.satelliteZoneMap.filter(
                    (_, j) => j !== i,
                  );
                  patch({
                    voiceDucking: { ...voiceDucking, satelliteZoneMap: next },
                  });
                }}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          variant="secondary"
          small
          onClick={() =>
            patch({
              voiceDucking: {
                ...voiceDucking,
                satelliteZoneMap: [
                  ...voiceDucking.satelliteZoneMap,
                  { satelliteId: "", zoneId: "" },
                ],
              },
            })
          }
        >
          + Add mapping
        </Button>
      </CollapsibleSection>

      <CollapsibleSection title="Local snapclient (this SignalK server's own sound card)">
        <FieldRow label="Enable">
          <input
            type="checkbox"
            style={S.checkbox}
            checked={localSnapclient.enabled}
            onChange={(e) =>
              patch({
                localSnapclient: {
                  ...localSnapclient,
                  enabled: e.target.checked,
                },
              })
            }
          />
        </FieldRow>
        {localSnapclient.enabled && (
          <>
            <FieldRow
              label="ALSA device"
              hint="required -- see this host's own `aplay -L` output"
            >
              <input
                style={S.input}
                value={localSnapclient.soundCard}
                onChange={(e) =>
                  patch({
                    localSnapclient: {
                      ...localSnapclient,
                      soundCard: e.target.value,
                    },
                  })
                }
                placeholder="plughw:CARD=wm8960soundcard,DEV=0"
              />
            </FieldRow>
            {localSnapclient.soundCard.trim() === "" && (
              <div style={S.warnBanner}>
                An ALSA device is required. A bare "default" device is ambiguous
                on a host with more than one sound card and fails outright --
                run <code>aplay -L</code> on the SignalK server itself and paste
                the exact device string (e.g.{" "}
                <code>plughw:CARD=wm8960soundcard,DEV=0</code>).
              </div>
            )}
            <FieldRow
              label="Zone name"
              hint="shown in the zone list and REST API in place of the raw container id"
            >
              <input
                style={S.input}
                value={localSnapclient.zoneName}
                onChange={(e) =>
                  patch({
                    localSnapclient: {
                      ...localSnapclient,
                      zoneName: e.target.value,
                    },
                  })
                }
                placeholder="Local speakers"
              />
            </FieldRow>
            <FieldRow label="Image version">
              <input
                style={S.input}
                value={localSnapclient.tag}
                onChange={(e) =>
                  patch({
                    localSnapclient: {
                      ...localSnapclient,
                      tag: e.target.value,
                    },
                  })
                }
              />
            </FieldRow>
          </>
        )}
      </CollapsibleSection>

      <ActionStatus message={saved} />
      <div style={{ marginTop: 24 }}>
        <Button
          onClick={() => {
            // Save the fully-merged object, not the raw (possibly
            // partial) `cfg` -- otherwise a save that never touched some
            // group perpetuates the same partial-config shape that
            // caused the crash this component's `merged` is guarding
            // against, just for the next person who opens this panel.
            save(merged);
            setSaved("Saved! Plugin will restart with new configuration.");
          }}
        >
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
