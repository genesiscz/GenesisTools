import { splitFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { stripStamp } from "@genesiscz/utils/json2md/integrity";
import {
    type MeetingsPolishedInput,
    meetingsPolishedSchema,
    POLISHED_SECTIONS,
    type PolishedSection,
} from "@genesiscz/utils/meetings/polished";
import { MEETING_SOURCE_IDS } from "@genesiscz/utils/meetings/sources";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";
import type { AdoptReport } from "./adopt";
import { POLISHED_SECTION_TITLES } from "./render";
import { FENCE_RE } from "./tokens";

/**
 * Adopting a polished markdown that was written by hand, before `.polished.ts` files existed: the front matter and
 * the authored sections go back into config fields, the play links back into `[[<token>:MM:SS]]` tokens, and every
 * section the build would write from the records keeps the markdown's own text as an override, so the first build
 * writes the same body again. Deleting an override hands that section to the records.
 */

type Json = Record<string, unknown>;

const SOURCE_IDS: ReadonlySet<string> = new Set(MEETING_SOURCE_IDS);
/** Front matter keys that name the meeting record of each part, most specific first. */
const PART_KEYS = ["meeting_records", "meeting_record", "record"] as const;
/** Sections the build writes from the records or from list fields; adopted, they keep the markdown's text. */
const FROZEN: ReadonlySet<PolishedSection> = new Set([
    "participants",
    "transcript",
    "diffs",
    "unresolved",
    "questions",
]);
/** Sections the build writes with no config at all: a markdown without one leaves it out (`null`). */
const ALWAYS_BUILT: readonly PolishedSection[] = ["participants", "transcript", "diffs", "questions"];
const SECTION_OF_TITLE = new Map(
    Object.entries(POLISHED_SECTION_TITLES).map(([id, title]) => [title, id as PolishedSection])
);
/** The play link the build writes for a token (`playTime`): the time in backticks, then a superscript play link. */
const PLAY_LINK = /`(\d+(?::\d{2}){1,2})`<sup>\[play\]\(([^)\s]+)\)<\/sup>/g;
const ZONE_SUFFIX = /\s*\([^)]*\)\s*$/;

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOf(value: unknown): string[] {
    if (typeof value === "string" && value.trim()) {
        return [value.trim()];
    }

    return Array.isArray(value)
        ? value.filter((one): one is string => typeof one === "string" && one.trim() !== "")
        : [];
}

function playLinkOf(href: string): { meeting: string; at: string } | undefined {
    if (!URL.canParse(href)) {
        return undefined;
    }

    const url = new URL(href);
    const meeting = url.searchParams.get("meeting");
    const at = url.searchParams.get("at");
    return meeting && at ? { meeting, at } : undefined;
}

/** Every play link's meeting, in the order they first appear outside code fences. */
function linkedMeetings(text: string): string[] {
    const seen = new Set<string>();

    for (const piece of text.split(FENCE_RE)) {
        if (piece.startsWith("```")) {
            continue;
        }

        for (const match of piece.matchAll(PLAY_LINK)) {
            const link = playLinkOf(match[2]!);

            if (link) {
                seen.add(link.meeting);
            }
        }
    }

    return [...seen];
}

interface Chunk {
    /** The `## ` heading's words; null for the text between the title and the first `## `. */
    heading: string | null;
    /** The chunk's lines, its heading line included. */
    lines: string[];
}

