// Regression test for the halpi2 incident (2026-09-22): a single mislabeled
// internet-radio stream crashed mopidy (a gstav1parse assertion, see
// image/Dockerfile's GST_PLUGIN_FEATURE_RANK comment), which used to take
// the whole sk-jukebox container down via image/entrypoint.sh's old
// `wait -n`-on-two-fixed-pids design. image/entrypoint.sh now supervises
// mopidy in its own respawn-in-place loop (`supervise_mopidy`, mirroring
// signalk-jukebox-wyoming-bridge's snapclient respawn pattern) instead.
//
// image/entrypoint.sh is bash, not TypeScript, so this test shells out to
// bash and sources the real file (guarded to skip its container-only main
// body when sourced -- see the file's own `BASH_SOURCE[0]` != `$0` check)
// rather than reimplementing its logic here, so a change to the real
// script's behavior actually gets caught.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRYPOINT_PATH = fileURLToPath(
  new URL("../image/entrypoint.sh", import.meta.url),
);

function runBash(
  script: string,
  extraPath: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${extraPath}:${process.env.PATH}`,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("entrypoint.sh next_rapid_exit_state", () => {
  it(
    "counts consecutive rapid exits and resets once a run lasts long enough",
    { timeout: 20_000 },
    () => {
      const result = runBash(
        `source "${ENTRYPOINT_PATH}"
       next_rapid_exit_state 100 0
       next_rapid_exit_state 100 1
       next_rapid_exit_state 5000 2
       next_rapid_exit_state 50 4`,
        "/usr/bin",
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "1 0", // first rapid exit: count 1, don't give up
        "2 0", // second in a row: count 2, still don't give up
        "0 0", // ran long enough (>= threshold): resets to 0
        "5 1", // 5th consecutive rapid exit: give up
      ]);
    },
  );
});

describe("entrypoint.sh supervise_mopidy", () => {
  let fakeBinDir: string;

  function writeFakeMopidy(script: string) {
    fakeBinDir = mkdtempSync(join(tmpdir(), "jukebox-fake-mopidy-"));
    const path = join(fakeBinDir, "mopidy");
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return fakeBinDir;
  }

  it(
    "respawns mopidy in place after an ordinary crash, without exiting",
    { timeout: 20_000 },
    () => {
      const bin = writeFakeMopidy(`#!/bin/bash
n=$(cat "$MOPIDY_TEST_COUNT_FILE" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$MOPIDY_TEST_COUNT_FILE"
if [ "$n" -le 2 ]; then
  exit 134
fi
touch "$MOPIDY_TEST_STAYED_UP_FILE"
trap 'exit 0' TERM
sleep 5 &
wait $!
`);
      const countFile = join(fakeBinDir, "count");
      const stayedUpFile = join(fakeBinDir, "stayed-up");
      const pidFile = join(fakeBinDir, "mopidy.pid");
      const shutdownFlag = join(fakeBinDir, "mopidy.shutting-down");

      const result = runBash(
        `source "${ENTRYPOINT_PATH}"
       # Run the supervisor in the background, give it time to crash twice
       # and respawn into the long-running 3rd attempt, then confirm it's
       # still alive (never fell through to a fatal exit) before killing it.
       supervise_mopidy &
       SUP_PID=$!
       for i in $(seq 1 50); do
         [ -f "$MOPIDY_TEST_STAYED_UP_FILE" ] && break
         sleep 0.1
       done
       touch "$MOPIDY_SHUTDOWN_FLAG"
       kill -TERM "$(cat "$MOPIDY_PID_FILE")" 2>/dev/null
       wait "$SUP_PID"
       echo "supervisor_exit=$?"
       cat "$MOPIDY_TEST_COUNT_FILE"`,
        bin,
        {
          MOPIDY_TEST_COUNT_FILE: countFile,
          MOPIDY_TEST_STAYED_UP_FILE: stayedUpFile,
          MOPIDY_PID_FILE: pidFile,
          MOPIDY_SHUTDOWN_FLAG: shutdownFlag,
        },
      );

      expect(result.stderr).toContain("respawning in place");
      expect(result.stdout).toContain("supervisor_exit=0");
      // 3 runs: two crashes (respawned) + the one that stayed up.
      expect(result.stdout.trim().split("\n").pop()).toBe("3");

      rmSync(bin, { recursive: true, force: true });
    },
  );

  it(
    "gives up and returns the crash status after repeated rapid crashes, instead of respawning forever",
    { timeout: 20_000 },
    () => {
      const bin = writeFakeMopidy(`#!/bin/bash
exit 134
`);
      const pidFile = join(fakeBinDir, "mopidy.pid");
      const shutdownFlag = join(fakeBinDir, "mopidy.shutting-down");

      const result = runBash(
        // \`|| status=$?\` because entrypoint.sh's \`set -e\` (inherited by
        // sourcing it here) would otherwise abort this whole test script the
        // instant supervise_mopidy returns non-zero, before its status could
        // be captured and echoed below.
        `source "${ENTRYPOINT_PATH}"
       status=0
       supervise_mopidy || status=$?
       echo "supervisor_exit=$status"`,
        bin,
        { MOPIDY_PID_FILE: pidFile, MOPIDY_SHUTDOWN_FLAG: shutdownFlag },
      );

      expect(result.stderr).toContain("giving up");
      expect(result.stdout).toContain("supervisor_exit=134");

      rmSync(bin, { recursive: true, force: true });
    },
  );
});
