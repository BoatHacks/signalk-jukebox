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
import type { PluginSettings } from "../types.js";

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
  const [cfg, setCfg] = useState<Partial<PluginSettings>>(
    configuration ?? {},
  );
  const [saved, setSaved] = useState("");

  const { status, loading } = useStatusPoll<PlaybackStatus>(
    `${BASE}/api/status`,
    { fallback: {} },
  );
  const versions = useVersions(`${BASE}/api/versions`);

  const reachable = status !== null;
  const trackName = status?.track?.name;

  const backends = cfg.backends ?? {
    local: { enabled: true },
    radio: { enabled: false },
    spotify: { enabled: false },
  };
  const n2k = cfg.n2k ?? {
    enabled: false,
    deviceName: "Jukebox",
    deviceInstance: 0,
  };
  const airplay = cfg.airplay ?? {
    enabled: true,
    namePattern: "{boatName} - {zoneName}",
    hostNetworking: false,
  };
  const vhf = cfg.vhf ?? { enabled: true, resumeDelaySeconds: 5 };
  const voiceDucking = cfg.voiceDucking ?? {
    enabled: true,
    duckVolumePercent: 20,
    resumeDelaySeconds: 1,
    satelliteZoneMap: [],
  };

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
        link={reachable ? { href: `${BASE}/jukebox/`, label: "Open ↗" } : undefined}
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
              the boat WiFi with this off. mDNS advertisement and each zone&apos;s
              dynamically-chosen RTSP/RTP ports don&apos;t reach the LAN through
              this container&apos;s default networking at all -- there&apos;s no
              fixed port list to publish the way Snapcast&apos;s stream port can
              be, since each zone&apos;s AirPlay receiver is created on demand.
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
            onChange={(e) => patch({ n2k: { ...n2k, enabled: e.target.checked } })}
          />
        </FieldRow>
        <FieldRow label="Device name">
          <input
            style={S.input}
            value={n2k.deviceName}
            onChange={(e) => patch({ n2k: { ...n2k, deviceName: e.target.value } })}
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
            onChange={(e) => patch({ vhf: { ...vhf, enabled: e.target.checked } })}
          />
        </FieldRow>
        <FieldRow label="Resume delay (seconds)">
          <input
            style={S.input}
            type="number"
            value={vhf.resumeDelaySeconds}
            onChange={(e) =>
              patch({ vhf: { ...vhf, resumeDelaySeconds: Number(e.target.value) } })
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
              patch({ voiceDucking: { ...voiceDucking, enabled: e.target.checked } })
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

        <Hint>Per-satellite zone mapping (optional -- unmapped satellites duck all zones)</Hint>
        {voiceDucking.satelliteZoneMap.map((pair, i) => (
          <div key={i} style={S.fieldRow}>
            <input
              style={S.inputSmall}
              placeholder="voice.satellites.<id>"
              value={pair.satelliteId}
              onChange={(e) => {
                const next = [...voiceDucking.satelliteZoneMap];
                next[i] = { ...pair, satelliteId: e.target.value };
                patch({ voiceDucking: { ...voiceDucking, satelliteZoneMap: next } });
              }}
            />
            <input
              style={S.inputSmall}
              placeholder="zone id"
              value={pair.zoneId}
              onChange={(e) => {
                const next = [...voiceDucking.satelliteZoneMap];
                next[i] = { ...pair, zoneId: e.target.value };
                patch({ voiceDucking: { ...voiceDucking, satelliteZoneMap: next } });
              }}
            />
            <Button
              variant="danger"
              small
              onClick={() => {
                const next = voiceDucking.satelliteZoneMap.filter(
                  (_, j) => j !== i,
                );
                patch({ voiceDucking: { ...voiceDucking, satelliteZoneMap: next } });
              }}
            >
              Remove
            </Button>
          </div>
        ))}
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

      <ActionStatus message={saved} />
      <div style={{ marginTop: 24 }}>
        <Button
          onClick={() => {
            save(cfg as PluginSettings);
            setSaved("Saved! Plugin will restart with new configuration.");
          }}
        >
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
