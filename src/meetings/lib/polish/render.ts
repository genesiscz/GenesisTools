import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { json2md } from "@genesiscz/utils/json2md";
import {
    type MeetingsPolishedConfig,
    POLISHED_SECTIONS,
    type PolishedLanguagePhrases,
    type PolishedPart,
    type PolishedPhrases,
    type PolishedSection,
    type PolishedUnresolved,
} from "@genesiscz/utils/meetings/polished";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import { DEFAULT_LISTEN_BELOW } from "../questions";
import type { QuestionRow, SpeakerRow, TermRow } from "./rows";
import { fillPhrase, type PartTimes, percentText, playTime, renderTimes, tokenizeBareTimes } from "./tokens";

/** One part with what the build read from its record. */
export interface LoadedPart {
    config: PolishedPart;
    /** 1-based, in the order of `parts`. */
    number: number;
    record: MeetingRecord;
    /** The corrected transcript (`tools meetings transcript --format md --play-links`) without front matter and title. */
    transcriptMd: string;
    speakers: SpeakerRow[];
    terms: TermRow[];
    questions: QuestionRow[];
    /** The transcript source's own name ("Wispr Flow"). */
    sourceLabel: string;
    /** Local `YYYY-MM-DD HH:MM`. */
    start: string;
    end: string;
}

export interface RenderInput {
    config: MeetingsPolishedConfig;
    parts: LoadedPart[];
    /** Part token to its times. */
    times: ReadonlyMap<string, PartTimes>;
    /** The meeting language's phrases (`languages.<code>.render.polished`); the file's own `phrases` win. */
    phrases: PolishedLanguagePhrases;
    /** The zone the local times are in, written after the start and end in the front matter. */
    timeZone: string;
}

export interface RenderedPolished {
    markdown: string;
    warnings: string[];
}

/** The heading of each generated section, as the file shows it. */
export const POLISHED_SECTION_TITLES: Readonly<Record<PolishedSection, string>> = {
    participants: "Participants",
    glossary: "Glossary",
    references: "References",
    summary: "Summary",
    transcript: "Transcript",
    diffs: "Diffs",
    unresolved: "Unresolved",
    questions: "Open questions for the user",
};

const SETTLED_OCR_CHARS = 120;
const HINT_OCR_CHARS = 100;
const DIFF_TEXT_CHARS = 90;

function shortText(text: string): string {
    return text.length > DIFF_TEXT_CHARS ? `${text.slice(0, DIFF_TEXT_CHARS - 2)}…` : text;
}

