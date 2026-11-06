import { readFileSync } from "node:fs";
import { itemWhat } from "@app/meetings/lib/item-text";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { isMeetingPlatformId } from "@genesiscz/utils/meetings/platform";
import {
    ITEM_STATUSES,
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
    QUESTION_TOPICS,
} from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import type { CorrectionOutcome } from "@genesiscz/utils/transcribe/apply";
import {
    entriesToSrt,
    entriesToVtt,
    groupTurns,
    localTime,
    TRANSCRIPT_FORMATS,
    transcriptTextLines,
} from "@genesiscz/utils/transcribe/render";
import { DEFAULT_SPAN_GAP_SEC } from "@genesiscz/utils/transcribe/speakers";
import type { Command } from "commander";
import pc from "picocolors";
import { z } from "zod";
import { prepareFindings } from "../lib/add-findings";
import { decideItems, reopenItems } from "../lib/decide";
import { FINDING_KINDS, findingProblems, findingSchema, findingsFileSchema } from "../lib/findings";
import { OpenedMeeting } from "../lib/opened-meeting";
import { MEETING_PLATFORMS } from "../lib/platforms";
import { questionLabel, questionWarnings } from "../lib/questions";
import { errorText, fail, formatFlag, resolveEnum, TOOL } from "../lib/shared";
import { meetingTranscript } from "../lib/sources";
import { printSpeakerStats } from "../lib/speakers-view";
import { isSuggestRule, SUGGEST_RULES } from "../lib/suggest";
import { runSuggest } from "../lib/suggest-run";
import { correctTranscript, outcomeText } from "../lib/transcript-corrections";
import { correctedTranscriptRead, speakerStatsRead, transcriptJsonView, windowJson } from "../lib/window-reads";
import { DEFAULT_WORD_CHECK, WORD_CHECKS } from "../lib/word-check";

const { log } = logger.scoped("meetings-items");

const MEETING_REF = "meeting id, a unique prefix, last, or wisprflow:<id>";

function requireMeeting(store: MeetingStore, ref: string): MeetingRecord | undefined {
    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
        }

        return record;
    } catch (err) {
        fail(errorText(err));
        return undefined;
    }
}

async function loadTranscript(store: MeetingStore, record: MeetingRecord): Promise<SourceMeeting> {
    return OpenedMeeting.of(store, record).meeting();
}

const STATUS_COLOR: Record<MeetingItem["status"], (text: string) => string> = {
    suggested: pc.yellow,
    confirmed: pc.green,
    rejected: pc.dim,
};

function printItems(record: MeetingRecord, items: MeetingItem[]): void {
    const table = createBoxTable(["ID", "Q", "KIND", "STATUS", "CONF", "WHAT", "RULES"]);

    for (const item of items) {
        table.push([
            pc.white(item.id),
            item.kind === "question" ? pc.cyan(questionLabel(record, item.id)) : "",
            item.kind,
            STATUS_COLOR[item.status](item.status),
            item.confidence === undefined ? "—" : `${Math.round(item.confidence * 100)} %`,
            truncateDisplay(itemWhat(item), 90),
            item.rules.join(", "),
        ]);
    }

    out.println(table.toString());
}

