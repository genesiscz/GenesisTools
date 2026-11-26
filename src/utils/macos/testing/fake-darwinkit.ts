import { chmodSync, writeFileSync } from "node:fs";
import { persistentFixture } from "@genesiscz/utils/test/persistent-fixture";

/**
 * A stand-in for the darwinkit helper: it sends `ready`, then answers every request with
 * "Calendar and Reminders access is not determined". It never touches EventKit, so no test run
 * can reach the real Calendar, Reminders or a macOS privacy dialog.
 *
 * Put its folder first on PATH to make `ensureBinary` pick it, or pass the file as `binary`.
 */
const FAKE_HELPER = `#!/bin/bash
echo '{"jsonrpc":"2.0","method":"ready","params":{"version":"0","capabilities":[]}}'
while IFS= read -r line; do
  id=$(echo "$line" | sed -E 's/.*"id":"([^"]*)".*/\\1/')
  echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"$id\\",\\"result\\":{\\"authorized\\":false,\\"status\\":\\"notDetermined\\"}}"
done
`;

const SILENT_HELPER = `#!/bin/bash
while IFS= read -r line; do
  :
done
`;

/** A helper that keeps its pipes open without sending ready. */
export function silentDarwinKitPath(): string {
    return persistentFixture("darwinkit-silent", SILENT_HELPER, (path) => {
        writeFileSync(path, SILENT_HELPER);
        chmodSync(path, 0o755);
    });
}

/** The path of the fake helper, named `darwinkit`, made once and kept (see persistentFixture). */
export function fakeDarwinKitPath(): string {
    return persistentFixture("darwinkit", FAKE_HELPER, (path) => {
        writeFileSync(path, FAKE_HELPER);
        chmodSync(path, 0o755);
    });
}
