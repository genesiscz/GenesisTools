#!/usr/bin/env bun
/**
 * Writes the recorder protocol fixtures the Swift tests read, from the TypeScript source of truth:
 * `src/recorder/lib/__fixtures__/service-protocol.schemas.json` (protocolJsonSchemas).
 * `src/recorder/lib/service.test.ts` fails when a committed file differs from what this writes.
 *
 * Run: bun scripts/recorder/write-protocol-fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { protocolJsonSchemas } from "@app/recorder/lib/protocol-fixtures";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const FIXTURES = join(import.meta.dir, "..", "..", "src", "recorder", "lib", "__fixtures__");

const files: Record<string, unknown> = {
    "service-protocol.schemas.json": protocolJsonSchemas(),
};

for (const [name, content] of Object.entries(files)) {
    const path = join(FIXTURES, name);
    writeFileSync(path, `${SafeJSON.stringify(content, null, 2)}\n`);
    out.println(`wrote ${path}`);
}