async function suggest(
    ref: string,
    opts: { rules?: string; attendance?: string; wordCheck?: string; json?: boolean }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const asked = (opts.rules ?? SUGGEST_RULES.join(",")).split(",").map((rule) => rule.trim());
    const rules = asked.filter(isSuggestRule);
    const unknown = asked.filter((rule) => !isSuggestRule(rule));

    if (unknown.length > 0) {
        fail(`Unknown rule set ${unknown.join(", ")}. Known: ${SUGGEST_RULES.join(", ")}`);
        return;
    }

    // Without --word-check each language uses its own provider (`languages.<code>.wordCheck`).
    const wordCheckChoice =
        opts.wordCheck === undefined
            ? undefined
            : await resolveEnum({
                  value: opts.wordCheck,
                  values: WORD_CHECKS,
                  flag: "--word-check",
                  subcommand: ["suggest"],
              });

    if (opts.wordCheck !== undefined && !wordCheckChoice) {
        return;
    }

    try {
        const { fresh, retired, warnings } = await runSuggest({
            store,
            record,
            rules,
            attendance: opts.attendance,
            wordCheck: wordCheckChoice,
        });

        for (const warning of warnings) {
            ui.warn(warning);
        }

        if (opts.json) {
            out.result(SafeJSON.stringify(fresh, null, 2));
            return;
        }

        if (retired.length > 0) {
            ui.info(
                `Retired ${retired.length} suggestions the dictionary or the slang rule settles now: ${retired.join(" ")}`
            );
        }

        if (fresh.length === 0) {
            ui.info("Nothing new to suggest.");
            return;
        }

        printItems(store.read(record.id) ?? record, fresh);
        ui.dim(`Confirm or reject: ${TOOL} confirm ${record.id} <ids> · ${TOOL} reject ${record.id} <ids>`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function items(ref: string, opts: { status?: string | boolean; kind?: string; json?: boolean }): Promise<void> {
    const record = requireMeeting(new MeetingStore(), ref);

    if (!record) {
        return;
    }

    const status =
        opts.status === undefined
            ? undefined
            : await resolveEnum({ value: opts.status, values: ITEM_STATUSES, flag: "--status", subcommand: ["items"] });

    if (opts.status !== undefined && !status) {
        return;
    }

    const kind =
        opts.kind === undefined
            ? undefined
            : await resolveEnum({ value: opts.kind, values: FINDING_KINDS, flag: "--kind", subcommand: ["items"] });

    if (opts.kind !== undefined && !kind) {
        return;
    }

    const listed = record.items.filter((item) => (!status || item.status === status) && (!kind || item.kind === kind));

    if (opts.json) {
        out.result(SafeJSON.stringify(listed, null, 2));
        return;
    }

    if (listed.length === 0) {
        ui.info(`No items. Suggest some: ${TOOL} suggest ${record.id}`);
        return;
    }

    printItems(record, listed);
}

interface AddOptions {
    kind?: string;
    listen?: boolean;
    fromFile?: string;
    from?: string;
    to?: string;
    at?: string;
    label?: string;
    speaker?: string;
    heard?: string;
    proposed?: string;
    scope?: string;
    joined?: string;
    about?: string;
    question?: string;
    choices?: string;
    decides?: string;
    confidence?: string;
    priority?: string;
    reason?: string;
}

function commaList(value: string | undefined): string[] | undefined {
    return value === undefined
        ? undefined
        : value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean);
}

/** The finding the flags describe, in the shape a `--from-file` entry has, before validation. */
function findingFromFlags(opts: AddOptions): Record<string, unknown> {
    const kind = opts.listen ? "question" : (opts.kind ?? "question");
    const fields: Record<string, unknown> = {
        kind,
        from: opts.from,
        to: opts.to,
        at: opts.at,
        label: opts.label,
        speaker: opts.speaker,
        heard: opts.heard,
        proposed: opts.proposed,
        scope: opts.scope,
        joined: opts.joined,
        about: opts.about,
        question: opts.question,
        choices: commaList(opts.choices),
        decides: commaList(opts.decides),
        confidence: opts.confidence === undefined ? undefined : Number(opts.confidence),
        priority: opts.priority === undefined ? undefined : Number(opts.priority),
        reason: opts.reason,
        ...(kind === "label" ? { meaningless: true } : {}),
    };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * `items add`: an agent's finding (a speaker range or a term, with a confidence and a reason) or a question to answer
 * by ear. `--from-file` adds a whole batch in one write; a batch with one bad entry adds nothing.
 */
async function addItems(ref: string, own: AddOptions, command: Command): Promise<void> {
    // The parent `items` has a `--kind` filter of its own, and Commander gives a shared flag to the parent.
    const parentKind = command.parent?.opts<{ kind?: string }>().kind;
    const opts: AddOptions = { ...own, ...(own.kind === undefined && parentKind ? { kind: parentKind } : {}) };
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    let raw: unknown;

    try {
        raw = opts.fromFile
            ? SafeJSON.parse(readFileSync(opts.fromFile, "utf8"), { strict: true })
            : [findingFromFlags(opts)];
    } catch (err) {
        fail(`--from-file ${opts.fromFile}: ${errorText(err)}`);
        return;
    }

    const parsed = findingsFileSchema.safeParse(raw);

    if (!parsed.success) {
        // The union's own message says only "Invalid input"; the entries' schema names the field.
        const entries = Array.isArray(raw) ? raw : [raw];
        const issue = z.array(findingSchema).safeParse(entries).error?.issues[0] ?? parsed.error.issues[0];
        const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
        fail(`Not a finding${where}: ${issue?.message ?? "invalid"}. Kinds: ${FINDING_KINDS.join(", ")}.`);
        return;
    }

    const problems = findingProblems(parsed.data, record.items);

    if (problems.length > 0) {
        fail(`Nothing added: ${problems.join("; ")}`);
        return;
    }

    // The transcript anchors each join and line-bound term to one line; with no source at hand, items are added as given.
    const meeting = await loadTranscript(store, record).catch((err: unknown) => {
        log.debug({ err, meeting: record.id }, "no transcript to check the anchors against");
        return undefined;
    });

    try {
        let added: MeetingItem[] = [];
        let anchorWarnings: string[] = [];
        const updated = await store.update(
            record.id,
            { command: "items add", change: `${parsed.data.length} findings` },
            (current) => {
                const prepared = prepareFindings({
                    findings: parsed.data,
                    items: current.items,
                    transcript: meeting?.transcript,
                });
                added = prepared.added;
                anchorWarnings = prepared.warnings;
                current.items.push(...added);
            }
        );

        for (const warning of anchorWarnings) {
            ui.warn(warning);
        }

        if (meeting) {
            const ids = added.map((item) => item.id);
            const config = await new MeetingsConfigStore().read();
            const result = correctTranscript({
                record: updated,
                transcript: meeting.transcript,
                config,
                format: "txt",
                dictionary: false,
                include: ids,
            });
            reportOutcomes(result.outcomes.filter((outcome) => ids.includes(outcome.item)));
        }

        for (const warning of questionWarnings(updated, added)) {
            ui.warn(warning);
        }

        if (added.length === 1 && added[0]!.kind === "question") {
            const label = questionLabel(updated, added[0]!.id);
            ui.ok(
                `${label} (${added[0]!.id}) added to ${record.id}. Answer it: ${TOOL} listen ${record.id} --item ${label}`
            );
            return;
        }

        ui.ok(
            added.length === 1
                ? `${added[0]!.id} added to ${record.id}.`
                : `${added.length} items added to ${record.id} (${added[0]?.id} to ${added.at(-1)?.id}).`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

async function decide(
    status: "confirmed" | "rejected",
    ref: string,
    ids: string[],
    opts: { speaker?: string; proposed?: string; minConfidence?: string; json?: boolean }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const minConfidence = opts.minConfidence === undefined ? undefined : Number(opts.minConfidence);

    if (minConfidence !== undefined && Number.isNaN(minConfidence)) {
        fail(`--min-confidence ${opts.minConfidence} is not a number between 0 and 1 (0.8 = 80 %)`);
        return;
    }

    const flagOf = {
        speaker: " Confirm it with --speaker <name>.",
        proposed: " Confirm it with --proposed <text>.",
        listen: "",
        nothing: "",
    };
    // An item decided that way already is no failure; one that needs a value or an answer is.
    const failed = (skipped: Array<{ needs: string }>) => skipped.some((skip) => skip.needs !== "nothing");

    try {
        const result = await decideItems({
            store,
            record,
            status,
            ids,
            minConfidence,
            speaker: opts.speaker,
            proposed: opts.proposed,
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            process.exitCode = result.decided.length === 0 && failed(result.skipped) ? 1 : 0;
            return;
        }

        for (const skip of result.skipped) {
            skip.needs === "nothing"
                ? ui.info(`${skip.id}: ${skip.reason}`)
                : ui.warn(`${skip.id}: ${skip.reason}${flagOf[skip.needs]}`);
        }

        if (result.decided.length === 0) {
            process.exitCode = failed(result.skipped) ? 1 : 0;
            return;
        }

        ui.ok(
            `${status} ${result.decided.join(" ")} in ${record.id} (undo: ${TOOL} reopen ${record.id} ${result.decided.join(" ")} --token ${result.token})`
        );
    } catch (err) {
        fail(errorText(err).replace(/^minConfidence/, "--min-confidence"));
    }
}

async function reopen(ref: string, ids: string[], opts: { token?: string; json?: boolean }): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    try {
        const result = await reopenItems({ store, record, ids, ...(opts.token ? { token: opts.token } : {}) });

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            return;
        }

        for (const skip of result.skipped) {
            ui.warn(`${skip.id}: ${skip.reason}`);
        }

        if (result.reopened.length > 0) {
            ui.ok(`suggested again: ${result.reopened.join(" ")} in ${record.id}`);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

async function speakersStats(ref: string, opts: { gap?: string; attendance?: string; json?: boolean }): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const gapSec = opts.gap === undefined ? DEFAULT_SPAN_GAP_SEC : parseDuration(opts.gap) / 1000;

    if (!(gapSec > 0)) {
        fail(`--gap ${opts.gap} is not a duration (try 90s or 2m).`);
        return;
    }

    try {
        const stats = await speakerStatsRead({ store, record, gapSec, attendance: opts.attendance });

        if (opts.json) {
            out.result(windowJson(stats));
            return;
        }

        const from = opts.attendance ?? record.attendance?.from;
        const platform = from && isMeetingPlatformId(from) ? MEETING_PLATFORMS[from].label : undefined;
        printSpeakerStats(stats, platform ? { attendance: `${platform} attendance` } : {});
    } catch (err) {
        fail(errorText(err));
    }
}

async function speakersRename(ref: string, label: string, name: string): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    try {
        // A label the transcript does not have would rename nothing and say it did (MC11): name the labels instead.
        const labels = [...new Set((await meetingTranscript(record)).map((entry) => entry.speaker))];

        if (!labels.includes(label) && record.speakers.labels[label] === undefined) {
            fail(`${record.id} has no label "${label}". Its labels: ${labels.map((one) => `"${one}"`).join(", ")}`);
            return;
        }

        await store.renameSpeaker(record.id, label, name);
        ui.ok(
            name.trim() === label
                ? `${record.id}: ${label} is ${label} again (the rename is gone)`
                : `${record.id}: ${label} → ${name.trim()} (transcripts of this meeting use it now)`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

/** One warning per item that did not apply: `i42 did not apply: no "X" at 37:43`. */
function reportOutcomes(outcomes: CorrectionOutcome[]): void {
    for (const outcome of outcomes) {
        const text = outcomeText(outcome);

        if (text) {
            ui.warn(text);
        }
    }
}

async function transcript(
    ref: string,
    opts: {
        format?: string | boolean;
        json?: boolean;
        withSuggested?: boolean;
        dictionary?: boolean;
        timestamps?: boolean;
        playLinks?: boolean;
        frontmatter?: boolean;
    }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);
    const flag = formatFlag(opts);

    if (!flag) {
        return;
    }

    const format = await resolveEnum({
        value: flag.format,
        fallback: "md",
        values: TRANSCRIPT_FORMATS,
        flag: "--format",
        subcommand: ["transcript"],
    });

    if (!record || !format) {
        return;
    }

    try {
        const { markdown, applied } = await correctedTranscriptRead({ store, record, format, flags: opts });
        reportOutcomes(applied.outcomes);
        ui.dim(
            `applied: ${applied.labels} renamed lines, ${applied.ranges} re-attributed, ${applied.joins} joins, ${applied.terms} term fixes, ${applied.fixes} dictionary fixes, ${applied.spoken} spoken forms, ${applied.fuzzy} fuzzy, ${applied.expansions} expansions, ${applied.meanings} meanings, ${applied.marks} quotes and meanings of spoken words, ${applied.unclear} unclear marks`
        );

        if (markdown) {
            if (markdown.warning) {
                ui.warn(markdown.warning);
            }

            out.print(markdown.markdown);
            return;
        }

        if (format === "json") {
            out.result(windowJson(transcriptJsonView(record, applied)));
            return;
        }

        if (format === "srt" || format === "vtt") {
            out.print(format === "srt" ? entriesToSrt(applied.entries) : entriesToVtt(applied.entries));
            return;
        }

        out.print(
            `${[record.title, localTime(record.start), "", ...transcriptTextLines(groupTurns(applied.entries), opts.timestamps === true)].join("\n").trimEnd()}\n`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerItemCommands(program: Command): void {
    program
        .command("suggest")
        .argument("<meeting>", MEETING_REF)
        .description("Run the rules on the meeting's transcript and add what they find as suggested items")
        .option("--rules <list>", `which rule sets: ${SUGGEST_RULES.join(",")} (default all)`)
        .option(
            "--attendance <platform|file>",
            "who was in the call and when, for rule RA: a platform (teams) or its export file (teams:<file>)"
        )
        .option(
            "--word-check <provider>",
            `${WORD_CHECKS.join(" | ")}: tells ordinary Czech words from unknown ones for the term rules; the dictionaries download on first use (default: each language's languages.<code>.wordCheck, else ${DEFAULT_WORD_CHECK})`
        )
        .option("--json", "print the new items")
        .action(suggest);

    program
        .command("items")
        .argument("<meeting>", MEETING_REF)
        .description("The meeting's items with their status, confidence and rules")
        .option("--status [status]", ITEM_STATUSES.join(" | "))
        .option("--kind <kind>", "speaker-range | label | join | term | question")
        .option("--json", "print JSON")
        .action(items)
        .command("add")
        .argument("<meeting>", MEETING_REF)
        .description(
            `Add an agent's finding (a speaker range, a join or a term, with a confidence and a reason; a label that tracks no one person in a stretch, with a reason) or a question for ${toolCommand("meetings", "listen")}`
        )
        .option("--kind <kind>", `${FINDING_KINDS.join(" | ")} (default question)`)
        .option("--listen", "same as --kind question")
        .option("--from-file <json>", "a batch: an array of findings in the shape the flags make (see the README)")
        .option("--from <time>", "range start: 37:43, 1:02:10 or seconds (speaker-range, label, question)")
        .option("--to <time>", "range end (speaker-range, label, question)")
        .option("--at <time>", "term: where it is heard; join: the start of the line after the cut")
        .option(
            "--label <label>",
            "speaker-range: the source's label of those lines; label: the label that tracks no one person; join: whose voice speaks it"
        )
        .option("--speaker <name>", "speaker-range: who it really is")
        .option(
            "--heard <words>",
            "term: the words as the transcript has them; question: the words marked until answered"
        )
        .option("--proposed <text>", "term: the right spelling, when known")
        .option("--scope <scope>", "term: line (fix only the line at --at) or everywhere (default)")
        .option("--joined <word>", "join: the whole word the two lines make")
        .option("--about [topic]", `question: ${QUESTION_TOPICS.join(" | ")} (default speaker)`)
        .option("--question <text>", "question: what to decide, as the listener reads it")
        .option("--choices <list>", "question: comma-separated answers to offer")
        .option("--decides <ids>", "question: comma-separated items (or batch refs) the answer confirms or rejects")
        .option("--confidence <0..1>", "how sure the finding is (required for speaker-range, join and term)")
        .option(
            "--priority <n>",
            "question: (1 − confidence) × impact × reach, as suggest scores its own (about 1 to 3; under 0.5 asked only with --item)"
        )
        .option(
            "--reason <text>",
            "why: the facts and context it rests on (required for speaker-range, label, join and term)"
        )
        .action(addItems);

    for (const [name, status] of [
        ["confirm", "confirmed"],
        ["reject", "rejected"],
    ] as const) {
        const command = program
            .command(name)
            .argument("<meeting>", MEETING_REF)
            .argument("[items...]", "item ids: i1 i2 …, or a question's number: Q12")
            .description(
                status === "confirmed"
                    ? "Confirm items: transcripts apply confirmed items"
                    : "Reject items: they are never suggested again"
            )
            .option("--min-confidence <0..1>", "every suggested item at or above this confidence");

        // Only a confirm takes a value: a reject keeps nothing of the item.
        if (status === "confirmed") {
            command
                .option("--speaker <name>", "whose voice a speaker range is")
                .option("--proposed <text>", "the right spelling of a term, when the proposal is wrong");
        }

        command
            .option("--json", "print { decided, token, skipped } as JSON (the token is what reopen --token takes)")
            .action(
                (
                    ref: string,
                    ids: string[],
                    opts: { speaker?: string; proposed?: string; minConfidence?: string; json?: boolean }
                ) => decide(status, ref, ids, opts)
            );
    }

    program
        .command("reopen")
        .argument("<meeting>", MEETING_REF)
        .argument("<items...>", "item ids: i1 i2 …")
        .description("Put confirmed or rejected items back to suggested: the Undo of confirm and reject")
        .option(
            "--token <token>",
            "the decision to undo (confirm/reject --json prints it): refused with [item-changed] when another decision changed an item since"
        )
        .option("--json", "print { reopened, skipped } as JSON")
        .action(reopen);

    const speakers = program.command("speakers").description("The meeting's speakers: statistics, hints and renames");

    speakers
        .command("stats")
        .argument("<meeting>", MEETING_REF)
        .description("Per label: origin, turns, spoken time and spans, with hints")
        .option("--gap <duration>", "a pause shorter than this keeps two turns in one span", "2m")
        .option(
            "--attendance <platform|file>",
            "who was in the call and when: a platform (teams) or its export file (teams:<file>)"
        )
        .option("--json", "print JSON")
        .action(speakersStats);

    speakers
        .command("rename")
        .argument("<meeting>", MEETING_REF)
        .argument("<label>", "the source's label, as the transcript shows it")
        .argument("<name>", "the right name")
        .description("Rename a label for this meeting")
        .action(speakersRename);

    program
        .command("transcript")
        .argument("<meeting>", MEETING_REF)
        .description("The transcript with renames, confirmed items and the dictionary applied")
        .option("--format [format]", `${TRANSCRIPT_FORMATS.join(" | ")} (default md)`)
        .option("--json", "the same as --format json")
        .option("--with-suggested", "also apply the suggested items")
        .option("--no-dictionary", "do not apply the dictionary")
        .option("--no-frontmatter", "md: omit the frontmatter")
        .option("--timestamps", "show the start time of each paragraph")
        .option(
            "--play-links",
            "md: link each start time to its moment (router preset meetings-play); implies --timestamps"
        )
        .action(transcript);
}