function table(header: string[], align: string[], rows: string[][]): string {
    return [`| ${header.join(" | ")} |`, `|${align.join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join(
        "\n"
    );
}

function details(summary: string, body: string): string {
    return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function clockOf(local: string): string {
    return local.slice(11, 16);
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Builds the polished markdown, front matter included, from the authored config and what the records hold now. */
export function renderPolished(input: RenderInput): RenderedPolished {
    const { config, parts, times } = input;
    const warnings: string[] = [];
    const unknownTokens = new Set<string>();
    const phrases: PolishedPhrases = {
        ...input.phrases,
        sourceLabel: parts[0]!.sourceLabel,
        ...config.phrases,
    };
    const text = (markdown: string) => renderTimes(markdown, times, unknownTokens);
    const partOf = (record: string) => parts.find((part) => part.record.id === record);
    const timeOf = (record: string, at: string) => {
        const part = partOf(record);
        const atSec = parseClock(at);
        return playTime(at, part && atSec !== undefined ? (times.get(part.config.token)?.link(atSec) ?? null) : null);
    };
    const markerOf = (record: string) => partOf(record)?.config.marker;
    const sections = new Map<PolishedSection, string>();
    const override = (id: PolishedSection, body: () => string | undefined) => {
        const replaced = config.overrides?.sections?.[id];

        if (replaced === null) {
            return;
        }

        const value = replaced === undefined ? body() : text(replaced);

        if (value !== undefined) {
            sections.set(id, value);
        }
    };

    override("participants", () => participantsSection({ config, parts, text }));
    override("glossary", () => (config.glossary ? text(config.glossary.md.trim()) : undefined));
    override("references", () => {
        const references = config.references;

        if (!references) {
            return undefined;
        }

        const markers = new Map(
            parts.flatMap((part) => (part.config.marker ? [[part.config.marker, part.config.token] as const] : []))
        );
        const md = references.linkBareTimes
            ? tokenizeBareTimes(references.md.trim(), references.linkBareTimes, markers)
            : references.md.trim();
        return text(md);
    });
    override("summary", () => {
        const blocks = [
            ...(config.summary ? [text(config.summary.md.trim())] : []),
            ...(config.summaryDiff
                ? [
                      details(
                          `Summary diff: ${parts[0]!.sourceLabel}'s summary against this one`,
                          text(config.summaryDiff.md.trim())
                      ),
                  ]
                : []),
        ];
        return blocks.length > 0 ? blocks.join("\n\n") : undefined;
    });
    override("transcript", () =>
        parts
            .map((part) =>
                details(
                    `Part ${part.number}: ${clockOf(part.start)} to ${clockOf(part.end)} (record ${part.record.id})`,
                    markTranscript(part, config, warnings)
                )
            )
            .join("\n\n")
    );
    override("diffs", () => diffsSection(parts, phrases));
    override("unresolved", () =>
        config.unresolved?.length
            ? config.unresolved
                  .map((entry) => unresolvedEntry({ entry, phrases, text, timeOf, marker: markerOf(entry.record) }))
                  .join("\n\n")
            : undefined
    );
    override("questions", () => questionsSection({ config, parts, times, text }));

    const body: string[] = [`# ${config.heading ?? `${config.title} (polished)`}`];

    if (config.intro?.trim()) {
        body.push(text(config.intro.trim()));
    }

    for (const group of groupUpdates(config.updates ?? [])) {
        body.push(`Update ${group.at}:`, group.texts.map((line) => `- ${text(line)}`).join("\n"));
    }

    if (config.introTail?.trim()) {
        body.push(text(config.introTail.trim()));
    }

    for (const id of POLISHED_SECTIONS) {
        const section = sections.get(id);

        if (section !== undefined) {
            body.push(`## ${POLISHED_SECTION_TITLES[id]}`, section);
        }

        for (const extra of config.sections ?? []) {
            if (extra.after === id) {
                body.push(
                    `## ${extra.heading}`,
                    ...(extra.intro ? [text(extra.intro.trim())] : []),
                    text(extra.md.trim())
                );
            }
        }
    }

    if (unknownTokens.size > 0) {
        warnings.push(`Time tokens that name no part stay as written: ${[...unknownTokens].join(", ")}`);
    }

    const markdown = json2md([{ raw: body.join("\n\n") }], { frontmatter: frontmatterOf(input, parts) });
    return { markdown, warnings };
}

function frontmatterOf(input: RenderInput, parts: LoadedPart[]): Record<string, unknown> {
    const { config } = input;
    const sourceIds = [
        ...new Set(
            parts.flatMap((part) => [...Object.keys(part.record.sources), ...Object.keys(part.config.sources ?? {})])
        ),
    ];
    const meetingIds = (sourceId: string) =>
        parts.flatMap((part) => {
            const fromRecord = part.record.sources[sourceId]?.meetingId;
            const id =
                part.config.sources?.[sourceId]?.meetingId ?? (typeof fromRecord === "string" ? fromRecord : undefined);
            return id ? [id] : [];
        });
    const shareLinks = parts.flatMap((part) =>
        Object.values(part.config.sources ?? {}).flatMap((source) => (source.shareLink ? [source.shareLink] : []))
    );
    const rawExports = parts.flatMap((part) => (part.config.rawExport ? [part.config.rawExport] : []));
    const waiting = parts.flatMap((part) =>
        part.questions.length > 0 ? [`${plural(part.questions.length, "listen question")} (${part.record.id})`] : []
    );
    const generated: Record<string, unknown> = {
        title: config.title,
        ...(sourceIds.length > 0 ? { source: sourceIds.join(", ") } : {}),
        ...Object.fromEntries(
            sourceIds.flatMap((sourceId) => {
                const ids = meetingIds(sourceId);
                return ids.length > 0 ? [[`${sourceId}_ids`, ids]] : [];
            })
        ),
        meeting_records: parts.map((part) => part.record.id),
        ...(shareLinks.length > 0 ? { share_links: shareLinks } : {}),
        start: `${parts[0]!.start} (${input.timeZone})`,
        end: `${parts.at(-1)!.end} (${input.timeZone})`,
        ...(config.writtenAt ? { written: config.writtenAt } : {}),
        ...(config.updatedAt ? { updated: config.updatedAt } : {}),
        ...(config.status ? { status: config.status } : {}),
        ...(config.private !== undefined ? { private: config.private } : {}),
        ...(rawExports.length > 0 ? { raw_export: rawExports } : {}),
        ...(waiting.length > 0 ? { waiting_for: waiting } : {}),
    };
    // The authored keys come first and win: a key the build writes too keeps the author's value.
    const merged: Record<string, unknown> = { ...config.frontmatter, ...generated };

    for (const [key, value] of Object.entries(config.frontmatter ?? {})) {
        merged[key] = value;
    }

    return merged;
}

