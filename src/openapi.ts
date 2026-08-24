// OpenAPI document for this plugin's REST API (SPEC.md §6.1), exposed via
// the standard SignalK plugin hook `plugin.getOpenApi` (@signalk/
// server-api's Plugin interface) so it shows up in the server's own
// OpenAPI explorer alongside every other plugin/API, rather than only
// being described in this repo's own docs.
//
// Kept as a plain TS object (not a .json import) to avoid turning on
// resolveJsonModule project-wide for one file.

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "signalk-jukebox API",
    version: "0.1.1",
    description:
      "REST API for signalk-jukebox: whole-boat music playback status, per-zone Snapcast volume/mute/source control, and container image updates. Actual playback control (play/pause/skip/queue/search) goes through the reverse-proxied Mopidy JSON-RPC endpoint (POST /mopidy/rpc) or the Mopidy-MusicBox-Webclient web UI, reached directly at http://<this-host>:6680/musicbox_webclient/ (not reverse-proxied -- see proxy.ts), not this REST surface -- see SPEC.md §6.1.",
    license: {
      name: "Apache-2.0",
      url: "https://www.apache.org/licenses/LICENSE-2.0",
    },
  },
  servers: [{ url: "/plugins/signalk-jukebox" }],
  tags: [
    { name: "playback", description: "Canonical playback state" },
    {
      name: "zones",
      description: "Per-zone (Snapcast client) discovery and control",
    },
    {
      name: "satellites",
      description: "Voice-assistant satellite discovery (signalk-wyoming)",
    },
    {
      name: "updates",
      description: "Container image version listing and updates",
    },
  ],
  paths: {
    "/api/status": {
      get: {
        tags: ["playback"],
        summary: "Current playback state",
        description:
          "The canonical playback state -- kept in sync with Mopidy's real state every 2s (playback-sync.ts), not just the last-requested state.",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlaybackState" },
              },
            },
          },
        },
      },
    },
    "/api/zones": {
      get: {
        tags: ["zones"],
        summary: "List all zones",
        description:
          "Zones are discovered read-only from Snapserver's connected clients (zone-sync.ts) -- there is no create/delete route; a zone appears the moment its Snapclient connects and disappears the moment it disconnects.",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Zone" },
                },
              },
            },
          },
        },
      },
    },
    "/api/zones/{id}/volume": {
      post: {
        tags: ["zones"],
        summary: "Set a zone's volume",
        parameters: [{ $ref: "#/components/parameters/ZoneId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["volume"],
                properties: {
                  volume: {
                    type: "integer",
                    minimum: 0,
                    maximum: 100,
                    description: "0-100",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "400": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/zones/{id}/mute": {
      post: {
        tags: ["zones"],
        summary: "Mute or unmute a zone",
        parameters: [{ $ref: "#/components/parameters/ZoneId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["muted"],
                properties: { muted: { type: "boolean" } },
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/zones/{id}/source": {
      post: {
        tags: ["zones"],
        summary: "Switch a zone between the Jukebox, Alerts, and Silence streams",
        description:
          '"jukebox" (the shared music stream, auto-ducking for announcements) or "alerts" (a standing announcement-intake stream other containers can feed, so a zone can be taken off the jukebox without muting its Snapclient entirely) or "silence" (a zone that shouldn\'t hear anything at all, not even announcements, e.g. a sleeping cabin) -- "airplay" is NOT accepted: a zone\'s AirPlay stream is switched to automatically the moment a device connects (SPEC.md §6.4, §12: "connecting is the switch"), never selected manually.',
        parameters: [{ $ref: "#/components/parameters/ZoneId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["source"],
                properties: {
                  source: { type: "string", enum: ["jukebox", "alerts", "silence"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "400": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/zones/{id}/delete": {
      post: {
        tags: ["zones"],
        summary: "Forget a decommissioned zone",
        description:
          "Removes a zone from Snapserver's own persisted client/group registration, so it stops permanently showing up as \"offline\" once it's known to never be coming back (e.g. a Snapclient that's been physically removed). Only allowed while the zone is disconnected -- a currently connected one just reappears on its next reconnect, so this rejects with 409 to avoid silently dropping one someone might still be listening on.",
        parameters: [{ $ref: "#/components/parameters/ZoneId" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/satellites": {
      get: {
        tags: ["satellites"],
        summary: "Known voice-assistant satellite ids",
        description:
          "Reads voice.satellites.<id> straight out of SignalK's own data model (an external, optional delta from signalk-wyoming) -- backs the config panel's per-satellite duck-mapping dropdown, not a general-purpose SignalK data API.",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ids"],
                  properties: {
                    ids: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/versions": {
      get: {
        tags: ["updates"],
        summary: "Image versions available for the version-select dropdown",
        description:
          "Lists tags from ghcr.io/boathacks/signalk-jukebox's own registry API directly (ghcr-versions.ts) -- not signalk-container-helper's registerUpdateRoutes, which only covers the single latest-version check/apply flow below.",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    versions: {
                      type: "array",
                      items: { $ref: "#/components/schemas/VersionInfo" },
                    },
                  },
                },
              },
            },
          },
          "502": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/update/check": {
      get: {
        tags: ["updates"],
        summary: "Check for a container image update",
        description:
          "Registered by signalk-container-helper's ManagedContainer.registerUpdateRoutes, not this plugin's own routes.ts.",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateCheckResult" },
              },
            },
          },
          "503": {
            description: "signalk-container manager not available",
          },
        },
      },
    },
    "/api/update/apply": {
      post: {
        tags: ["updates"],
        summary: "Apply a container image update",
        description:
          "Registered by signalk-container-helper's ManagedContainer.registerUpdateRoutes. Omit `tag` to re-apply the currently-configured tag (e.g. after a drift/recreate).",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { tag: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["success", "tag"],
                  properties: {
                    success: { type: "boolean", enum: [true] },
                    tag: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    parameters: {
      ZoneId: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Snapcast client id, from GET /api/zones.",
      },
    },
    responses: {
      Ok: {
        description: "OK",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ok"],
              properties: { ok: { type: "boolean", enum: [true] } },
            },
          },
        },
      },
      Error: {
        description: "Error",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error"],
              properties: { error: { type: "string" } },
            },
          },
        },
      },
    },
    schemas: {
      Track: {
        type: "object",
        required: ["uri", "name"],
        properties: {
          uri: { type: "string" },
          name: { type: "string" },
          artist: { type: "string" },
          album: { type: "string" },
          durationMs: { type: "integer" },
          positionMs: { type: "integer" },
        },
      },
      PlaybackState: {
        type: "object",
        required: ["state", "volume", "muted"],
        properties: {
          state: { type: "string", enum: ["stopped", "playing", "paused"] },
          track: { $ref: "#/components/schemas/Track" },
          volume: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "Master volume, distinct from per-zone volume.",
          },
          muted: { type: "boolean" },
        },
      },
      ZoneAirPlayInfo: {
        type: "object",
        required: ["streamName", "connected"],
        properties: {
          streamName: {
            type: "string",
            description:
              "The mDNS name this zone's AirPlay receiver was created with.",
          },
          connected: { type: "boolean" },
          track: {
            type: "object",
            properties: {
              title: { type: "string" },
              artist: { type: "string" },
              album: { type: "string" },
            },
          },
        },
      },
      Zone: {
        type: "object",
        required: [
          "id",
          "groupId",
          "name",
          "connected",
          "volume",
          "muted",
          "activeSource",
        ],
        properties: {
          id: { type: "string", description: "Snapcast client id." },
          groupId: { type: "string", description: "Snapcast group id." },
          name: { type: "string" },
          connected: { type: "boolean" },
          volume: { type: "integer", minimum: 0, maximum: 100 },
          muted: { type: "boolean" },
          n2kZone: {
            type: "integer",
            minimum: 0,
            maximum: 3,
            description:
              "Present only if this zone was assigned an N2K/Fusion slot.",
          },
          activeSource: { type: "string", enum: ["jukebox", "airplay"] },
          airplay: { $ref: "#/components/schemas/ZoneAirPlayInfo" },
        },
      },
      VersionInfo: {
        type: "object",
        required: ["tag"],
        properties: {
          tag: { type: "string" },
          prerelease: { type: "boolean" },
          pr: {
            type: "integer",
            description: "Set for per-PR test images (tag pr<N>).",
          },
          title: { type: "string" },
        },
      },
      UpdateCheckResult: {
        type: "object",
        required: [
          "pluginId",
          "containerName",
          "runningTag",
          "tagKind",
          "currentVersion",
          "latestVersion",
          "updateAvailable",
          "reason",
          "checkedAt",
          "lastSuccessfulCheckAt",
          "fromCache",
        ],
        properties: {
          pluginId: { type: "string" },
          containerName: { type: "string" },
          runningTag: { type: "string" },
          tagKind: { type: "string", enum: ["semver", "floating", "unknown"] },
          currentVersion: { type: "string", nullable: true },
          latestVersion: { type: "string", nullable: true },
          updateAvailable: { type: "boolean" },
          reason: {
            type: "string",
            enum: [
              "newer-version",
              "digest-drift",
              "older-than-pinned",
              "up-to-date",
              "offline",
              "unknown",
              "error",
            ],
          },
          error: { type: "string" },
          checkedAt: { type: "string", format: "date-time" },
          lastSuccessfulCheckAt: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          fromCache: { type: "boolean" },
        },
      },
    },
  },
};
