import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { languageSettings, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { Command } from "commander";
import { meetingOcrSettings, runOcrWorker } from "../lib/ocr-worker";
import { fail, TOOL } from "../lib/shared";

const { log } = logger.scoped("meetings-ocr-cmd");

interface OcrOptions {
    follow?: boolean;
    retryFailed?: boolean;
    rereadEmptySince?: string;
    json?: boolean;
}

/**
 * `--reread-empty-since`: a full date (`2026-11-11T15:56:00+01:00`, `2026-11-11T14:56Z`), or a local time of day
 * (`15:56`, `15:56:30`), taking its first occurrence on or after the meeting started.
 */
export function parseRereadSince(raw: string, record: Pick<MeetingRecord, "start">): Date | undefined {
    const clock = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

    if (clock) {
        const day = new Date(record.start);

        const hours = Number(clock[1]);
        const minutes = Number(clock[2]);
        const seconds = Number(clock[3] ?? 0);
        if (!Number.isFinite(day.getTime()) || hours > 23 || minutes > 59 || seconds > 59) {
            return undefined;
        }

        day.setHours(hours, minutes, seconds, 0);

        if (day.getTime() < Date.parse(record.start)) {
            day.setDate(day.getDate() + 1);
        }

        return day;
    }

    const at = Date.parse(raw);
    return Number.isFinite(at) ? new Date(at) : undefined;
}

async function ocr(ref: string, opts: OcrOptions): Promise<void> {
    const store = new MeetingStore();
    const record = store.resolve(ref);

    if (!record) {
        fail(`No meeting "${ref}". List them: ${TOOL} list`);
        return;
    }

    const since = opts.rereadEmptySince === undefined ? undefined : parseRereadSince(opts.rereadEmptySince, record);

    if (opts.rereadEmptySince !== undefined && !since) {
        fail(`--reread-empty-since ${opts.rereadEmptySince} is no time: give 15:56 (that day, local) or a full date.`);
        return;
    }

    try {
        const config = await new MeetingsConfigStore().read();
        const settings = meetingOcrSettings(config.global.capture, languageSettings(config).ocr);
        const result = await withInterrupt((signal) =>
            runOcrWorker({
                store,
                meetingId: record.id,
                settings,
                follow: opts.follow,
                retryFailed: opts.retryFailed,
                rereadEmptySince: since,
                failureNotices: config.global.capture.failureNotices,
                signal,
            })
        );

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            return;
        }

        if (result.status === "busy") {
            ui.warn(
                `Another OCR worker reads ${record.id}${result.holder !== undefined ? ` (pid ${result.holder})` : ""}.`
            );
            return;
        }

        ui.ok(`${record.id}: ${result.read} frames read, ${result.reread} rows read again`);

        if (result.failed > 0) {
            ui.warn(
                `${result.failed} frames could not be read (${result.restarts} helper restarts). Read them again: ${TOOL} ocr ${record.id} --retry-failed`
            );
        }
    } catch (err) {
        log.error({ err, meeting: record.id }, "the OCR worker failed");
        fail(err);
    }
}

export function registerOcrCommand(program: Command): void {
    program
        .command("ocr")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Read the screen text of the meeting's kept frames that have none yet into ocr.jsonl (the recorder starts this by itself)"
        )
        .option("--follow", "go on while the meeting's recorder runs; end once it stopped and every frame is read")
        .option("--retry-failed", "read the frames whose read failed again (ocr.jsonl is rewritten in its order)")
        .option(
            "--reread-empty-since <time>",
            "read every frame with no text from this time on again: 15:56 (that day, local) or a full date"
        )
        .option("--json", "print JSON")
        .action(ocr);
}
