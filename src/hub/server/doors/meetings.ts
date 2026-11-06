import { asResult } from "@genesiscz/utils/cli/result";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { parseArgv, stringFlag, wholeNumber } from "../argv";
import type { CallResult } from "../protocol";
import { type CallDoor, DoorUnsupported, ok } from "./types";

const { log } = logger.scoped("hub-server-meetings");

/**
 * The reads the Meetings window makes (`tools meetings … --json`), answered in the resident server: as a process each
 * paid about 330 ms of CPU to start before 5 to 300 ms of work (2026-11-06, MeetingsPerf report MP1). Each door calls
 * the same `window-reads` function as its command and prints it with the same `windowJson`, so the bytes are equal.
 * A door answers only the success path of an exact meeting id: a prefix, `last`, a missing meeting or any error
 * goes back to the process (`DoorUnsupported`), so the CLI's own words and exit codes stay. Writes and
 * `assign proposals` (it reads the Calendar, which is TCC-gated) stay processes.
 */

/** A meeting folder name: no separators, no leading dot, so it can only name a folder of the store. */
const MEETING_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const reads = () => import("@app/meetings/lib/window-reads");

async function answer(signal: AbortSignal, read: () => Promise<unknown>): Promise<CallResult> {
    signal.throwIfAborted();
    let value: unknown;
    try {
        value = await read();
    } catch (error) {
        if (error instanceof DoorUnsupported) {
            throw error;
        }

        log.debug({ error }, "meetings read failed in the server; the process answers it with its own message");
        throw new DoorUnsupported(error instanceof Error ? error.message : String(error));
    }

    const { windowJson } = await reads();
    return ok(asResult(windowJson(value)));
}

/** The record of an exact id, read alone (no listing of the store); anything else is the process's job. */
async function exactRecord(ref: string): Promise<{ store: MeetingStore; record: MeetingRecord }> {
    const { MeetingStore } = await import("@genesiscz/utils/meetings/record");
    const store = new MeetingStore();
    const record = MEETING_ID.test(ref) ? store.read(ref) : undefined;
    if (!record) {
        throw new DoorUnsupported(`not an exact meeting id: ${ref}`);
    }

    return { store, record };
}

/**
 * The server reads a transcript only from this Mac's Wispr Flow database. Without the local meeting the source
 * would ask Wispr's remote MCP, which needs the network and a credential: that stays the process's job.
 */
async function requireLocalSource(record: MeetingRecord): Promise<void> {
    const { sourceRefOf } = await import("@app/meetings/lib/sources");
    const ref = sourceRefOf(record);
    if (ref?.sourceId !== "wisprflow") {
        throw new DoorUnsupported(`${record.id}: no local transcript source`);
    }

    const { hasLocalMeeting, localAvailable } = await import("@app/wisprflow/lib/local");
    if (!localAvailable() || !hasLocalMeeting(ref.sourceMeetingId)) {
        throw new DoorUnsupported(`${record.id}: the Wispr Flow meeting is not on this Mac`);
    }
}

/** `meetings overview --days <n> --json`. */
export const meetingsOverviewDoor: CallDoor<{ days: number }> = {
    kind: "call",
    name: "meetings overview --json",
    command: ["meetings", "overview"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "overview"],
            positionals: 0,
            flags: { "--days": "value", "--json": "bool" },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const days = parsed.flags.has("--days") ? wholeNumber(parsed.flags.get("--days")) : 14;
        return days === null || days === 0 ? null : { days };
    },
    async run({ days }, { signal }) {
        return answer(signal, async () => (await reads()).overviewRead({ days, now: new Date() }));
    },
};

/** `meetings config show --json` (the whole config; a path stays a process). */
export const meetingsConfigShowDoor: CallDoor<true> = {
    kind: "call",
    name: "meetings config show --json",
    command: ["meetings", "config", "show"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "config", "show"],
            positionals: 0,
            flags: { "--json": "bool" },
        });
        return parsed?.flags.get("--json") === true ? true : null;
    },
    async run(_parsed, { signal }) {
        return answer(signal, async () => (await reads()).configShowRead());
    },
};

/** `meetings show <id> --json`. */
export const meetingsShowDoor: CallDoor<{ ref: string }> = {
    kind: "call",
    name: "meetings show --json",
    command: ["meetings", "show"],
    match(argv) {
        const parsed = parseArgv(argv, { command: ["meetings", "show"], positionals: 1, flags: { "--json": "bool" } });
        return parsed?.flags.get("--json") === true ? { ref: parsed.positionals[0] } : null;
    },
    async run({ ref }, { signal }) {
        return answer(signal, async () => (await exactRecord(ref)).record);
    },
};

/** `meetings transcript <id> --format json` (any other flag or format stays a process). */
export const meetingsTranscriptDoor: CallDoor<{ ref: string }> = {
    kind: "call",
    name: "meetings transcript --format json",
    command: ["meetings", "transcript"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "transcript"],
            positionals: 1,
            flags: { "--format": "value" },
        });
        return parsed && stringFlag(parsed, "--format") === "json" ? { ref: parsed.positionals[0] } : null;
    },
    async run({ ref }, { signal }) {
        return answer(signal, async () => {
            const { store, record } = await exactRecord(ref);
            await requireLocalSource(record);
            const { correctedTranscriptRead, transcriptJsonView } = await reads();
            // The flags commander hands the command for `--format json`: `--no-dictionary` and `--no-frontmatter`
            // default to true.
            const { applied } = await correctedTranscriptRead({
                store,
                record,
                format: "json",
                flags: { dictionary: true, frontmatter: true },
            });
            return transcriptJsonView(record, applied);
        });
    },
};

