import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { renderFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { logger, out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { appendCorrections, type Correction } from "@genesiscz/utils/meetings/corrections";
import {
    ITEM_STATUSES,
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
    meetingItemSchema,
    nextId,
    QUESTION_TOPICS,
} from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { applyCorrections, type TranscriptCorrections, type UnclearPassage } from "@genesiscz/utils/transcribe/apply";
import { DEFAULT_SPELL_PROVIDER, SPELL_PROVIDER_IDS } from "@genesiscz/utils/transcribe/languages/spell";
import { openWordCheck, type WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import {
    entriesToSrt,
    entriesToVtt,
    formatClock,
    groupTurns,
    localTime,
    parseClock,
    TRANSCRIPT_FORMATS,
    type TranscriptFormat,
    transcriptMarkdown,
    transcriptTextLines,
} from "@genesiscz/utils/transcribe/render";
import { DEFAULT_SPAN_GAP_SEC, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { summaryPoints } from "@genesiscz/utils/transcribe/summary";
import { transcriptWords } from "@genesiscz/utils/transcribe/terms";
import type { Command } from "commander";
import pc from "picocolors";
import { collectAndReport } from "../lib/collect";
import { energyMicShareFor } from "../lib/energy";
import { speakingEvidence } from "../lib/platforms";
import { presenceFor } from "../lib/presence";
import { openQuestions } from "../lib/questions";
import { errorText, fail, resolveEnum, TOOL } from "../lib/shared";
import { linkedSource } from "../lib/sources";
import { printSpeakerStats } from "../lib/speakers-view";
import { isSuggestRule, SUGGEST_RULES, suggestItems } from "../lib/suggest";

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

async function loadTranscript(record: MeetingRecord): Promise<SourceMeeting> {
    const { source, sourceMeetingId } = await linkedSource(record);
    log.debug({ meeting: record.id, source: source.id, sourceMeetingId }, "loading transcript");
    return source.load(sourceMeetingId);
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

    const occurrences = typeof item.evidence?.occurrences === "number" ? ` ×${item.evidence.occurrences}` : "";
    return `${item.heard} → ${item.proposed ?? "?"}${occurrences}`;
}

const STATUS_COLOR: Record<MeetingItem["status"], (text: string) => string> = {
    suggested: pc.yellow,
    confirmed: pc.green,
    rejected: pc.dim,
};

function printItems(items: MeetingItem[]): void {
    const table = createBoxTable(["ID", "KIND", "STATUS", "CONF", "WHAT", "RULES"]);

    for (const item of items) {
        table.push([
            pc.white(item.id),
            item.kind,
            STATUS_COLOR[item.status](item.status),
            item.confidence === undefined ? "—" : `${Math.round(item.confidence * 100)} %`,
            truncateDisplay(itemWhat(item), 90),
            item.rules.join(", "),
        ]);
    }

    out.println(table.toString());
}

const WORD_CHECKS = [...SPELL_PROVIDER_IDS, "off"] as const;

/** The word check for the term rules, or undefined when it is off or cannot run (said once, with the reason). */
async function wordCheckFor(
    choice: (typeof WORD_CHECKS)[number],
    meeting: SourceMeeting
): Promise<WordCheck | undefined> {
    if (choice === "off") {
        return undefined;
    }

    const opened = await openWordCheck({ provider: choice, words: transcriptWords(meeting.transcript) });

    if (!opened.available) {
        ui.warn(`The word check is off (${opened.reason}); the term rules skip every word with a Czech letter.`);
        return undefined;
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

    const wordCheckChoice = await resolveEnum({
        value: opts.wordCheck,
        fallback: DEFAULT_SPELL_PROVIDER,
        values: WORD_CHECKS,
        flag: "--word-check",
        subcommand: ["suggest"],
    });

    if (!wordCheckChoice) {
        return;
    }

    try {
        // The platform, attendance and channel layout first, when the record lacks any of them.
        const collected =
            record.platform && record.attendance && record.evidence?.channels
                ? record
                : await collectAndReport(store, record);
        const { source, sourceMeetingId } = await linkedSource(collected);
        const meeting = await source.load(sourceMeetingId);
        const config = await new MeetingsConfigStore().read();
        const evidence = rules.includes("evidence")
            ? speakingEvidence(collected, await source.evidence(sourceMeetingId))
            : null;
        const wordCheck = rules.includes("terms") ? await wordCheckFor(wordCheckChoice, meeting) : undefined;
        const fresh = suggestItems({
            record: collected,
            meeting,
            rules,
            dictionary: resolveDictionary(config, { project: record.project, meeting: record.dictionary }),
            sourceWords: await source.dictionary(),
            presence: await presenceFor(collected, meeting, opts.attendance),
            evidence,
            energyMicShare: (await energyMicShareFor(store, collected, evidence)).share,
            listenBelow: config.global.suggest.listenBelow,
            points: meeting.summary ? summaryPoints(meeting.summary, config.global.summary) : [],
            wordCheck,
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

        printItems(fresh);
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

    printItems(listed);
}

/** `items add --listen`: a question of the polisher's own, answered later by ear with `listen`. */
async function addQuestion(
    ref: string,
    opts: {
        listen?: boolean;
        from: string;
        to: string;
        about?: string;
        question: string;
        heard?: string;
        choices?: string;
        decides?: string;
    }
): Promise<void> {
    if (!opts.listen) {
        fail(`Only questions can be added by hand: pass --listen. The other kinds come from ${TOOL} suggest.`);
        return;
    }

    const fromSec = parseClock(opts.from);
    const toSec = parseClock(opts.to);

    if (fromSec === undefined || toSec === undefined || toSec < fromSec) {
        fail(`--from and --to need transcript times (37:43, 1:02:10 or seconds), --from first.`);
        return;
    }

    const about = await resolveEnum({
        value: opts.about,
        fallback: "speaker",
        values: QUESTION_TOPICS,
        flag: "--about",
        subcommand: ["items", "add"],
    });

    if (!about) {
        return;
    }

    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const list = (value?: string) =>
        (value ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    const decides = list(opts.decides);
    const unknown = decides.filter((id) => !record.items.some((item) => item.id === id));

    if (unknown.length > 0) {
        fail(`${record.id} has no item ${unknown.join(", ")} (${TOOL} items ${record.id})`);
        return;
    }

    try {
        let id = "";
        await store.update(record.id, { command: "items add", change: opts.question }, (current) => {
            id = nextId("i", current.items);
            current.items.push(
                meetingItemSchema.parse({
                    id,
                    kind: "question",
                    status: "suggested",
                    about,
                    fromSec,
                    toSec,
                    question: opts.question,
                    ...(opts.heard ? { heard: opts.heard } : {}),
                    choices: list(opts.choices),
                    decides,
                    rules: [MeetingRule.User],
                    suggestedAt: new Date().toISOString(),
                })
            );
        });
        ui.ok(`${id} added to ${record.id}. Answer it: ${TOOL} listen ${record.id} --item ${id}`);
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

    const picked = pickItems(record, ids, minConfidence);

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
                      (item.kind === "term" && !item.proposed && !opts.proposed)
              )
            : [];
    // A question is answered by ear, which also decides the items it names.
    const questions: MeetingItem[] = status === "confirmed" ? picked.filter((item) => item.kind === "question") : [];

    for (const item of questions) {
        ui.warn(`${item.id} is a question; answer it: ${TOOL} listen ${record.id} --item ${item.id}`);
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

                    if (item.kind === "term") {
                        const fixed = opts.proposed ?? item.proposed;

                        if (!fixed) {
                            continue;
                        }

                        item.proposed = fixed;
                        ledger.push({
                            at: now,
                            meeting: current.id,
                            project: current.project,
                            kind: "term",
                            heard: item.heard,
                            fixed,
                            item: item.id,
                        });
                    }

                    if (item.kind === "join" && item.joined) {
                        const evidence = item.evidence ?? {};
                        const heard = [evidence.left, evidence.right]
                            .filter((part) => typeof part === "string")
                            .join(" ");
                        ledger.push({
                            at: now,
                            meeting: current.id,
                            project: current.project,
                            kind: "join",
                            heard,
                            fixed: item.joined,
                            item: item.id,
                        });
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
    const record = requireMeeting(new MeetingStore(), ref);

    if (!record) {
        return;
    }

    const gapSec = opts.gap === undefined ? DEFAULT_SPAN_GAP_SEC : parseDuration(opts.gap) / 1000;

    if (!(gapSec > 0)) {
        fail(`--gap ${opts.gap} is not a duration (try 90s or 2m).`);
        return;
    }

    try {
        const meeting = await loadTranscript(record);
        const stats = speakerStats(meeting.transcript, {
            gapSec,
            participants: meeting.speakers,
            presence: await presenceFor(record, meeting, opts.attendance),
        });

        if (opts.json) {
            out.result(SafeJSON.stringify({ meeting: record.id, gapSec, ...stats }, null, 2));
            return;
        }

        printSpeakerStats(stats);
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

/**
 * The open questions as passages a transcript marks: a speaker question marks the label of the ranges it decides, a
 * question with `heard` marks those words.
 */
function unclearPassages(record: MeetingRecord, listenBelow: number): UnclearPassage[] {
    const open = openQuestions(record);
    const asked = new Set(open.flatMap((question) => question.decides));
    // A low term not worth a question is still marked wherever it was heard.
    const unaskedTerms = record.items.flatMap((item): UnclearPassage[] =>
        item.kind === "term" &&
        item.status === "suggested" &&
        !asked.has(item.id) &&
        (item.confidence ?? 1) < listenBelow
            ? [
                  {
                      fromSec: 0,
                      toSec: Number.POSITIVE_INFINITY,
                      heard: item.heard,
                      readings: item.proposed ? withConfidence([item.proposed], item.confidence) : [],
                  },
              ]
            : []
    );

    return [
        ...unaskedTerms,
        ...open.flatMap((question): UnclearPassage[] => {
            if (question.heard) {
                const { fromSec, toSec, heard, choices } = question;
                return [{ fromSec, toSec, heard, readings: withConfidence(choices, question.confidence) }];
            }

            if (question.about !== "speaker") {
                return [];
            }

            return record.items.flatMap((item) =>
                item.kind === "speaker-range" && item.status === "suggested" && question.decides.includes(item.id)
                    ? [
                          {
                              fromSec: item.fromSec,
                              toSec: item.toSec,
                              speaker: item.label,
                              readings: withConfidence(question.choices, item.confidence),
                          },
                      ]
                    : []
            );
        }),
    ];
}

/** The first reading is the rules' guess: it carries their confidence. The others have none of their own. */
function withConfidence(readings: string[], confidence: number | undefined): string[] {
    return readings.map((reading, index) =>
        index === 0 && confidence !== undefined ? `${reading} ${Math.round(confidence * 100)} %` : reading
    );
}

/** What a transcript applies: renames, then the confirmed items (and the suggested ones on request), then the dictionary. */
function correctionsOf(
    record: MeetingRecord,
    config: Awaited<ReturnType<MeetingsConfigStore["read"]>>,
    opts: { withSuggested?: boolean; dictionary?: boolean; format: TranscriptFormat }
): TranscriptCorrections {
    const used = record.items.filter(
        (item) => item.status === "confirmed" || (opts.withSuggested && item.status === "suggested")
    );
    // With --with-suggested the top reading is applied, so nothing stays open.
    const passages = opts.withSuggested ? [] : unclearPassages(record, config.global.suggest.listenBelow);

    return {
        labels: record.speakers.labels,
        ranges: used.flatMap((item) =>
            item.kind === "speaker-range" && item.speaker
                ? [{ label: item.label, fromSec: item.fromSec, toSec: item.toSec, speaker: item.speaker }]
                : []
        ),
        joins: used.flatMap((item) =>
            item.kind === "join" ? [{ atSec: item.atSec, ...(item.speaker ? { speaker: item.speaker } : {}) }] : []
        ),
        terms: used.flatMap((item) =>
            item.kind === "term" && item.proposed ? [{ heard: item.heard, replacement: item.proposed }] : []
        ),
        ...(opts.dictionary === false
            ? {}
            : { dictionary: resolveDictionary(config, { project: record.project, meeting: record.dictionary }) }),
        notes: opts.format === "md" ? "sup" : "inline",
        ...(passages.length > 0 ? { unclear: { label: config.global.render.unclearLabel, passages } } : {}),
    };
}

async function transcript(
    ref: string,
    opts: {
        format?: string | boolean;
        withSuggested?: boolean;
        dictionary?: boolean;
        timestamps?: boolean;
        frontmatter?: boolean;
    }
): Promise<void> {
    const record = requireMeeting(new MeetingStore(), ref);
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
        const meeting = await loadTranscript(record);
        const config = await new MeetingsConfigStore().read();
        const applied = applyCorrections(meeting.transcript, correctionsOf(record, config, { ...opts, format }));
        ui.dim(
            `applied: ${applied.labels} renamed lines, ${applied.ranges} re-attributed, ${applied.joins} joins, ${applied.terms} term fixes, ${applied.fixes} dictionary fixes, ${applied.spoken} spoken forms, ${applied.fuzzy} fuzzy, ${applied.expansions} expansions, ${applied.meanings} meanings, ${applied.unclear} unclear marks`
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
                    // An open speaker mark is not a speaker.
                    speakers: [
                        ...new Set(
                            applied.entries
                                .map((entry) => entry.speaker)
                                .filter((name) => !name.startsWith(`[${config.global.render.unclearLabel}:`))
                        ),
                    ],
                })
            );
        }

        parts.push(`# ${record.title || "Untitled meeting"}`, transcriptMarkdown(turns, opts.timestamps === true));
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
        .option("--attendance <teams|file>", "who was in the call and when (Teams), for rule RA")
        .option(
            "--word-check <provider>",
            `${WORD_CHECKS.join(" | ")}: tells ordinary Czech words from unknown ones for the term rules; the dictionaries download on first use (default ${DEFAULT_SPELL_PROVIDER})`
        )
        .option("--json", "print the new items")
        .action(suggest);

    program
        .command("items")
        .argument("<meeting>", MEETING_REF)
        .description("The meeting's items with their status, confidence and rules")
        .option("--status [status]", ITEM_STATUSES.join(" | "))
        .option("--kind <kind>", "speaker-range | join | term | question")
        .option("--json", "print JSON")
        .action(items)
        .command("add")
        .argument("<meeting>", MEETING_REF)
        .description(`Add a question to answer by ear (${toolCommand("meetings", "listen")})`)
        .option("--listen", "the item is a question answered by listening (the only kind added by hand)")
        .requiredOption("--from <time>", "start of the range: 37:43, 1:02:10 or seconds")
        .requiredOption("--to <time>", "end of the range")
        .option("--about [topic]", `${QUESTION_TOPICS.join(" | ")} (default speaker)`)
        .requiredOption("--question <text>", "what to decide, as the listener reads it")
        .option(
            "--heard <words>",
            "about a term or text: the words in question, marked in the transcript until answered"
        )
        .option("--choices <list>", "comma-separated answers to offer")
        .option("--decides <ids>", "comma-separated items the answer confirms or rejects")
        .action(addQuestion);

    for (const [name, status] of [
        ["confirm", "confirmed"],
        ["reject", "rejected"],
    ] as const) {
        program
            .command(name)
            .argument("<meeting>", MEETING_REF)
            .argument("[items...]", "item ids: i1 i2 …")
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
        .option("--attendance <teams|file>", "who was in the call and when (Teams)")
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
        .action(transcript);
}
