#!/usr/bin/env bun

import { requestedCommandFromArgv } from "@genesiscz/utils/cli/lazy-registrars";

// `tools hub agents …` gets its own small entry: the hub polls `agents counts` every 5 s per
// running row, and the full hub CLI imports about 540 modules (190 ms) before it parses argv.
const requested = requestedCommandFromArgv(process.argv);
if (requested === "agents") {
    await import("./agents-cli");
} else if (requested === "widget") {
    await import("./widget-cli");
} else if (requested === "serve") {
    // The resident server: its memory is held for hours, so it loads only its doors.
    await import("./server-cli");
} else {
    await import("./cli");
}
