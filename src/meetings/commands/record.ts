import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes, parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { calendarAround } from "@genesiscz/utils/meetings/calendar";
import { DISPLAY_POLICIES, type DisplayPolicy, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { callRecorder, type LiveEntry, RpcError } from "@genesiscz/utils/screen-recorder/live";
import type { DisplayInfo } from "@genesiscz/utils/screen-recorder/types";
import { formatClock, localTime, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { collectAndReport } from "../lib/collect";
import { ensureScreenRecording } from "../lib/grants";
import { linkSource } from "../lib/link";
import { resolveProject } from "../lib/project";
import {
    framesOnDisk,
    meetingLiveId,
    readRecorderState,
    recorderFiles,
    runRecorder,
    stateDisplays,
} from "../lib/recorder";
import { framesAtPerDisplay, type OcrLine, ocrLineSchema, recordedSpans } from "../lib/screen";
import { errorText, fail, TOOL } from "../lib/shared";

const { log } = logger.scoped("meetings-record-cmd");

/** How long `record start` waits for the recorder to report, and `record stop` for it to convert its last frames. */
const START_WAIT_MS = 15_000;
const STOP_WAIT_MS = 75_000;

/** `all`, `follow-focus`, `main` or a screen index; undefined when the text is none of them. */
export function parseDisplayPolicy(raw: string): DisplayPolicy | undefined {
    if ((DISPLAY_POLICIES as readonly string[]).includes(raw)) {
        return raw as DisplayPolicy;
    }

    const index = Number(raw);
    return /^\d+$/.test(raw) && Number.isInteger(index) ? index : undefined;
}
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

    const display = opts.display === undefined ? undefined : parseDisplayPolicy(opts.display);

    if (opts.display !== undefined && display === undefined) {
        fail(`--display ${opts.display} is none of ${DISPLAY_POLICIES.join(", ")} or a screen index (0, 1, 2 …).`);
        return;
    }

    try {
        const grant = await ensureScreenRecording({ quiet: opts.yes });

        if (!grant.granted) {
            fail(grant.message ?? `Screen Recording is not granted to ${grant.identity}.`);
            return;
        }

        const record = await meetingToRecord(store, opts);
        const pid = spawnToolDetached([
            "meetings",
            "record",
            "run",
            record.id,
            ...(display !== undefined ? ["--display", String(display)] : []),
        ]);
        log.info({ meeting: record.id, pid, identity: grant.identity }, "recorder started");
        const files = recorderFiles(store);
        const reported = await waitFor(
            () => existsSync(files.state) && readRecorderState(store).state?.meetingId === record.id,
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
        ui.dim(`Pause: ${TOOL} record pause · stop: ${TOOL} record stop · status: ${TOOL} record status`);
    } catch (err) {
        fail(errorText(err));
    }
}

/** The running meeting recorder's live recording id, or undefined (with a message) when nothing records. */
function runningRecorder(store: MeetingStore): { id: string; meetingId: string; pid: number } | undefined {
    const current = readRecorderState(store);

    if (!current.running || !current.state) {
        ui.info("Nothing is recording.");
        return undefined;
    }

    return { id: meetingLiveId(current.state.meetingId), meetingId: current.state.meetingId, pid: current.state.pid };
}

/** One call on the recorder's socket; a refusal (not paused, unknown display) is printed and fails the command. */
async function callRunning<T>(
    store: MeetingStore,
    method: string,
    params?: unknown
): Promise<{ result: T; meetingId: string } | undefined> {
    const running = runningRecorder(store);

    if (!running) {
        return undefined;
    }

    try {
        const result = await callRecorder<T>({ id: running.id, method, params });
        return { result, meetingId: running.meetingId };
    } catch (err) {
        fail(
            err instanceof RpcError
                ? `${err.message} (code ${err.code})`
                : `${errorText(err)}. The recorder (pid ${running.pid}) may be from an older version; stop it: kill ${running.pid}`
        );
        return undefined;
    }
}

async function pauseOrResume(command: "pause" | "resume"): Promise<void> {
    const answer = await callRunning<{ state: string }>(new MeetingStore(), command);

    if (answer) {
        ui.ok(
            command === "pause"
                ? `Paused ${answer.meetingId}. Resume: ${TOOL} record resume`
                : `Recording ${answer.meetingId} again.`
        );
    }
}

/** Connected displays, with the ones being recorded marked. */
async function displayList(opts: { json?: boolean }): Promise<void> {
    const answer = await callRunning<Array<DisplayInfo & { recorded: boolean }>>(new MeetingStore(), "displays.list");

    if (!answer) {
        return;
    }

    if (opts.json) {
        out.result(SafeJSON.stringify(answer.result, null, 2));
        return;
    }

    for (const display of answer.result) {
        out.println(
            `${display.recorded ? "●" : "○"} ${display.id}  ${display.name}${display.main ? " (main)" : ""}  index ${display.index}`
        );
    }
}

async function displayChange(method: "add" | "remove" | "switch", rawId: string): Promise<void> {
    const displayId = Number(rawId);

    if (!Number.isInteger(displayId)) {
        fail(`"${rawId}" is not a display id; list them: ${TOOL} record display list`);
        return;
    }

    const answer = await callRunning<{ chosen: number[] | null }>(new MeetingStore(), `displays.${method}`, {
        displayId,
    });

    if (answer) {
        ui.ok(`Recording displays ${answer.result.chosen?.join(", ") ?? "by the policy"} from now on.`);
    }
}

async function displayMode(raw: string): Promise<void> {
    const mode = parseDisplayPolicy(raw);

    if (mode === undefined) {
        fail(`"${raw}" is none of ${DISPLAY_POLICIES.join(", ")} or a screen index.`);
        return;
    }

    const answer = await callRunning(new MeetingStore(), "displays.mode", { mode });

    if (answer) {
        ui.ok(`Recording ${typeof mode === "number" ? `screen ${mode}` : mode} from now on.`);
    }
}

async function stop(): Promise<void> {
    const store = new MeetingStore();
    const current = readRecorderState(store);
    const answer = await callRunning(store, "stop");

    if (!answer) {
        return;
    }

    ui.dim("Asked the recorder to stop; it converts the frames of its current piece first.");
    const stopped = await waitFor(() => !readRecorderState(store).running, STOP_WAIT_MS);

    if (!stopped) {
        fail(`The recorder is still running after ${STOP_WAIT_MS / 1000} s (pid ${current.state?.pid}).`);
        return;
    }

    const record = current.state ? store.read(current.state.meetingId) : undefined;
    const recording = record?.recording;
    ui.ok(`Stopped ${record?.id ?? ""}: ${recording?.frames ?? 0} frames, ${formatBytes(recording?.bytes ?? 0)}.`);

    if (recording?.warning) {
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
    const live =
        current.running && current.state
            ? await callRecorder<LiveEntry>({ id: meetingLiveId(current.state.meetingId), method: "status" }).catch(
                  (err: unknown) => {
                      log.debug({ err }, "recorder status over its socket failed");
                      return undefined;
                  }
              )
            : undefined;

    if (opts.json) {
        out.result(SafeJSON.stringify({ ...current, ...(live ? { live } : {}) }, null, 2));
        return;
    }

    if (!current.running || !current.state) {
        ui.info("Nothing is recording.");
        return;
    }

    const state = current.state;
    const paused = live ? live.state === "paused" : state.paused;
    const displays = live?.displays.length
        ? live.displays.map((display) => `${display.name} (${display.id})`).join(", ")
        : stateDisplays(state);
    ui.ok(
        `${paused ? "Paused" : "Recording"} ${state.meetingId} since ${localTime(state.startedAt)} (${displays}, ${state.backend ?? "peekaboo"}, pid ${state.pid})`
    );
    ui.dim(
        `${live?.frames ?? state.frames} frames, ${formatBytes(state.bytes)}${state.lastFrameAt ? `, last at ${localTime(state.lastFrameAt)}` : ""}`
    );
    const framesDir = join(store.folder(state.meetingId), "frames");

    if (existsSync(framesDir)) {
        const names = new Map([...(state.displays ?? []), ...(live?.displays ?? [])].map((one) => [one.id, one.name]));
        const perDisplay = [...framesOnDisk(framesDir).perDisplay].sort(([a], [b]) => a - b);

        if (perDisplay.length > 0) {
            ui.dim(
                `frames per display: ${perDisplay.map(([id, count]) => `${names.get(id) ?? "display"} (${id}) ${count}`).join(", ")}`
            );
        }
    }

    ui.dim(`folder: ${store.folder(state.meetingId)}`);

    if (!live) {
        ui.warn("The recorder does not answer on its socket; it may be from an older version.");
    }

    const warning = live?.warning ?? state.warning;

    if (warning) {
        ui.warn(warning);
    }
}

async function runCommand(id: string, opts: { display?: string }): Promise<void> {
    const store = new MeetingStore();

    try {
        const config = await new MeetingsConfigStore().read();
        const display = opts.display === undefined ? undefined : parseDisplayPolicy(opts.display);
        await runRecorder({ store, meetingId: id, display, capture: config.global.capture });
    } catch (err) {
        log.error({ err, id }, "recorder failed");
        process.exitCode = 1;
    }
}

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

    const zero = Date.parse(record.recording?.clock?.startedAt ?? record.start);
    const target = zero + atSec * 1000;
    const lines: OcrLine[] = readFileSync(ocrPath, "utf8")
        .split("\n")
        .filter((row) => row.trim())
        .map((row) => ocrLineSchema.parse(SafeJSON.parse(row, { strict: true })));
    const spans = recordedSpans(record);
    const { displays, recorded } = framesAtPerDisplay({ lines, spans, targetMs: target, windowMs: windowSec * 1000 });
    const frames = displays.flatMap((display) => display.frames);
    const clockOf = (ms: number): string => formatClock(Math.max(0, (ms - zero) / 1000));

    if (opts.json) {
        out.result(
            SafeJSON.stringify(
                frames.map((line) => ({ ...line, meetingSec: (Date.parse(line.at) - zero) / 1000 })),
                null,
                2
            )
        );
        return;
    }

    if (!recorded) {
        const ran = spans.map((span) => `${clockOf(span.fromMs)}–${clockOf(span.toMs)}`).join(", ");
        ui.warn(
            `The screen was not recorded at ${formatClock(atSec)}.${ran ? ` The recording ran ${ran}.` : ""}${frames.length > 0 ? " The frames near it:" : ""}`
        );
    }

    const names = new Map((record.recording?.displays ?? []).map((display) => [display.id, display.name]));

    for (const display of displays) {
        if (display.displayId !== undefined && (displays.length > 1 || names.size > 1)) {
            out.println(`## ${names.get(display.displayId) ?? "display"} (${display.displayId})`);
        }

        for (const line of display.frames) {
            const since = line.unchanged
                ? ` (still on the screen at ${formatClock(atSec)}: nothing changed since)`
                : "";
            out.println(`── ${clockOf(Date.parse(line.at))}${since}  ${join(store.folder(record.id), line.file)}`);
            out.println(line.text.trim() || "(no text)");
        }
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
        .option(
            "--display <which>",
            "all, follow-focus, main or a screen index (default: the capture.displays setting, all)"
        )
        .option("-y, --yes", "never prompt (project, permissions)")
        .action(start);

    record.command("stop").description("Stop the recording and write its summary into the meeting").action(stop);
    record
        .command("pause")
        .description("Pause the recording; the time paused is not recorded")
        .action(() => pauseOrResume("pause"));
    record
        .command("resume")
        .description("Record again after a pause")
        .action(() => pauseOrResume("resume"));
    const display = record
        .command("display")
        .description("Which displays a running recording records; applies at once");
    display
        .command("list")
        .description("The connected displays; ● marks those recorded")
        .option("--json", "print JSON")
        .action(displayList);
    display
        .command("add")
        .argument("<displayId>", "a display id from record display list")
        .description("Record this display too")
        .action((id: string) => displayChange("add", id));
    display
        .command("remove")
        .argument("<displayId>", "a display id from record display list")
        .description("Stop recording this display")
        .action((id: string) => displayChange("remove", id));
    display
        .command("switch")
        .argument("<displayId>", "a display id from record display list")
        .description("Record only this display")
        .action((id: string) => displayChange("switch", id));
    display
        .command("mode")
        .argument("<mode>", `${DISPLAY_POLICIES.join(", ")} or a screen index`)
        .description("Record by a policy again, instead of chosen displays")
        .action(displayMode);
    record.command("status").description("What is being recorded").option("--json", "print JSON").action(status);
    record
        .command("run", { hidden: true })
        .argument("<meeting>", "the meeting id")
        .option("--display <which>", "all, follow-focus, main or a screen index")
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
