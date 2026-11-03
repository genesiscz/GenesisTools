import { readFileSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { renderFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { logger, out } from "@genesiscz/utils/logger";
import { languageSettings, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { appendCorrections, type Correction } from "@genesiscz/utils/meetings/corrections";
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
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import {
    entriesToSrt,
    entriesToVtt,
    formatClock,
    groupTurns,
    localTime,
    TRANSCRIPT_FORMATS,
    transcriptMarkdown,
    transcriptTextLines,
} from "@genesiscz/utils/transcribe/render";
import { DEFAULT_SPAN_GAP_SEC, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import type { Command } from "commander";
import pc from "picocolors";
import { z } from "zod";
import { FINDING_KINDS, findingItems, findingProblems, findingSchema, findingsFileSchema } from "../lib/findings";
import { playLinksFor } from "../lib/link";
import { OpenedMeeting } from "../lib/opened-meeting";
import { MEETING_PLATFORMS } from "../lib/platforms";
import { questionIdOf, questionLabel, questionWarnings } from "../lib/questions";
import { errorText, fail, resolveEnum, TOOL } from "../lib/shared";
import { printSpeakerStats } from "../lib/speakers-view";
import { isSuggestRule, SUGGEST_RULES, suggestItems } from "../lib/suggest";
import { checkAnchors, correctTranscript, ledgerEntryFor, outcomeText } from "../lib/transcript-corrections";
import { DEFAULT_WORD_CHECK, WORD_CHECKS, type WordCheckChoice } from "../lib/word-check";

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

function itemWhat(item: MeetingItem): string {
    if (item.kind === "speaker-range") {
        const who = item.speaker ?? `? (${item.candidates?.join(", ") || "unknown"})`;
        return `${item.label} ${formatClock(item.fromSec)}–${formatClock(item.toSec)} → ${who}`;
    }

    if (item.kind === "join") {
        return `${formatClock(item.atSec)} "${item.joined ?? ""}"${item.speaker ? ` → ${item.speaker}` : ""}`;
    }

    if (item.kind === "question") {
        const range = `${formatClock(item.fromSec)}–${formatClock(item.toSec)}`;
        const said = item.answer ? `→ ${item.answer}` : item.choices.length > 0 ? `(${item.choices.join(" / ")})` : "";
        return `${range} ${item.question} ${said}`.trim();
    }

    if (item.kind === "label") {
        return `${item.label} ${formatClock(item.fromSec)}–${formatClock(item.toSec)} tracks no one person`;
    }

    const occurrences = typeof item.evidence?.occurrences === "number" ? ` ×${item.evidence.occurrences}` : "";
    return `${item.heard} → ${item.proposed ?? "?"}${occurrences}`;
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

/** The word check for the term rules, or undefined when it is off or cannot run (said once, with the reason). */
async function termWordCheck(
    choice: WordCheckChoice | undefined,
    meeting: OpenedMeeting
): Promise<WordCheck | undefined> {
    const opened = await meeting.wordCheck(choice);

    if (!opened.check && choice !== "off") {
        ui.warn(`The word check is off (${opened.reason}); the term rules skip every word with a Czech letter.`);
    }

    return opened.check;
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
        // The platform, attendance and channel layout first, when the record lacks any of them.
        const opened = OpenedMeeting.of(store, record);
        const collected = await opened.collectWhenIncomplete();
        const meeting = await opened.meeting();
        const config = await opened.config();
        const evidence = rules.includes("evidence") ? await opened.evidence() : null;
        const wordCheck = rules.includes("terms") ? await termWordCheck(wordCheckChoice, opened) : undefined;
        const fresh = suggestItems({
            record: collected,
            meeting,
            rules,
            dictionary: await opened.dictionary(),
            sourceWords: await opened.sourceWords(),
            presence: await opened.presence(opts.attendance),
            evidence,
            energyMicShare: (await opened.energy()).share,
            listenBelow: config.global.suggest.listenBelow,
            questionBudget: config.global.suggest.questionCap,
            minPriority: config.global.playback.listen.minPriority,
            points: await opened.summaryPoints(),
            wordCheck,
            sourceLabels: languageSettings(config).render,
            now: new Date().toISOString(),
        });
        wordCheck?.dispose();

        if (fresh.length > 0) {
            await store.update(
                record.id,
                { command: "suggest", change: `${fresh.length} items (${fresh[0]!.id} to ${fresh.at(-1)!.id})` },
                (current) => {
                    current.items.push(...fresh);
                }
            );
        }

        if (opts.json) {
            out.result(SafeJSON.stringify(fresh, null, 2));
            return;
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

    const listed = record.items.filter(
        (item) => (!status || item.status === status) && (!opts.kind || item.kind === opts.kind)
    );

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
                added = findingItems(parsed.data, current.items, new Date().toISOString());

                if (meeting) {
                    const anchors = checkAnchors(added, meeting.transcript);
                    anchorWarnings = anchors.warnings;

                    for (const item of added) {
                        const line = anchors.addresses.get(item.id);

                        if (line !== undefined) {
                            item.evidence = { ...item.evidence, transcriptLine: line };
                        }
                    }
                }

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

/** Picks the items a decision names: ids, or every suggested item at or above a confidence. */
function pickItems(record: MeetingRecord, ids: string[], minConfidence?: number): MeetingItem[] | string {
    if (minConfidence !== undefined) {
        return record.items.filter((item) => item.status === "suggested" && (item.confidence ?? 0) >= minConfidence);
    }

    const missing = ids.filter((id) => !record.items.some((item) => item.id === id));

    if (missing.length > 0) {
        return `${record.id} has no item ${missing.join(", ")} (${TOOL} items ${record.id})`;
    }

    return record.items.filter((item) => ids.includes(item.id));
}

async function decide(
    status: "confirmed" | "rejected",
    ref: string,
    ids: string[],
    opts: { speaker?: string; proposed?: string; minConfidence?: string }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const minConfidence = opts.minConfidence === undefined ? undefined : Number(opts.minConfidence);

    if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) {
        fail(`--min-confidence ${opts.minConfidence} must be between 0 and 1 (0.8 = 80 %).`);
        return;
    }

    if (ids.length === 0 && minConfidence === undefined) {
        fail(`Name the items (i1 i2 …) or give --min-confidence <0..1>.`);
        return;
    }

    // A question is named by its number as people see it (Q12) as well as by its id.
    const picked = pickItems(
        record,
        ids.map((id) => (/^q\d+$/i.test(id) ? questionIdOf(record, id) : id)),
        minConfidence
    );

    if (typeof picked === "string") {
        fail(picked);
        return;
    }

    // A range nobody named, or a term with no spelling, cannot be applied: confirming needs --speaker or --proposed.
    const unnamed =
        status === "confirmed"
            ? picked.filter(
                  (item) =>
                      (item.kind === "speaker-range" && !item.speaker && !opts.speaker) ||
                      (item.kind === "term" && !item.proposed && !item.meaning && !item.quote && !opts.proposed)
              )
            : [];
    // A question is answered by ear, which also decides the items it names.
    const questions: MeetingItem[] = status === "confirmed" ? picked.filter((item) => item.kind === "question") : [];

    for (const item of questions) {
        const label = questionLabel(record, item.id);
        ui.warn(`${label} (${item.id}) is a question; answer it: ${TOOL} listen ${record.id} --item ${label}`);
    }

    const deciding = picked.filter((item) => !unnamed.includes(item) && !questions.includes(item));

    for (const item of unnamed) {
        const candidates =
            item.kind === "speaker-range" && item.candidates?.length
                ? ` Candidates: ${item.candidates.join(", ")}.`
                : "";
        ui.warn(
            item.kind === "term"
                ? `${item.id} ("${item.heard}") has no spelling yet; confirm it with --proposed <text>.`
                : `${item.id} has no speaker yet; confirm it with --speaker <name>.${candidates}`
        );
    }

    if (deciding.length === 0) {
        process.exitCode = unnamed.length + questions.length > 0 ? 1 : 0;
        return;
    }

    const now = new Date().toISOString();
    const ledger: Correction[] = [];

    try {
        await store.update(
            record.id,
            {
                command: status === "confirmed" ? "confirm" : "reject",
                change: deciding.map((item) => item.id).join(" "),
            },
            (current) => {
                for (const item of current.items) {
                    if (!deciding.some((picked) => picked.id === item.id)) {
                        continue;
                    }

                    item.status = status;
                    item.decidedAt = now;

                    if (status !== "confirmed") {
                        continue;
                    }

                    if (item.kind === "speaker-range" && opts.speaker) {
                        item.speaker = opts.speaker;
                    }

                    if (item.kind === "term" && opts.proposed) {
                        item.proposed = opts.proposed;
                    }

                    const entry = ledgerEntryFor(current, item, now);

                    if (entry) {
                        ledger.push(entry);
                    }
                }
            }
        );
        appendCorrections(ledger);
        ui.ok(`${status} ${deciding.map((item) => item.id).join(" ")} in ${record.id}`);
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
        const opened = OpenedMeeting.of(store, record);
        const meeting = await opened.meeting();
        const stats = speakerStats(meeting.transcript, {
            gapSec,
            participants: meeting.speakers,
            presence: await opened.presence(opts.attendance),
        });

        if (opts.json) {
            out.result(SafeJSON.stringify({ meeting: record.id, gapSec, ...stats }, null, 2));
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
        await store.update(record.id, { command: "speakers rename", change: `${label} → ${name}` }, (current) => {
            current.speakers.labels[label] = name;
        });
        ui.ok(`${record.id}: ${label} → ${name} (transcripts of this meeting use it now)`);
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
        withSuggested?: boolean;
        dictionary?: boolean;
        timestamps?: boolean;
        playLinks?: boolean;
        frontmatter?: boolean;
    }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);
    const format = await resolveEnum({
        value: opts.format,
        fallback: "md",
        values: TRANSCRIPT_FORMATS,
        flag: "--format",
        subcommand: ["transcript"],
    });

    if (!record || !format) {
        return;
    }

    try {
        const meeting = await loadTranscript(store, record);
        const config = await new MeetingsConfigStore().read();
        const applied = correctTranscript({ ...opts, record, transcript: meeting.transcript, config, format });
        reportOutcomes(applied.outcomes);
        ui.dim(
            `applied: ${applied.labels} renamed lines, ${applied.ranges} re-attributed, ${applied.joins} joins, ${applied.terms} term fixes, ${applied.fixes} dictionary fixes, ${applied.spoken} spoken forms, ${applied.fuzzy} fuzzy, ${applied.expansions} expansions, ${applied.meanings} meanings, ${applied.marks} quotes and meanings of spoken words, ${applied.unclear} unclear marks`
        );

        if (format === "json") {
            out.result(SafeJSON.stringify({ meeting: record.id, entries: applied.entries }, null, 2));
            return;
        }

        if (format === "srt" || format === "vtt") {
            out.print(format === "srt" ? entriesToSrt(applied.entries) : entriesToVtt(applied.entries));
            return;
        }

        const turns = groupTurns(applied.entries);

        if (format === "txt") {
            out.print(
                `${[record.title, localTime(record.start), "", ...transcriptTextLines(turns, opts.timestamps === true)].join("\n").trimEnd()}\n`
            );
            return;
        }

        const parts: string[] = [];

        if (opts.frontmatter !== false) {
            parts.push(
                renderFrontmatter({
                    title: record.title,
                    meeting: localTime(record.start),
                    ...(record.project ? { project: record.project } : {}),
                    meeting_id: record.id,
                    sources: Object.keys(record.sources),
                    // The people after the corrections, with their line counts; an open speaker mark is not a speaker.
                    speakers: Object.fromEntries(applied.speakers.map((speaker) => [speaker.name, speaker.lines])),
                    ...(applied.unattributed.length > 0
                        ? {
                              unattributed: Object.fromEntries(
                                  applied.unattributed.map((speaker) => [speaker.name, speaker.lines])
                              ),
                          }
                        : {}),
                })
            );
        }

        // The links are written even while the router preset is off; the warning says how to make them open.
        const links = opts.playLinks ? playLinksFor(record.id) : undefined;
        const playLink = links?.link;

        if (links?.warning) {
            ui.warn(links.warning);
        }

        parts.push(
            `# ${record.title || "Untitled meeting"}`,
            transcriptMarkdown(turns, opts.timestamps === true || opts.playLinks === true, { playLink })
        );
        out.print(`${parts.join("\n\n")}\n`);
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
        .option("--priority <0..1>", "question: how much its answer matters; listen asks the highest first")
        .option(
            "--reason <text>",
            "why: the facts and context it rests on (required for speaker-range, label, join and term)"
        )
        .action(addItems);

    for (const [name, status] of [
        ["confirm", "confirmed"],
        ["reject", "rejected"],
    ] as const) {
        program
            .command(name)
            .argument("<meeting>", MEETING_REF)
            .argument("[items...]", "item ids: i1 i2 …, or a question's number: Q12")
            .description(
                status === "confirmed"
                    ? "Confirm items: transcripts apply confirmed items"
                    : "Reject items: they are never suggested again"
            )
            .option("--min-confidence <0..1>", "every suggested item at or above this confidence")
            .option("--speaker <name>", "confirm: whose voice a speaker range is")
            .option("--proposed <text>", "confirm: the right spelling of a term, when the proposal is wrong")
            .action(
                (ref: string, ids: string[], opts: { speaker?: string; proposed?: string; minConfidence?: string }) =>
                    decide(status, ref, ids, opts)
            );
    }

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
