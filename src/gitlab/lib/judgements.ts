/**
 * The agent's judgements of one review, in ONE markdown file per MR. The layout is the report's own
 * (the same labels a person reads), with every generated part left out: excerpts, file links and the
 * quoted comments come from the facts when the report is rendered.
 *
 *   # MR !7412 · give · head 02efb57dea
 *   - Overall: Approve with comments
 *
 *   # T03 The lock stays off · discussion 0539a97 · src/auth/lock.ts:83
 *   - Verdict: Valid [95%]
 *   - Proposal: Accept, fix in AppStateProvider
 *   - Rationale:
 *     - The guard returns early while a browser is open: src/auth/lock.ts:83
 *   - Action: reply
 *   - Proposed draft reply:
 *
 *   ```markdown
 *   Dobrej catch. …
 *   ```
 *
 * Items are `# <id> <title> · <pair> · <anchor>`; the pair (`discussion …`, `draft …`) is written by
 * `review skeleton` and checked against the MR, so an id from another session cannot point at the wrong
 * thread. New findings are `# N01 …` with an `- Anchor: path:line (new) \`text of that line\``.
 */

import { dedent, type MdSection, md2json } from "@genesiscz/utils/json/md2json";
import { repairJson } from "@genesiscz/utils/json/repair";

export const ITEM_KINDS = ["T", "Y", "D", "N"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What `comments post` does with an item. */
export const ACTIONS: Record<ItemKind, readonly string[]> = {
    T: ["reply", "reply-resolve", "none"],
    Y: ["reply", "none"],
    D: ["keep", "reword", "move", "delete"],
    N: ["comment", "none"],
};

/** The fenced field that carries the text an action sends; in my own thread a reply is the answer. */
export function actionTextField(kind: ItemKind, action: string): string | null {
    if (action === "reply" || action === "reply-resolve") {
        return kind === "T" ? "Proposed draft reply" : "Proposed answer";
    }

    if (action === "reword" || action === "move") {
        return "Proposed rewording";
    }

    return action === "comment" ? "Proposed draft comment" : null;
}

export interface JudgementItem {
    id: string;
    kind: ItemKind;
    title: string;
    /** `discussion 0539a97` or `draft 22970` from the heading, when present. */
    pair: { kind: "discussion" | "draft"; value: string } | null;
    /** `- Key: value` fields, in order, under their canonical names (`Verdict`, `Action`, `💡 Suggestion`). */
    fields: Map<string, string>;
    /** `  - …` bullets under a field (Rationale). */
    bullets: Map<string, string[]>;
    /** The text of a `- Proposed …:` field: its fenced block, else the plain lines under it, dedented. */
    fences: Map<string, string>;
    /** 1-based line of the heading in a markdown file; the item's position in a JSON file. */
    line: number;
}

export interface JudgementWarning {
    /** An error makes `review check` fail: the file cannot be read the way it was meant. */
    severity: "error" | "warning";
    id: string;
    line: number;
    message: string;
}

export interface Judgements {
    /** `- Key: value` lines under the first heading (`Overall`, `Summary`). */
    header: Map<string, string>;
    items: JudgementItem[];
    /** Free sections at the end: `# Checked and fine`, `# Considered, not worth a comment`, `# Decisions`. */
    sections: Map<string, string>;
    /** What the reader repaired or could not read, with the line. */
    warnings: JudgementWarning[];
    format: "md" | "json";
}

/** The field names the flows use; anything else is reported and ignored. */
export const FIELD_NAMES = [
    "Overall",
    "Severity",
    "Anchor",
    "Verdict",
    "Verdict on the comment",
    "Answer to the comment",
    "Proposal",
    "Rationale",
    "💡 Suggestion",
    "Action",
    "Move to",
    "Proposed draft reply",
    "Proposed answer",
    "Proposed rewording",
    "Proposed draft comment",
] as const;

export const TEXT_FIELDS = new Set([
    "Proposed draft reply",
    "Proposed answer",
    "Proposed rewording",
    "Proposed draft comment",
]);

const squash = (key: string): string =>
    key
        .toLowerCase()
        .replace(/[^\p{L}\p{N} ]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

const ALIASES: Record<string, string> = {
    suggestion: "💡 Suggestion",
    "proposed reply": "Proposed draft reply",
    "draft reply": "Proposed draft reply",
    "proposed comment": "Proposed draft comment",
    "draft comment": "Proposed draft comment",
    "proposed reword": "Proposed rewording",
    rewording: "Proposed rewording",
    move: "Move to",
    "verdict on comment": "Verdict on the comment",
    "answer to comment": "Answer to the comment",
};

const CANONICAL = new Map<string, string>([
    ...FIELD_NAMES.map((name) => [squash(name), name] as const),
    ...Object.entries(ALIASES).map(([alias, name]) => [squash(alias), name] as const),
]);

/** The canonical name of a field as a person may have typed it, or null. */
export function canonicalField(key: string): string | null {
    return CANONICAL.get(squash(key)) ?? null;
}

/** `Reply + resolve`, `` `reply` ``, `REPLY` → the action names of ACTIONS; an unfilled `a | b` → "". */
export function normalizeAction(value: string): string {
    const plain = value
        .replace(/[`*_"']/g, "")
        .trim()
        .toLowerCase();

    if (plain.includes("|")) {
        return "";
    }

    return plain.replace(/\s*(\+|and|&)\s*/g, "-").replace(/\s+/g, "-");
}

const ITEM_TITLE = /^([TYDNtydn])\s*0*(\d{1,4})(?![\p{L}\p{N}])[\s:.·|—–-]*(.*)$/u;
const PAIR = /\b(discussion|draft)\s+([0-9a-f]{6,40}|\d+)\b/i;

function parseTitle(rest: string): { title: string; pair: JudgementItem["pair"] } {
    const pair = PAIR.exec(rest);
    const title = rest.split(/\s+[·|]\s+/)[0] ?? "";

    return {
        title: pair && title.match(PAIR) ? "" : title.trim(),
        pair: pair ? { kind: pair[1].toLowerCase() as "discussion" | "draft", value: pair[2].toLowerCase() } : null,
    };
}

function itemFromSection(section: MdSection, warnings: JudgementWarning[]): JudgementItem | null {
    const heading = ITEM_TITLE.exec(section.title);

    if (!heading) {
        return null;
    }

    const kind = heading[1].toUpperCase() as ItemKind;
    const id = `${kind}${heading[2].padStart(2, "0")}`;
    const { title, pair } = parseTitle(heading[3]);
    const item: JudgementItem = {
        id,
        kind,
        title,
        pair,
        fields: new Map(),
        bullets: new Map(),
        fences: new Map(),
        line: section.line,
    };
    const warn = (line: number, message: string, severity: "error" | "warning" = "warning"): void => {
        warnings.push({ severity, id, line, message });
    };

    for (const field of section.fields) {
        const name = canonicalField(field.key);

        if (!name) {
            warn(field.line, `unknown field "${field.key}"; it is ignored (the fields are: ${FIELD_NAMES.join(", ")})`);
            continue;
        }

        if (item.fields.has(name)) {
            warn(field.line, `"${name}" appears twice; the second one is used`);
        }

        if (name !== field.key) {
            warn(field.line, `"${field.key}" read as "${name}"`);
        }

        item.fields.set(name, name === "Action" ? normalizeAction(field.value) : field.value.trim());

        if (field.bullets.length > 0) {
            item.bullets.set(name, field.bullets);
        }

        if (!TEXT_FIELDS.has(name)) {
            continue;
        }

        if (field.fence) {
            if (!field.fence.closed) {
                warn(
                    field.fence.line,
                    `the fence under "${name}" is never closed, so everything after it would be posted`,
                    "error"
                );
            }

            item.fences.set(name, dedent(field.fence.body).trim());
        } else if (field.paragraphs.length > 0) {
            warn(field.line, `the text under "${name}" is not in a fence; it is read as written`);
            item.fences.set(name, dedent(field.paragraphs.join("\n")).trim());
        } else if (field.value.trim()) {
            item.fences.set(name, field.value.trim());
        }
    }

    return item;
}

/** A judgements file in markdown (the skeleton's form), hand edits tolerated where the meaning stays clear. */
export function parseJudgements(text: string): Judgements {
    const doc = md2json(text);
    const warnings: JudgementWarning[] = doc.warnings.map((w) => ({
        severity: "warning",
        id: "file",
        line: w.line,
        message: w.message,
    }));
    const header = new Map<string, string>();
    const items: JudgementItem[] = [];
    const sections = new Map<string, string>();

    doc.sections.forEach((section, index) => {
        const item = itemFromSection(section, warnings);

        if (item) {
            items.push(item);
            return;
        }

        if (index === 0 && items.length === 0) {
            for (const field of [...doc.preamble.fields, ...section.fields]) {
                header.set(canonicalField(field.key) ?? field.key, field.value.trim());
            }

            return;
        }

        sections.set(section.title.trim(), section.body);
    });

    // A fence the reader never closed swallowed the headings after it: say which ones.
    for (const warning of warnings) {
        if (/never closed|probably missing/.test(warning.message) && warning.severity === "warning") {
            warning.severity = "error";
        }
    }

    return { header, items, sections, warnings, format: "md" };
}

// ─── anchors ───────────────────────────────────────────────────────────────────

export interface ParsedAnchor {
    path: string;
    line: number;
    side: "new" | "old";
    /** The line's text as the agent copied it from the facts; checked against the MR before posting. */
    text: string | null;
    top: boolean;
}

const ANCHOR = /^(\S+?):(\d+)\s+\((new|old)\)(?:\s+`(.*)`)?\s*$/;

/** `src/a.ts:44 (new) \`const a = 1;\``, or `top` for a top-level comment. */
export function parseAnchor(value: string): ParsedAnchor | string {
    const trimmed = value.trim();

    if (trimmed === "top" || trimmed === "top-level") {
        return { path: "", line: 0, side: "new", text: null, top: true };
    }

    const match = ANCHOR.exec(trimmed);

    if (!match) {
        return `anchor must be \`path:line (new|old) \\\`text of that line\\\`\` or \`top\`, got "${trimmed}"`;
    }

    return {
        path: match[1],
        line: Number(match[2]),
        side: match[3] as "new" | "old",
        text: match[4] ?? null,
        top: false,
    };
}

// ─── badges ────────────────────────────────────────────────────────────────────

const BADGE = /\[(\d{1,3})%\]/;

/** The first `[NN%]` of a value, or null. */
export function badgeOf(value: string | undefined): number | null {
    const match = value ? BADGE.exec(value) : null;

    return match ? Number(match[1]) : null;
}

/** The verdict field of an item: `Verdict on the comment` for D and Y, `Verdict` otherwise. */
export function verdictOf(item: JudgementItem): string {
    return item.fields.get("Verdict on the comment") ?? item.fields.get("Verdict") ?? "";
}

// ─── JSON form ─────────────────────────────────────────────────────────────────

/** The JSON form of a judgements file: the same items, keyed by the same field names. */
export interface JudgementsJson {
    mr?: number;
    mode?: "receive" | "give";
    head?: string;
    overall?: string;
    items: Array<{
        id: string;
        title?: string;
        /** `discussion 0539a97f0000` or `draft 22970`, as `review skeleton` wrote it. */
        pair?: string;
        /** Field name → value: `Verdict`, `Action`, `Anchor`, … */
        fields?: Record<string, string>;
        rationale?: string[];
        /** Text field name → the text: `Proposed draft reply`, `Proposed answer`, … */
        texts?: Record<string, string>;
    }>;
    sections?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string =>
    typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

export function parseJudgementsJson(value: unknown): Judgements {
    const warnings: JudgementWarning[] = [];
    const result: Judgements = { header: new Map(), items: [], sections: new Map(), warnings, format: "json" };

    if (!isRecord(value) || !Array.isArray(value.items)) {
        warnings.push({ severity: "error", id: "file", line: 0, message: "the JSON needs an `items` array" });

        return result;
    }

    if (value.overall !== undefined) {
        result.header.set("Overall", asString(value.overall));
    }

    for (const [name, body] of Object.entries(isRecord(value.sections) ? value.sections : {})) {
        result.sections.set(name, asString(body));
    }

    value.items.forEach((raw, index) => {
        const line = index + 1;

        if (!isRecord(raw)) {
            warnings.push({ severity: "error", id: `item ${line}`, line, message: "an item must be an object" });
            return;
        }

        const heading = ITEM_TITLE.exec(asString(raw.id));

        if (!heading) {
            warnings.push({
                severity: "error",
                id: `item ${line}`,
                line,
                message: `"${asString(raw.id)}" is not an id like T03, D01, Y02 or N01`,
            });
            return;
        }

        const kind = heading[1].toUpperCase() as ItemKind;
        const id = `${kind}${heading[2].padStart(2, "0")}`;
        const pair = PAIR.exec(asString(raw.pair));
        const item: JudgementItem = {
            id,
            kind,
            title: asString(raw.title),
            pair: pair ? { kind: pair[1].toLowerCase() as "discussion" | "draft", value: pair[2].toLowerCase() } : null,
            fields: new Map(),
            bullets: new Map(),
            fences: new Map(),
            line,
        };

        for (const [key, fieldValue] of Object.entries(isRecord(raw.fields) ? raw.fields : {})) {
            const name = canonicalField(key);

            if (!name || TEXT_FIELDS.has(name)) {
                warnings.push({
                    severity: "warning",
                    id,
                    line,
                    message: name
                        ? `"${key}" belongs in texts; read from there`
                        : `unknown field "${key}"; it is ignored`,
                });

                if (name) {
                    item.fences.set(name, asString(fieldValue).trim());
                }

                continue;
            }

            item.fields.set(
                name,
                name === "Action" ? normalizeAction(asString(fieldValue)) : asString(fieldValue).trim()
            );
        }

        for (const [key, text] of Object.entries(isRecord(raw.texts) ? raw.texts : {})) {
            const name = canonicalField(key);

            if (!name || !TEXT_FIELDS.has(name)) {
                warnings.push({
                    severity: "warning",
                    id,
                    line,
                    message: `"${key}" is not a text field (${[...TEXT_FIELDS].join(", ")}); it is ignored`,
                });
                continue;
            }

            item.fences.set(name, asString(text).trim());
        }

        const rationale = Array.isArray(raw.rationale) ? raw.rationale.map(asString).filter(Boolean) : [];

        if (rationale.length > 0) {
            item.bullets.set("Rationale", rationale);
            item.fields.set("Rationale", "");
        }

        result.items.push(item);
    });

    return result;
}

/** The JSON form of parsed judgements (what `review skeleton --format json` writes). */
export function judgementsToJson(
    judgements: Judgements,
    meta: { mr?: number; mode?: "receive" | "give"; head?: string } = {}
): JudgementsJson {
    return {
        ...meta,
        overall: judgements.header.get("Overall") ?? "",
        items: judgements.items.map((item) => ({
            id: item.id,
            title: item.title,
            ...(item.pair ? { pair: `${item.pair.kind} ${item.pair.value}` } : {}),
            fields: Object.fromEntries(
                [...item.fields].filter(([name]) => name !== "Rationale" && !TEXT_FIELDS.has(name))
            ),
            rationale: item.bullets.get("Rationale")?.filter((bullet) => bullet.trim()) ?? [],
            texts: Object.fromEntries(
                [...TEXT_FIELDS]
                    .filter((name) => item.fields.has(name) || item.fences.has(name))
                    .map((name) => [name, item.fences.get(name) ?? ""])
            ),
        })),
        sections: Object.fromEntries(judgements.sections),
    };
}

/** A judgements file in either form: `.json` (or text that starts with `{`) is JSON, anything else markdown. */
export function parseJudgementsFile(text: string, path = ""): Judgements {
    if (!path.toLowerCase().endsWith(".json") && !text.trimStart().startsWith("{")) {
        return parseJudgements(text);
    }

    const repaired = repairJson(text);

    if (repaired.error) {
        const result = parseJudgementsJson(null);
        result.warnings[0].message = `the file is not valid JSON (${repaired.error})`;

        return result;
    }

    const result = parseJudgementsJson(repaired.value);

    if (repaired.repaired) {
        result.warnings.push({
            severity: "warning",
            id: "file",
            line: 0,
            message: "the JSON was broken and was repaired; check the texts read as meant",
        });
    }

    return result;
}
