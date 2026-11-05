import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes, parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { calendarAround } from "@genesiscz/utils/meetings/calendar";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatClock, localTime, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { z } from "zod";
import { collectAndReport } from "../lib/collect";
import { ensureScreenRecording } from "../lib/grants";
import { linkSource } from "../lib/link";
import { resolveProject } from "../lib/project";
import { readRecorderState, recorderAcknowledged, requestRecorderStop, runRecorder } from "../lib/recorder";
import { errorText, fail, TOOL } from "../lib/shared";

const { log } = logger.scoped("meetings-record-cmd");

/** How long `record start` waits for the recorder to report, and `record stop` for it to finish its piece. */
const START_WAIT_MS = 15_000;
const STOP_WAIT_MS = 75_000;
const WAIT_STEP_MS = 500;

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (check()) {
            return true;
        }

        await Bun.sleep(Math.min(WAIT_STEP_MS, deadline - Date.now()));
    }

    return check();
}

/** The meeting to record: named, built from a source, or new (with the calendar event around now). */
async function meetingToRecord(
    store: MeetingStore,
    opts: { meeting?: string; source?: string; title?: string; project?: string; yes?: boolean }
): Promise<MeetingRecord> {
    const config = new MeetingsConfigStore();

    if (opts.meeting) {
        const record = store.resolve(opts.meeting);

        if (!record) {
            throw new Error(`No meeting "${opts.meeting}" (${TOOL} list)`);
        }

        return record;
    }

    if (opts.source) {
        const { record } = await linkSource({
            store,
            config,
            sourceRef: opts.source,
            project: opts.project,
            command: "record start",
            createdBy: "record",
            quiet: opts.yes,
        });
        return record;
    }

    const now = new Date();
    const calendar = await calendarAround(now);
    const title = opts.title ?? calendar?.title ?? `Meeting ${localTime(now.toISOString()).slice(11)}`;
    const { project } = await resolveProject({
        config,
        flag: opts.project,
        facts: { title, calendar: calendar?.calendar },
        quiet: opts.yes,
    });

    return store.create(
        {
            title,
            start: now.toISOString(),
            createdBy: "record",
            ...(project ? { project } : {}),
            ...(calendar ? { calendar } : {}),
        },
        {
            command: "record start",
            change: `created "${title}"${calendar ? ` from calendar ${calendar.calendar ?? ""}` : ""}`,
        }
    );
}