function groupUpdates(updates: Array<{ at: string; text: string }>): Array<{ at: string; texts: string[] }> {
    const groups: Array<{ at: string; texts: string[] }> = [];

    for (const update of updates) {
        const last = groups.at(-1);

        if (last?.at === update.at) {
            last.texts.push(update.text);
        } else {
            groups.push({ at: update.at, texts: [update.text] });
        }
    }

    return groups;
}

function participantsSection(input: {
    config: MeetingsPolishedConfig;
    parts: LoadedPart[];
    text: (markdown: string) => string;
}): string {
    const { config, parts, text } = input;
    const blocks: string[] = [];

    if (config.participants?.length) {
        blocks.push(
            table(
                ["Person", "Role", "Seat", "Present"],
                ["---", "---", "---", "---"],
                config.participants.map((row) => [row.person, row.role, row.seat, row.present].map(text))
            )
        );
    }

    if (config.namedNotPresent?.trim()) {
        blocks.push(`Named, not present: ${text(config.namedNotPresent.trim())}`);
    }

    const recordClock = (record: string) => {
        const part = parts.find((one) => one.record.id === record);
        return part ? clockOf(part.start) : record;
    };
    const labelRows =
        config.labelMap ??
        parts.flatMap((part) =>
            part.record.items.flatMap((item) =>
                item.kind === "label" && item.status !== "rejected"
                    ? [
                          {
                              record: part.record.id,
                              rawLabel: item.label,
                              person: "nobody (meaningless)",
                              range: `${formatClock(item.fromSec)} to ${formatClock(item.toSec)}`,
                              evidence: `label item ${item.id}`,
                          },
                      ]
                    : []
            )
        );

    if (labelRows.length > 0) {
        blocks.push(
            "### Label map",
            table(
                ["Record", "Raw label", "Real person", "Range", "Confidence"],
                ["---", "---", "---", "---", "---"],
                labelRows.map((row) =>
                    [recordClock(row.record), row.rawLabel, row.person, row.range, row.evidence].map(text)
                )
            )
        );
    }

    const applyAbove = config.transcript.applyAbove;
    const listenBelow = Math.round(DEFAULT_LISTEN_BELOW * 100);
    blocks.push("### Lines per person");

    for (const part of parts) {
        const counts = new Map<string, [number, number, number]>();

        for (const row of part.speakers) {
            const name = row.name ?? row.label;
            const tally = counts.get(name) ?? [0, 0, 0];
            const confidence = row.confidence ?? 0;
            tally[confidence >= applyAbove / 100 ? 0 : confidence >= DEFAULT_LISTEN_BELOW ? 1 : 2] += 1;
            counts.set(name, tally);
        }

        blocks.push(
            `Part ${part.number} (${part.speakers.length} lines):`,
            table(
                [
                    "Person",
                    `${applyAbove} % and more`,
                    `${listenBelow} to ${applyAbove - 1} %`,
                    `under ${listenBelow} % (shown as \`[Name: NN %]\`)`,
                ],
                ["---", "---:", "---:", "---:"],
                [...counts.entries()].map(([name, tally]) => [name, ...tally.map(String)])
            )
        );
    }

    return blocks.join("\n\n");
}

function markTranscript(part: LoadedPart, config: MeetingsPolishedConfig, warnings: string[]): string {
    let body = part.transcriptMd;

    for (const mark of config.transcriptMarks ?? []) {
        if (mark.record !== part.record.id) {
            continue;
        }

        if (!body.includes(mark.text)) {
            warnings.push(`The transcript mark "${mark.text}" is not in the transcript of ${part.record.id}.`);
            continue;
        }

        body = body.split(mark.text).join(`${mark.text} <sup>(${mark.note})</sup>`);
    }

    return body;
}

