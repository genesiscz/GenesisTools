import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { Command } from "commander";
import { DEFAULT_CHUNK_CHARS, packMeeting } from "../lib/line-table";
import { OpenedMeeting } from "../lib/opened-meeting";
import { fail, unknownMeetingText } from "../lib/shared";

async function pack(ref: string, opts: { out: string; chunkChars?: string; voices?: boolean; json?: boolean }) {
    try {
        const store = new MeetingStore();
        const record = store.resolve(ref);

        if (!record) {
            fail(unknownMeetingText(store, ref));
            return;
        }

        const result = await packMeeting(OpenedMeeting.of(store, record), {
            out: resolve(opts.out),
            ...(opts.chunkChars === undefined ? {} : { chunkChars: Number(opts.chunkChars) }),
            withVoices: opts.voices !== false,
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(result));
            return;
        }

        out.println(`${result.rows} lines in ${result.chunks.length} chunks and facts.md in ${result.out}`);
        for (const chunk of result.chunks) {
            out.println(
                `  ${chunk.file}: idx ${chunk.fromIdx}–${chunk.toIdx}, ${chunk.rows} rows, ${chunk.chars} chars`
            );
        }
    } catch (error) {
        fail(error);
    }
}

export function registerPackCommand(program: Command): void {
    program
        .command("pack")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Write the line table for an agent's speaker pass: facts.md and lines-<n>.tsv chunks that each repeat the legend"
        )
        .requiredOption("--out <dir>", "a new or empty folder")
        .option(
            "--chunk-chars <n>",
            `about this many characters per chunk, cut at a change of label (default ${DEFAULT_CHUNK_CHARS})`
        )
        .option("--no-voices", "skip the voice measurement; the voice and next columns stay empty")
        .option("--json", "print the written files as JSON")
        .action(pack);
}
