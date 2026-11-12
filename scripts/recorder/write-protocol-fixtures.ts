#!/usr/bin/env bun
/**
 * Writes the recorder protocol fixtures the Swift tests read, from the TypeScript source of truth:
 * `src/recorder/lib/__fixtures__/service-protocol.schemas.json` (protocolJsonSchemas) and
 * `src/recorder/lib/__fixtures__/editor-golden.json` (editorGolden: example ops, edits, op tags, hello's methods) and
 * `src/recorder/lib/__fixtures__/screen-hit-ops.json` (screenHitOpsFixture: screen hits with their edit ops).
 * `src/recorder/lib/service.test.ts` fails when a committed file differs from what this writes.
 *
 * Run: bun scripts/recorder/write-protocol-fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import serviceExamples from "@app/recorder/lib/__fixtures__/service-protocol.json";
import { editorGolden, protocolJsonSchemas, screenHitOpsFixture } from "@app/recorder/lib/protocol-fixtures";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { RpcError, rpcErrorBody } from "@genesiscz/utils/rpc/errors";

const FIXTURES = join(import.meta.dir, "..", "..", "src", "recorder", "lib", "__fixtures__");

/** Refreshes the service's error metadata while keeping the captured method examples and Swift host replies. */
function serviceProtocolExamples() {
    return {
        ...serviceExamples,
        examples: serviceExamples.examples.map((example) => {
            const reply = "reply" in example ? example.reply : undefined;
            if (!example.direction.endsWith("→service") || !reply || !("error" in reply) || !reply.error) {
                return example;
            }

            const error = reply.error;
            return {
                ...example,
                reply: {
                    ...reply,
                    error: rpcErrorBody(
                        new RpcError(error.code, error.message, "data" in error ? error.data : undefined, {
                            stack: "<stack>",
                        }),
                        "recorder"
                    ),
                },
            };
        }),
    };
}

const files: Record<string, unknown> = {
    "service-protocol.json": serviceProtocolExamples(),
    "service-protocol.schemas.json": protocolJsonSchemas(),
    "editor-golden.json": editorGolden(),
    "screen-hit-ops.json": screenHitOpsFixture(),
};

for (const [name, content] of Object.entries(files)) {
    const path = join(FIXTURES, name);
    writeFileSync(path, `${SafeJSON.stringify(content, null, 2)}\n`);
    out.println(`wrote ${path}`);
}