async function start(opts: {
    meeting?: string;
    source?: string;
    title?: string;
    project?: string;
    display?: string;
    yes?: boolean;
}): Promise<void> {
    const store = new MeetingStore();
    const current = readRecorderState(store);

    if (current.running) {
        fail(`Already recording ${current.state?.meetingId ?? "a meeting"}. Stop it first: ${TOOL} record stop`);
        return;
    }

    const display = Number(opts.display ?? 1);

    if (!Number.isInteger(display) || display < 0) {
        fail(`--display ${opts.display} is not a screen index (0, 1, 2 …).`);
        return;
    }

    try {
        const grant = await ensureScreenRecording({ quiet: opts.yes });

        if (!grant.granted) {
            fail(grant.message ?? `Screen Recording is not granted to ${grant.identity}.`);
            return;
        }

        const record = await meetingToRecord(store, opts);
        const startedAfter = Date.now();
        const pid = spawnToolDetached(["meetings", "record", "run", record.id, "--display", String(display)]);
        log.info({ meeting: record.id, pid, identity: grant.identity }, "recorder started");
        const reported = await waitFor(
            () => recorderAcknowledged({ current: readRecorderState(store), meetingId: record.id, startedAfter }),
            START_WAIT_MS
        );

        if (!reported) {
            fail(
                `The recorder did not report within ${START_WAIT_MS / 1000} s. Its log: ${toolCommand("genesis-tools", "logs", "day", "--tool", "meetings")}`
            );
            return;
        }

        ui.ok(
            `Recording the screen for ${record.id}${record.project ? ` (project ${record.project})` : ""}, as ${grant.identity}.`
        );
        ui.dim(`Stop: ${TOOL} record stop · status: ${TOOL} record status`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function stop(opts: { meeting?: string; startedAt?: string }): Promise<void> {
    const store = new MeetingStore();
    const current = readRecorderState(store);

    if (!current.running) {
        ui.info(opts.meeting ? "That recording has already ended." : "Nothing is recording.");
        return;
    }

    if (!requestRecorderStop(store, opts)) {
        ui.info("That recording has already ended.");
        return;
    }
    ui.dim("Asked the recorder to stop; it finishes the current piece (up to 30 s) first.");
    const stopped = await waitFor(() => !readRecorderState(store).running, STOP_WAIT_MS);

    if (!stopped) {
        fail(`The recorder is still running after ${STOP_WAIT_MS / 1000} s (pid ${current.state?.pid}).`);
        return;
    }

    const record = current.state ? store.read(current.state.meetingId) : undefined;
    const recording = record?.recording;
    const frames = typeof recording?.frames === "number" ? recording.frames : 0;
    const bytes = typeof recording?.bytes === "number" ? recording.bytes : 0;
    if (recording?.stopReason === "failed" || recording?.stopReason === "error") {
        fail(`Recording failed: ${recording.warning ?? "unknown recording error"}`);
        return;
    }

    ui.ok(`Stopped ${record?.id ?? ""}: ${frames} frames, ${formatBytes(bytes)}.`);

    if (typeof recording?.warning === "string") {
        ui.warn(recording.warning);
    }

    // The call is over: what the platform and the recording can tell is complete now.
    if (record) {
        await collectAndReport(store, record);
    }
}

async function status(opts: { json?: boolean }): Promise<void> {
    const store = new MeetingStore();
    const current = readRecorderState(store);

    if (opts.json) {
        out.result(SafeJSON.stringify(current, null, 2));
        return;
    }

    if (!current.running || !current.state) {
        ui.info("Nothing is recording.");
        return;
    }

    const state = current.state;
    ui.ok(
        `Recording ${state.meetingId} since ${localTime(state.startedAt)} (display ${state.display}, pid ${state.pid})`
    );
    ui.dim(
        `${state.frames} frames, ${formatBytes(state.bytes)}${state.lastFrameAt ? `, last at ${localTime(state.lastFrameAt)}` : ""}`
    );
    ui.dim(`folder: ${store.folder(state.meetingId)}`);

    if (state.warning) {
        ui.warn(state.warning);
    }
}

async function runCommand(id: string, opts: { display?: string }): Promise<void> {
    const store = new MeetingStore();

    try {
        const config = await new MeetingsConfigStore().read();
        await runRecorder({ store, meetingId: id, display: Number(opts.display ?? 1), capture: config.global.capture });
    } catch (err) {
        log.error({ err, id }, "recorder failed");
        process.exitCode = 1;
    }
}

const ocrLineSchema = z.object({ file: z.string(), at: z.string(), text: z.string() });
type OcrLine = z.infer<typeof ocrLineSchema>;

async function screen(ref: string, opts: { at?: string; window?: string; json?: boolean }): Promise<void> {
    const store = new MeetingStore();
    const record = store.resolve(ref);

    if (!record) {
        fail(`No meeting "${ref}". List them: ${TOOL} list`);
        return;
    }

    const atSec = opts.at ? parseClock(opts.at) : undefined;
    const windowSec = parseDuration(opts.window ?? "30s") / 1000;

    if (atSec === undefined) {
        fail(`--at needs a transcript time: 1:23:50, 23:50 or 90 (seconds).`);
        return;
    }

    const ocrPath = join(store.folder(record.id), "ocr.jsonl");

    if (!existsSync(ocrPath)) {
        fail(`${record.id} has no screen recording. Record one: ${TOOL} record start --meeting ${record.id}`);
        return;
    }

    const clock = record.recording?.clock;
    const zero = Date.parse(
        clock && typeof clock === "object" && "startedAt" in clock && typeof clock.startedAt === "string"
            ? clock.startedAt
            : record.start
    );
    const target = zero + atSec * 1000;
    const lines: OcrLine[] = readFileSync(ocrPath, "utf8")
        .split("\n")
        .filter((row) => row.trim())
        .map((row) => ocrLineSchema.parse(SafeJSON.parse(row, { strict: true })));
    const near = lines.filter((line) => Math.abs(Date.parse(line.at) - target) <= (windowSec * 1000) / 2);

    if (opts.json) {
        out.result(
            SafeJSON.stringify(
                near.map((line) => ({ ...line, meetingSec: (Date.parse(line.at) - zero) / 1000 })),
                null,
                2
            )
        );
        return;
    }

    if (near.length === 0) {
        ui.info(
            `No frame within ${windowSec / 2} s of ${formatClock(atSec)} (the screen did not change, or nothing was recorded then).`
        );
        return;
    }

    for (const line of near) {
        out.println(
            `── ${formatClock((Date.parse(line.at) - zero) / 1000)}  ${join(store.folder(record.id), line.file)}`
        );
        out.println(line.text.trim() || "(no text)");
    }
}

export function registerRecordCommands(program: Command): void {
    const record = program
        .command("record")
        .description("Record the screen during a meeting: frames when it changes, with OCR");

    record
        .command("start")
        .description("Start recording; creates the meeting unless --meeting names one")
        .option("--meeting <ref>", "record for this existing meeting")
        .option("--source <ref>", "build the meeting from a source's meeting: wisprflow:<id>")
        .option("--title <text>", "the new meeting's title (default: the calendar event, or the time)")
        .option("--project <name>", "its project (a new name joins the known projects)")
        .option("--display <index>", "the screen index to record (peekaboo's)", "1")
        .option("-y, --yes", "never prompt (project, permissions)")
        .action(start);

    record
        .command("stop")
        .description("Stop the recording and write its summary into the meeting")
        .option("--meeting <id>", "stop only this meeting")
        .option("--started-at <iso>", "stop only this recorder run")
        .action(stop);
    record.command("status").description("What is being recorded").option("--json", "print JSON").action(status);
    record
        .command("run", { hidden: true })
        .argument("<meeting>", "the meeting id")
        .option("--display <index>", "screen index", "1")
        .description("The recorder process itself; record start runs it")
        .action(runCommand);

    program
        .command("screen")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description("The OCR text of the screen around a transcript time")
        .requiredOption("--at <time>", "transcript time: 1:23:50, 23:50 or seconds")
        .option("--window <duration>", "how wide a window around it", "30s")
        .option("--json", "print JSON")
        .action(screen);
}