function diffsSection(parts: LoadedPart[], phrases: PolishedPhrases): string {
    const blocks = parts.map((part) => {
        const rows = part.speakers.map((row) => {
            const at = formatClock(row.atSec);
            const confidence = row.confidence === null ? "" : ` ${percentText(row.confidence)}`;
            return [
                `- ${at} [${phrases.sourceLabel}: ${row.label}] ${shortText(row.text)}`,
                `+ ${at} ${row.name ?? row.label}${confidence}`,
                `// ${row.why.replace(/\s+/g, " ")}`,
            ].join("\n");
        });
        return details(
            `Speakers: part ${part.number} (${part.speakers.length} lines)`,
            `\`\`\`diff\n${rows.join("\n")}\n\`\`\``
        );
    });
    const terms = parts.flatMap((part) =>
        part.terms.map((row) => {
            const at = `${part.config.marker ? `${part.config.marker} ` : ""}${formatClock(row.atSec)}`;
            const confidence = row.confidence === null ? "" : ` ${percentText(row.confidence)}`;
            return [`- ${at} ${row.heard}`, `+ ${at} ${row.becomes}`, `// ${row.reason}${confidence}`].join("\n");
        })
    );

    if (terms.length > 0) {
        blocks.push(details(`Terms and removals (${terms.length})`, `\`\`\`diff\n${terms.join("\n")}\n\`\`\``));
    }

    return blocks.join("\n\n");
}

function unresolvedEntry(input: {
    entry: PolishedUnresolved;
    phrases: PolishedPhrases;
    text: (markdown: string) => string;
    timeOf: (record: string, at: string) => string;
    marker: string | undefined;
}): string {
    const { entry, phrases, text } = input;
    const where = `**${entry.id}** ${input.timeOf(entry.record, entry.at)}${input.marker ? ` (${input.marker})` : ""}`;
    const listen = entry.listen ? `\n→ ${entry.listen}` : "";
    const options = (last: string) =>
        [...entry.readings, entry.elseReading ?? last]
            .map((reading, index) => `- ${String.fromCharCode(97 + index)}) ${text(reading)}`)
            .join("\n");

    if (entry.heard === undefined || entry.sentence === undefined) {
        return `${where}: ${text(entry.question ?? "")}\n${options(phrases.someoneElse)}${listen}`;
    }

    const sentence = entry.sentence.includes(entry.heard)
        ? entry.sentence.replace(entry.heard, `**${entry.heard}**`)
        : `${entry.sentence} (**${entry.heard}**)`;
    const head = `${where}: „${sentence}“`;
    const screen = entry.screen;
    const values = (chars: number) => ({
        proposed: screen?.proposed,
        confidence: typeof screen?.confidence === "number" ? percentText(screen.confidence) : undefined,
        frame: screen?.frame,
        ocr: screen?.ocr?.slice(0, chars),
        reason: screen?.reason,
    });

    if (screen?.resolved && screen.stored) {
        return `${head}\n- ${fillPhrase(phrases.screenSettled, values(SETTLED_OCR_CHARS))}${listen}`;
    }

    const hint = screen
        ? `\n- ${screen.resolved ? fillPhrase(phrases.screenHint, values(HINT_OCR_CHARS)) : fillPhrase(phrases.screenUndecided, values(HINT_OCR_CHARS))}`
        : "";
    return `${head}\n${options(phrases.somethingElse)}${hint}${listen}`;
}

function questionsSection(input: {
    config: MeetingsPolishedConfig;
    parts: LoadedPart[];
    times: ReadonlyMap<string, PartTimes>;
    text: (markdown: string) => string;
}): string | undefined {
    const { config, parts, times, text } = input;
    const asked = parts.filter((part) => part.questions.length > 0);
    const words = (config.unresolved ?? []).filter((entry) => entry.heard !== undefined);

    if (asked.length === 0 && words.length === 0) {
        return undefined;
    }

    const blocks: string[] = [];

    if (asked.length > 0) {
        const byEar = asked
            .map(
                (part) =>
                    `\`${toolCommand("meetings", "listen", part.record.id)}\` (${plural(part.questions.length, "question")})`
            )
            .join(" and ");
        blocks.push(
            `By ear: ${byEar}.${config.openQuestions?.intro?.trim() ? ` ${text(config.openQuestions.intro.trim())}` : ""}`
        );
    }

    for (const part of asked) {
        const link = times.get(part.config.token)?.link;
        const rows = part.questions.map((question) => {
            const replaced = config.overrides?.questions?.[`${part.record.id}#${question.label}`];
            const said =
                replaced === undefined
                    ? `${playTime(formatClock(question.fromSec), link?.(question.fromSec) ?? null)} ${question.text}`
                    : text(replaced);
            return `- **${question.label}** ${said}`;
        });
        blocks.push(`### Open (${part.questions.length}, record ${part.record.id})`, rows.join("\n"));
    }

    if (words.length > 0) {
        const settled = words.some((entry) => entry.screen?.resolved && entry.screen.stored);
        blocks.push(
            "### Not by ear",
            `- The unclear words ${words[0]!.id} to ${words.at(-1)!.id}${settled ? " that are not marked ✅" : ""}: answer "U3 b)" in the chat.`
        );
    }

    return blocks.join("\n\n");
}
