#!/usr/bin/env bun

import { requestedCommandFromArgv } from "@genesiscz/utils/cli/lazy-registrars";

// `tools hub agents …` gets its own small entry: the hub polls `agents counts` every 5 s per
// running row, and the full hub CLI imports about 540 modules (190 ms) before it parses argv.
if (requestedCommandFromArgv(process.argv) === "agents") {
    await import("./agents-cli");
} else {
    await import("./cli");
}
