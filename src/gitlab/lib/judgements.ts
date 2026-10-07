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
    /** `- Key: value` fields, in order. */
    fields: Map<string, string>;
    /** `  - …` bullets under a field (Rationale). */
    bullets: Map<string, string[]>;
    /** The fenced block that follows a `- Proposed …:` field. */
    fences: Map<string, string>;
    /** 1-based line of the heading. */
    line: number;
}

export interface Judgements {
    /** `- Key: value` lines under the first heading (`Overall`, `Summary`). */
    header: Map<string, string>;
    items: JudgementItem[];
    /** Free sections at the end: `# Checked and fine`, `# Considered, not worth a comment`, `# Decisions`. */
    sections: Map<string, string>;
}

const ITEM_HEADING = /^# ([TYDN])(\d{2,}) (.*)$/;
const PAIR = /^(discussion|draft) (\S+)$/;
const FIELD = /^- ([^:]+):\s?(.*)$/;
const BULLET = /^ {2,}- (.*)$/;
const FENCE_OPEN = /^(`{3,})/;

function parseHeading(rest: string): { title: string; pair: JudgementItem["pair"] } {
    const parts = rest.split(" · ").map((part) => part.trim());
    const pairAt = parts.findIndex((part) => PAIR.test(part));
    const pairMatch = pairAt === -1 ? null : PAIR.exec(parts[pairAt]);

    return {
        title: parts[0] ?? "",
        pair: pairMatch ? { kind: pairMatch[1] as "discussion" | "draft", value: pairMatch[2] } : null,
    };
}

export function parseJudgements(text: string): Judgements {
    const lines = text.split(/\r?\n/);
    const header = new Map<string, string>();
    const items: JudgementItem[] = [];
    const sections = new Map<string, string>();
    let item: JudgementItem | null = null;
    let section: { name: string; lines: string[] } | null = null;
    let lastField: string | null = null;
    let seenFirstHeading = false;

    const closeSection = (): void => {
        if (section) {
            sections.set(section.name, section.lines.join("\n").trim());
            section = null;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const heading = ITEM_HEADING.exec(raw);

        if (heading) {
            closeSection();
            const { title, pair } = parseHeading(heading[3]);
            item = {
                id: `${heading[1]}${heading[2]}`,
                kind: heading[1] as ItemKind,
                title,
                pair,
                fields: new Map(),
                bullets: new Map(),
                fences: new Map(),
                line: i + 1,
            };
            items.push(item);
            lastField = null;
            continue;
        }

        if (raw.startsWith("# ")) {
            closeSection();
            item = null;
            lastField = null;

            if (!seenFirstHeading) {
                seenFirstHeading = true;
                continue;
            }

            section = { name: raw.slice(2).trim(), lines: [] };
            continue;
        }

        if (section) {
            section.lines.push(raw);
            continue;
        }

        const fence = FENCE_OPEN.exec(raw);

        if (fence && item && lastField) {
            const body: string[] = [];
            let j = i + 1;

            while (j < lines.length && lines[j].trimEnd() !== fence[1]) {
                body.push(lines[j]);
                j++;
            }

            item.fences.set(lastField, body.join("\n"));
            i = j;
            continue;
        }

        const field = FIELD.exec(raw);

        if (field) {
            const key = field[1].trim();
            lastField = key;

            if (item) {
                item.fields.set(key, field[2].trim());
            } else {
                header.set(key, field[2].trim());
            }

            continue;
        }

        const bullet = BULLET.exec(raw);

        if (bullet && item && lastField) {
            item.bullets.set(lastField, [...(item.bullets.get(lastField) ?? []), bullet[1].trim()]);
        }
    }

    closeSection();

    return { header, items, sections };
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
