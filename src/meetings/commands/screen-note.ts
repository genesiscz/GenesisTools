import { existsSync } from "node:fs";
import { join } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { Command } from "commander";
import { CallTimeline } from "../lib/call-timeline";
import { writeScreenNote } from "../lib/screen-note";
import { errorText, fail, TOOL } from "../lib/shared";

async function screenNote(ref: string, opts: { out?: string; json?: boolean }): Promise<void> {
    const store = new MeetingStore();
    const record = store.resolve(ref);

    if (!record) {
        fail(`No meeting "${ref}". List them: ${TOOL} list`);
        return;
    }

    const folder = store.folder(record.id);

    if (!existsSync(join(folder, "ocr.jsonl"))) {
        fail(`${record.id} has no screen recording. Record one: ${TOOL} record start --meeting ${record.id}`);
        return;
    }

    const notePath = opts.out ?? join(folder, `${record.id}.ScreenOCR.md`);
    const zeroMs = (await CallTimeline.forRecord(record)).zeroMs;

    try {
        const result = writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs });

        if (opts.json) {
            out.result(SafeJSON.stringify({ ...result, links: Object.fromEntries(result.links) }, null, 2));
            return;
        }

        ui.ok(`${result.notePath}: ${result.shown} of ${result.frames} frames shown`);
        ui.kv("pictures", `${result.cloned} cloned, ${result.copied} copied, ${result.kept} already there`);

        if (result.copied > 0) {
            ui.warn(`${result.copied} pictures are copies: this volume cannot clone them, so they use disk space.`);
        }

        if (result.missing.length > 0) {
            ui.warn(`${result.missing.length} frames are not on disk; the note says so where they would be.`);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerScreenNoteCommand(program: Command): void {
    program
        .command("screen-note")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Write the meeting's screen OCR as a note: each frame whose text changed, with its picture (an APFS clone beside the note) and its text"
        )
        .option("--out <file>", "the note to write (default: <meeting folder>/<id>.ScreenOCR.md)")
        .option("--json", "print JSON")
        .action(screenNote);
}
