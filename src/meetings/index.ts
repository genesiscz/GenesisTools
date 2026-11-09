import { runTool } from "@genesiscz/utils/cli";
import { registerRequestedTrees, requestedCommandFromArgv } from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";
import { MEETINGS_REGISTRARS } from "./registrars";

// The Meetings window starts this CLI through Foundation's Process, which hands every argument over decomposed (NFD):
// an answer "Martin Foltýn" arrived as "y" plus a combining accent and became a second speaker beside the composed one
// (2026-11-09). Names and answers are stored composed (NFC), whoever calls.
process.argv = process.argv.map((arg) => arg.normalize("NFC"));

const program = new Command();
program
    .name("meetings")
    .description("Meetings as one record each: projects, the transcript dictionary, recording and review");
await registerRequestedTrees({
    program,
    registrars: MEETINGS_REGISTRARS,
    requested: requestedCommandFromArgv(process.argv),
});

await runTool(program, { tool: "meetings" });
