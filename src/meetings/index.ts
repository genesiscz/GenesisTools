import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { MEETINGS_REGISTRARS } from "./registrars";

// The Meetings window starts this CLI through Foundation's Process, which hands every argument over decomposed (NFD):
// an answer "Martin Foltýn" arrived as "y" plus a combining accent and became a second speaker beside the composed one
// (2026-11-09). Names and answers are stored composed (NFC), whoever calls. A source's speaker labels are composed
// when it loads (`meetingSource` in lib/sources.ts), so a composed --label still matches them. A file path stays
// valid: APFS and HFS+ find a file by either form.
process.argv = process.argv.map((arg) => arg.normalize("NFC"));

const program = new Command();
program
    .name("meetings")
    .description("Meetings as one record each: projects, the transcript dictionary, recording and review");

await runTool(program, { tool: "meetings", registrars: MEETINGS_REGISTRARS });
