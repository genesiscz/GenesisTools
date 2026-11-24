import type { AgentInstructionSeverity, AgentInstructions } from "@genesiscz/utils/ai/agent-instructions";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import type { NoticeInput } from "@genesiscz/utils/genesis-tools/areas/person/request";
import { sha256Json } from "@genesiscz/utils/hash";
import { logger } from "@genesiscz/utils/logger";
import type { DecisionActor, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { shellWord } from "@genesiscz/utils/shell/quote";
import { sandboxInstalled } from "@genesiscz/utils/storage/real-home-guard";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { errorText, TOOL } from "./shared";

/** The part of the person area the meetings tools call. */
export type MeetingReviewDoor = { person: Pick<AreaClients["person"], "windowNotice"> };

/** Call after the record is saved. A delivery failure is a warning on the completed run. */
export async function requestMeetingQuestionReview(options: {
    actor: DecisionActor;
    runId: string;
    record: Pick<MeetingRecord, "id" | "title" | "items">;
    gt?: MeetingReviewDoor;
}): Promise<string | undefined> {
    const { actor, record, runId } = options;
    if (actor.kind !== "agent") {
        return;
    }

    const pending = record.items.some(
        (item) =>
            item.kind === "question" &&
            item.status === "suggested" &&
            (item.about === "dictionary" || (item.about === "term" && item.group === "words"))
    );
    if (!pending) {
        return;
    }

    // A click opens the Items tab. The command stays in the text for the request window and for a terminal.
    const command = `${TOOL} window ${shellWord(record.id)} --tab items`;
    // A sandbox home (GENESIS_TOOLS_HOME elsewhere: probes, measures, copies) must not reach the real person:
    // the app and its notifications are shared by every home on this Mac.
    if (!options.gt && sandboxInstalled()) {
        return `Sandbox home ${env.tools.getHome()}: no review request was sent. Open Items with ${command}`;
    }
    try {
        const gt = options.gt ?? (await import("@genesiscz/utils/genesis-tools")).gt;
        const outcome = await gt.person.windowNotice({
            id: `meeting-questions:${sha256Json([record.id, runId])}`,
            title: "Meeting words need your review",
            reason: `Review the word questions in the Items tab for ${record.title || record.id}.\n${command}`,
            open: { window: "--meetings", args: ["--meeting", record.id, "--tab", "items"] },
        });
        if (outcome.status === "unreachable") {
            return outcome.manual ?? `The meeting review request could not reach you. Open Items with ${command}`;
        }

        if (outcome.value.status === "failed" || outcome.value.status === "unreachable") {
            return outcome.value.reason ?? `The meeting review request failed. Open Items with ${command}`;
        }
    } catch (error) {
        return `Could not post the meeting review request: ${errorText(error)}`;
    }
}

/** The part of the person area that asks the user to confirm a voice sample. */
export type VoiceSampleConfirmDoor = { person: Pick<AreaClients["person"], "confirm"> };

/** The interval a caller wants kept as one person's voice sample, and the command or call that saves it. */
export interface VoiceSampleAsk {
    record: Pick<MeetingRecord, "id" | "title">;
    fromSec: number;
    toSec: number;
    person: string;
    /** The physical source channel of a legacy enrolment (`voices enroll`). */
    channel?: 0 | 1;
    /** What saves the sample; an agent runs it again after the user confirmed in the window. */
    rerun: string;
}

/**
 * Who confirmed a saved sample: the person who ran the command (`caller`), or the user in the request window that an
 * agent's run opened (`request`: its id in the request journal, which also names the asking agent, and how the user
 * answered).
 */
export type VoiceSampleConfirmer =
    | { kind: "caller"; actor: DecisionActor["kind"] }
    | { kind: "request"; request: string; via: string | null; method: string | null };

export type VoiceSampleConfirmation =
    | { confirmed: true; by: VoiceSampleConfirmer; record?: VoiceSampleAsk["record"] }
    | { confirmed: false; instructions: AgentInstructions };

/** One person request per meeting, interval, person and channel: an agent's run again reads the user's answer. */
export function voiceSampleRequestId(ask: Omit<VoiceSampleAsk, "rerun">): string {
    return `voice-sample:${sha256Json([ask.record.id, ask.fromSec, ask.toSec, ask.person.trim(), ask.channel ?? null])}`;
}

/** The command that plays the interval, so the user hears it before confirming. */
export function voiceSamplePlayCommand(ask: Pick<VoiceSampleAsk, "record" | "fromSec" | "toSec">): string {
    return `${TOOL} play ${shellWord(ask.record.id)} --at ${formatClock(ask.fromSec)} --to ${formatClock(Math.ceil(ask.toSec))}`;
}

/** The words on the window's answering buttons. */
const CONFIRM_SAMPLE = "Confirm sample";
const NOT_NOW = "Not now";

/**
 * What the confirmation window shows (D443): who asks and what a confirmation means as the text, the meeting, the time
 * and the person as rows, a Play button for exactly the confirmed range, and Confirm sample / Not now as the answers.
 */
function voiceSampleRequest(
    ask: VoiceSampleAsk,
    actor: Extract<DecisionActor, { kind: "agent" }>,
    id: string
): NoticeInput {
    const session = actor.session ? `, session ${actor.session}` : "";
    return {
        kind: "notice",
        id,
        title: `Confirm a voice sample of ${ask.person}`.slice(0, 200),
        reason: `An agent (${actor.harness}${session}) asks whether only ${ask.person} speaks in this part of the meeting. ${CONFIRM_SAMPLE} lets the agent save it as a voice sample; ${NOT_NOW} saves nothing.`,
        fields: [
            { label: "Meeting", value: ask.record.title || ask.record.id, help: ask.record.id },
            { label: "Time", value: `${formatClock(ask.fromSec)} to ${formatClock(Math.ceil(ask.toSec))}` },
            { label: "Person", value: ask.person },
            ...(ask.channel === undefined ? [] : [{ label: "Channel", value: String(ask.channel) }]),
        ],
        actions: [
            {
                kind: "play-meeting",
                label: "Play clip",
                meeting: ask.record.id,
                fromSec: ask.fromSec,
                toSec: ask.toSec,
            },
        ],
        buttons: { confirm: CONFIRM_SAMPLE, decline: NOT_NOW },
    };
}

function stopped(severity: AgentInstructionSeverity, lines: string[]): VoiceSampleConfirmation {
    return { confirmed: false, instructions: { text: lines.join("\n"), severity, stop: true } };
}

/**
 * Whether a voice sample may be saved as confirmed, and by whom. A person who runs the command confirms it with
 * --confirmed. An agent never confirms it itself: with --confirmed its run asks the user in the person area's
 * confirmation window (D443), and only the user's answer there saves the sample. The person area never makes an agent
 * wait for a person, so the first run returns instructions to stop, and the same run after the user confirmed saves.
 */
export async function confirmVoiceSample(options: {
    actor: DecisionActor;
    /** The caller passed --confirmed (in the REPL, confirmed: true). */
    confirmed: boolean;
    /** Read only for an agent's run, so a person's run looks nothing up. */
    ask: () => VoiceSampleAsk;
    gt?: VoiceSampleConfirmDoor;
}): Promise<VoiceSampleConfirmation> {
    const { actor } = options;

    if (actor.kind !== "agent") {
        if (!options.confirmed) {
            throw new Error("Listen to this interval first, then run the command again with --confirmed.");
        }

        return { confirmed: true, by: { kind: "caller", actor: actor.kind } };
    }

    const ask = options.ask();

    if (!Number.isFinite(ask.fromSec) || !Number.isFinite(ask.toSec) || ask.fromSec < 0 || ask.toSec <= ask.fromSec) {
        throw new Error("Give a valid --from/--to interval.");
    }

    const span = `${formatClock(ask.fromSec)} to ${formatClock(Math.ceil(ask.toSec))} of ${ask.record.id}`;
    const listen = voiceSamplePlayCommand(ask);
    const outside = `Ask the user to run it in their own terminal, outside the agent: ${ask.rerun}`;

    if (!options.confirmed) {
        return stopped("info", [
            "Nothing was saved: only the user can confirm a voice sample.",
            `Ask the user to listen to ${span} (${listen}) and to say whether only ${ask.person} speaks there.`,
            `When the user says yes, run: ${ask.rerun}`,
            "That opens a confirmation window for the user; the sample is saved only after the user confirms there.",
        ]);
    }

    // A sandbox home (GENESIS_TOOLS_HOME elsewhere: probes, measures, copies) must not reach the real person.
    if (!options.gt && sandboxInstalled()) {
        return stopped("error", [
            `This run uses the sandbox home ${env.tools.getHome()}, so no confirmation window reached the user and nothing was saved.`,
            "Run it with the user's own home to ask the user.",
        ]);
    }

    const request = voiceSampleRequestId(ask);
    let outcome: Awaited<ReturnType<VoiceSampleConfirmDoor["person"]["confirm"]>>;

    try {
        const gt = options.gt ?? (await import("@genesiscz/utils/genesis-tools")).gt;
        outcome = await gt.person.confirm(voiceSampleRequest(ask, actor, request));
    } catch (error) {
        logger.warn({ error, request }, "voice sample: the confirmation request could not be posted");
        return stopped("error", [
            `The confirmation request could not be posted (${errorText(error)}). Nothing was saved.`,
            outside,
        ]);
    }

    if (outcome.status === "unreachable") {
        const why = outcome.manual ?? outcome.skipped.map((skip) => skip.reason).join("; ");
        return stopped("error", [`No confirmation window could reach the user (${why}). Nothing was saved.`, outside]);
    }

    const answer = outcome.value;
    logger.debug(
        { request, status: answer.status, via: answer.via, method: answer.method },
        "voice sample: the user's answer"
    );

    if (answer.status === "done") {
        return {
            confirmed: true,
            by: { kind: "request", request, via: answer.via ?? null, method: answer.method ?? null },
            record: ask.record,
        };
    }

    if (answer.status === "pending") {
        return stopped("info", [
            `A confirmation window asks the user now (request ${request}). Nothing was saved yet.`,
            `Ask the user to listen to ${span} (${listen}) and to answer that window.`,
            `After the user confirms there, run the same command again; it saves the sample then: ${ask.rerun}`,
            `The answer so far: ${toolCommand("genesis-tools", "request", "show", request)}`,
        ]);
    }

    if (answer.status === "declined") {
        return stopped("error", [
            `The user answered ${NOT_NOW} in the confirmation window (request ${request}). Nothing was saved.`,
            "Do not ask again for this interval unless the user tells you to.",
            outside,
        ]);
    }

    return stopped("error", [
        `The confirmation request ended ${answer.status}${answer.reason ? `: ${answer.reason}` : ""} (request ${request}). Nothing was saved.`,
        outside,
    ]);
}