/** The body after its `# ` title, cut at each `## ` heading outside a code fence. */
function chunksOf(body: string): { title: string; chunks: Chunk[] } {
    const lines = body.split("\n");
    const start = lines.findIndex((line) => line.trim() !== "");
    const title = lines[start]?.match(/^# (.+)$/)?.[1]?.trim();

    if (!title) {
        throw new Error("The markdown does not start with a `# ` title line, so it is not a polished file.");
    }

    const chunks: Chunk[] = [{ heading: null, lines: [] }];
    let fenced = false;

    for (const line of lines.slice(start + 1)) {
        if (line.startsWith("```")) {
            fenced = !fenced;
        }

        const heading = fenced ? undefined : line.match(/^## (.+)$/)?.[1]?.trim();

        if (heading !== undefined) {
            chunks.push({ heading, lines: [line] });
        } else {
            chunks.at(-1)!.lines.push(line);
        }
    }

    return { title, chunks };
}

/**
 * Turns a polished markdown with no `.polished.ts` (written by hand, or a built one whose module is gone) into a
 * polished config. `records` names the meeting record of each part when the front matter does not; `resolve` maps a
 * meeting reference (a record id, an older id a join absorbed) to its record id, or undefined when there is none.
 */
export function adoptPolishedMarkdown(options: {
    markdown: string;
    records?: string[];
    resolve?: (ref: string) => string | undefined;
}): { config: MeetingsPolishedInput; report: AdoptReport } {
    const report: AdoptReport = { mapped: [], kept: [], notes: [] };
    const { body: unstamped, stamp } = stripStamp(options.markdown);
    const split = splitFrontmatter(unstamped);
    const parsed: unknown = split.raw && split.format === "yaml" ? Bun.YAML.parse(split.raw) : {};
    const front: Json = isObject(parsed) ? parsed : {};
    const { title: heading, chunks } = chunksOf(split.body);
    const resolve = options.resolve ?? ((ref: string) => ref);
    const used = new Set<string>();

    if (stamp) {
        report.notes.push(
            `The markdown carries a build stamp (generator ${stamp.generator ?? "unknown"}): it was built from a .polished.ts once; this one is made from its text.`
        );
    }

    // The parts: --record, else the front matter, else the meetings its play links name.
    const fromKey = PART_KEYS.find((key) => listOf(front[key]).length > 0);
    const meetingId = typeof front.meeting_id === "string" ? front.meeting_id.trim() : undefined;
    let refs: string[];

    if (options.records?.length) {
        refs = options.records;
        report.mapped.push("--record → parts[].record");
    } else if (fromKey) {
        refs = listOf(front[fromKey]);
        used.add(fromKey);
        report.mapped.push(`${fromKey} → parts[].record`);
    } else if (meetingId && resolve(meetingId)) {
        refs = [meetingId];
        used.add("meeting_id");
        report.mapped.push("meeting_id → parts[0].record");
    } else {
        refs = linkedMeetings(split.body);
        report.mapped.push("the play links' meetings → parts[].record");
        report.notes.push(
            `parts: the front matter names no record, so the parts are the meetings the play links name (${refs.join(", ") || "none"}); pass --record to name them yourself.`
        );
    }

    if (refs.length === 0) {
        throw new Error(
            "The markdown names no meeting record (no meeting_record key, no play link): pass --record <id>."
        );
    }

    const records = refs.map((ref) => {
        const id = resolve(ref);

        if (!id) {
            throw new Error(`No meeting "${ref}": pass --record with the record id of each part.`);
        }

        return id;
    });
    const tokens = records.length === 1 ? ["t"] : records.map((_record, index) => String.fromCharCode(97 + index));
    const parts: Json[] = records.map((record, index) => ({ record, token: tokens[index] }));
    const tokenOfRecord = new Map(records.map((record, index) => [record, tokens[index]!]));
    // Only a link the build writes back as it is becomes a token: its meeting is the part's record id and its time is
    // written the build's way (`06:07`). An older id or `6:07` stays as written, so the first build changes no link.
    const links = { tokens: 0, kept: 0 };
    const tokenize = (text: string) =>
        text
            .split(FENCE_RE)
            .map((piece) =>
                piece.startsWith("```")
                    ? piece
                    : piece.replace(PLAY_LINK, (whole, label: string, href: string) => {
                          const link = playLinkOf(href);
                          const token = link ? tokenOfRecord.get(link.meeting) : undefined;
                          const atSec = parseClock(label);

                          if (!link || !token || atSec === undefined || link.at !== formatClock(atSec)) {
                              links.kept += 1;
                              return whole;
                          }

                          links.tokens += 1;
                          return `[[${token}:${label}]]`;
                      })
            )
            .join("");

    const config: Json = { parts };
    const title = typeof front.title === "string" && front.title.trim() ? front.title.trim() : undefined;
    config.title = title ?? heading.replace(/\s*\(polished\)$/, "");
    report.mapped.push(title ? "title" : "the # title → title");
    used.add("title");

    if (heading !== `${config.title} (polished)`) {
        config.heading = heading;
        report.mapped.push("the # title → heading");
    }

    adoptFrontmatter({ front, used, parts, config, report });

    // The sections, in the markdown's order: a known one in the build's order takes its place, any other heading is
    // an extra section after the last placed one, and text before the first placed one is the intro.
    const intro: string[] = [];
    const sections: Json[] = [];
    const overrides: Record<string, string | null> = {};
    const placed = new Set<PolishedSection>();
    let last = -1;

    for (const chunk of chunks) {
        const id = chunk.heading === null ? undefined : SECTION_OF_TITLE.get(chunk.heading);
        const slot = id === undefined ? -1 : POLISHED_SECTIONS.indexOf(id);
        const text = () => tokenize(chunk.lines.slice(1).join("\n").trim());

        if (id !== undefined && slot > last) {
            last = slot;
            placed.add(id);

            if (FROZEN.has(id)) {
                overrides[id] = text();
                report.mapped.push(`## ${chunk.heading} → overrides.sections.${id}`);
            } else {
                config[id] = { md: text() };
                report.mapped.push(`## ${chunk.heading} → ${id}.md`);
            }

            continue;
        }

        if (last < 0) {
            intro.push(chunk.lines.join("\n"));
            continue;
        }

        sections.push({ heading: chunk.heading, after: POLISHED_SECTIONS[last], md: text() });
        report.mapped.push(`## ${chunk.heading} → sections[${sections.length - 1}] (after ${POLISHED_SECTIONS[last]})`);
    }

    const introText = tokenize(intro.join("\n").trim());

    if (introText) {
        config.intro = introText;
        report.mapped.push("the text before the first section → intro");
    }

    if (sections.length > 0) {
        config.sections = sections;
    }

    for (const id of ALWAYS_BUILT) {
        if (!placed.has(id)) {
            overrides[id] = null;
        }
    }

    if (Object.keys(overrides).length > 0) {
        config.overrides = { sections: overrides };
    }

    const frozen = Object.entries(overrides).filter(([, value]) => value !== null);
    const left = Object.entries(overrides).filter(([, value]) => value === null);

    if (frozen.length > 0) {
        report.notes.push(
            `overrides.sections.${frozen.map(([id]) => id).join(", ")} hold the markdown's own text, so the first build writes the same body. Delete one to let the build write that section from the records.`
        );
    }

    if (left.length > 0) {
        report.notes.push(
            `overrides.sections.${left.map(([id]) => id).join(", ")} are null: the markdown has no such section, so the build leaves it out. Delete one to have it.`
        );
    }

    report.notes.push(
        `Play links: ${links.tokens} became [[<token>:MM:SS]] tokens${links.kept > 0 ? `, ${links.kept} stay as written (their meeting is not a part's record id, or their time is not written as the build writes it, such as 6:07 for 06:07)` : ""}.`
    );

    const result = meetingsPolishedSchema.safeParse(config);

    if (!result.success) {
        throw new Error(`The adopted config is not valid:\n${z.prettifyError(result.error)}`);
    }

    return { config: result.data, report };
}

/**
 * The front matter: what the build writes again from config fields or parts is mapped there, what it derives from
 * the records is dropped with a note, and every other key stays as `frontmatter`.
 */
function adoptFrontmatter(input: {
    front: Json;
    used: Set<string>;
    parts: Json[];
    config: Json;
    report: AdoptReport;
}): void {
    const { front, used, parts, config, report } = input;
    const take = (key: string, field: string) => {
        if (front[key] !== undefined && !used.has(key)) {
            config[field] = front[key];
            used.add(key);
            report.mapped.push(key === field ? key : `${key} → ${field}`);
        }
    };

    take("status", "status");
    take("written", "writtenAt");
    take("updated", "updatedAt");

    if (typeof front.private === "boolean") {
        take("private", "private");
    }

    const source =
        typeof front.source === "string" && SOURCE_IDS.has(front.source.trim()) ? front.source.trim() : undefined;
    const sourcesOf = (index: number): Record<string, Json> => {
        const part = parts[index]!;
        part.sources ??= {};
        return part.sources as Record<string, Json>;
    };

    for (const sourceId of MEETING_SOURCE_IDS) {
        for (const key of [`${sourceId}_ids`, `${sourceId}_id`]) {
            const ids = listOf(front[key]);

            if (ids.length > 0 && ids.length === parts.length && !used.has(key)) {
                ids.forEach((id, index) => {
                    sourcesOf(index)[sourceId] = { ...sourcesOf(index)[sourceId], meetingId: id };
                });
                used.add(key);
                report.mapped.push(`${key} → parts[].sources.${sourceId}.meetingId`);
            }
        }
    }

    if (
        source &&
        parts.length === 1 &&
        typeof front.meeting_id === "string" &&
        !used.has("meeting_id") &&
        sourcesOf(0)[source]?.meetingId === undefined
    ) {
        sourcesOf(0)[source] = { ...sourcesOf(0)[source], meetingId: front.meeting_id.trim() };
        used.add("meeting_id");
        report.mapped.push(`meeting_id → parts[0].sources.${source}.meetingId`);
    }

    for (const key of ["share_links", "share_link", "share"]) {
        const links = listOf(front[key]);

        if (links.length === 0 || links.length !== parts.length || used.has(key)) {
            continue;
        }

        const owners = links.map((_link, index) => Object.keys(sourcesOf(index))[0] ?? source);

        if (owners.some((owner) => owner === undefined)) {
            continue;
        }

        links.forEach((link, index) => {
            const owner = owners[index]!;
            sourcesOf(index)[owner] = { ...sourcesOf(index)[owner], shareLink: link };
        });
        used.add(key);
        report.mapped.push(`${key} → parts[].sources.<source>.shareLink`);
    }

    for (const part of parts) {
        if (isObject(part.sources) && Object.keys(part.sources).length === 0) {
            delete part.sources;
        }
    }

    for (const [key, field, index] of [
        ["start", "start", 0],
        ["end", "end", parts.length - 1],
    ] as const) {
        if (typeof front[key] === "string") {
            parts[index]![field] = front[key].replace(ZONE_SUFFIX, "");
            used.add(key);
            report.mapped.push(`${key} → parts[${index}].${field}`);
        }
    }

    const rawExports = listOf(front.raw_export);

    if (rawExports.length > 0 && rawExports.length === parts.length) {
        rawExports.forEach((rawExport, index) => {
            parts[index]!.rawExport = rawExport;
        });
        used.add("raw_export");
        report.mapped.push("raw_export → parts[].rawExport");
    }

    if (source) {
        used.add("source");
        report.notes.push(`source: the build writes it from the records (${source}).`);
    }

    for (const [key, why] of [
        ["waiting_for", "the build writes it from the records' open listen questions"],
        ["sessions", "the build keeps the markdown's own list when it replaces the file"],
    ] as const) {
        if (front[key] !== undefined) {
            used.add(key);
            report.notes.push(`${key}: not in the config; ${why}.`);
        }
    }

    const renamed = [...used].filter((key) =>
        [
            "meeting_record",
            "record",
            "meeting_id",
            "share_link",
            "share",
            ...MEETING_SOURCE_IDS.map((id) => `${id}_id`),
        ].includes(key)
    );

    if (renamed.length > 0) {
        report.notes.push(
            `${renamed.join(", ")}: the build writes these under its own names (meeting_records, share_links, <source>_ids) and keeps the old keys of the markdown it replaces; delete the old ones after the first build.`
        );
    }

    const rest = Object.fromEntries(Object.entries(front).filter(([key]) => !used.has(key)));

    if (Object.keys(rest).length > 0) {
        config.frontmatter = rest;
        report.mapped.push(`${Object.keys(rest).join(", ")} → frontmatter`);
    }
}