/** `meetings speakers stats <id> --json` (`--gap` and `--attendance` stay a process). */
export const meetingsSpeakerStatsDoor: CallDoor<{ ref: string }> = {
    kind: "call",
    name: "meetings speakers stats --json",
    command: ["meetings", "speakers", "stats"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "speakers", "stats"],
            positionals: 1,
            flags: { "--json": "bool" },
        });
        return parsed?.flags.get("--json") === true ? { ref: parsed.positionals[0] } : null;
    },
    async run({ ref }, { signal }) {
        return answer(signal, async () => {
            const { store, record } = await exactRecord(ref);
            await requireLocalSource(record);
            const { DEFAULT_SPAN_GAP_SEC } = await import("@genesiscz/utils/transcribe/speakers");
            return (await reads()).speakerStatsRead({ store, record, gapSec: DEFAULT_SPAN_GAP_SEC });
        });
    },
};

/** `meetings screen <id> --timeline --json [--all]`. */
export const meetingsScreenTimelineDoor: CallDoor<{ ref: string; all: boolean }> = {
    kind: "call",
    name: "meetings screen --timeline --json",
    command: ["meetings", "screen"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "screen"],
            positionals: 1,
            flags: { "--timeline": "bool", "--json": "bool", "--all": "bool" },
        });
        if (parsed?.flags.get("--timeline") !== true || parsed.flags.get("--json") !== true) {
            return null;
        }

        return { ref: parsed.positionals[0], all: parsed.flags.get("--all") === true };
    },
    async run({ ref, all }, { signal }) {
        return answer(signal, async () => {
            const { store, record } = await exactRecord(ref);
            const { screenTimeline } = await import("@app/meetings/lib/screen-timeline");
            return screenTimeline({ store, record, all });
        });
    },
};

/** `meetings record cost --json`. */
export const meetingsRecordCostDoor: CallDoor<true> = {
    kind: "call",
    name: "meetings record cost --json",
    command: ["meetings", "record", "cost"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "record", "cost"],
            positionals: 0,
            flags: { "--json": "bool" },
        });
        return parsed?.flags.get("--json") === true ? true : null;
    },
    async run(_parsed, { signal }) {
        return answer(signal, async () => (await reads()).captureCostRead());
    },
};

/** `meetings projects preview --json [--draft <json>]` (`--limit` stays a process). */
export const meetingsProjectsPreviewDoor: CallDoor<{ draft?: string }> = {
    kind: "call",
    name: "meetings projects preview --json",
    command: ["meetings", "projects", "preview"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "projects", "preview"],
            positionals: 0,
            flags: { "--json": "bool", "--draft": "value" },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const draft = stringFlag(parsed, "--draft");
        return draft === undefined ? {} : { draft };
    },
    async run({ draft }, { signal }) {
        return answer(
            signal,
            async () => (await (await reads()).matchPreviewRead(draft === undefined ? {} : { draft })).rows
        );
    },
};

/** `meetings dictionary show --json [--project <p>]`. */
export const meetingsDictionaryShowDoor: CallDoor<{ project?: string }> = {
    kind: "call",
    name: "meetings dictionary show --json",
    command: ["meetings", "dictionary", "show"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "dictionary", "show"],
            positionals: 0,
            flags: { "--json": "bool", "--project": "value" },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const project = stringFlag(parsed, "--project");
        return project === undefined ? {} : { project };
    },
    async run({ project }, { signal }) {
        return answer(signal, async () => {
            const { MeetingsConfigStore } = await import("@genesiscz/utils/meetings/config");
            return (await reads()).dictionaryShowRead(await new MeetingsConfigStore().read(), project);
        });
    },
};

/** `meetings dictionary test <phrase> --json [--project <p>]`. */
export const meetingsDictionaryTestDoor: CallDoor<{ phrase: string; project?: string }> = {
    kind: "call",
    name: "meetings dictionary test --json",
    command: ["meetings", "dictionary", "test"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["meetings", "dictionary", "test"],
            positionals: 1,
            flags: { "--json": "bool", "--project": "value" },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const project = stringFlag(parsed, "--project");
        return { phrase: parsed.positionals[0], ...(project === undefined ? {} : { project }) };
    },
    async run({ phrase, project }, { signal }) {
        return answer(signal, async () => {
            const { MeetingsConfigStore } = await import("@genesiscz/utils/meetings/config");
            const { testPhrase } = await import("@app/meetings/lib/dictionary-test");
            return testPhrase(await new MeetingsConfigStore().read(), { phrase, ...(project ? { project } : {}) });
        });
    },
};

export const MEETINGS_DOORS: readonly CallDoor[] = [
    meetingsOverviewDoor,
    meetingsConfigShowDoor,
    meetingsShowDoor,
    meetingsTranscriptDoor,
    meetingsSpeakerStatsDoor,
    meetingsScreenTimelineDoor,
    meetingsRecordCostDoor,
    meetingsProjectsPreviewDoor,
    meetingsDictionaryShowDoor,
    meetingsDictionaryTestDoor,
];
