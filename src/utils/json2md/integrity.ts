/**
 * Hand-edit detection for generated markdown.
 *
 * A generated `.md` drifts from its `.json` for two very different reasons, and treating them
 * the same is how hand-written prose gets silently overwritten:
 *
 *  - the DATA changed, so regenerating is correct and loses nothing;
 *  - the FILE was edited by hand, so regenerating destroys someone's work.
 *
 * Telling them apart needs one fact the file must carry itself: the hash of the body exactly
 * as the generator last wrote it. If the body still hashes to that value, nobody touched it.
 * If it does not, someone did, and no amount of diffing against fresh output can prove
 * otherwise, because fresh output differs in both cases.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./value";

export const STAMP_VERSION = 1;

/** The marker lives in an HTML comment, so it renders as nothing and survives a copy-paste. */
const STAMP_RE = /\n?<!--\s*json2md:stamp\s+(.*?)\s*-->\s*$/;

export interface Stamp {
    version: number;
    /** Hash of the body above the stamp, as the generator wrote it. */
    content: string;
    /** Hash of the input data at generation time. Tells a data change from a no-op. */
    source?: string;
    /** Path to the generator module, relative to the markdown file. */
    generator?: string;
    generated?: string;
    /** The exact command that regenerates this file. */
    command?: string;
}

export function hashText(value: string): string {
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Hashes data by its stable serialization, so key order never shows up as a change.
 *
 * The serialization quotes strings and keys. An unquoted one hashed `{ a: 1 }` and `{ a: "1" }`
 * alike, and `{ a: "1,b:2" }` like `{ a: 1, b: 2 }`, so a real data change could read as
 * "the generator changed".
 */
export function hashData(value: unknown): string {
    return hashText(stableStringify(value));
}

function formatAttributes(stamp: Stamp): string {
    const parts = [`v${stamp.version}`, `content=${stamp.content}`];

    if (stamp.source) {
        parts.push(`source=${stamp.source}`);
    }

    // Encoded like `command`: attributes split on whitespace, so a generator path with a space
    // in it (`My Reports/doc.ts`) was cut in half and `check X.md` resolved the wrong module.
    if (stamp.generator) {
        parts.push(`generator=${encodeURIComponent(stamp.generator)}`);
    }

    if (stamp.generated) {
        parts.push(`generated=${stamp.generated.replace(/\s/g, "T")}`);
    }

    if (stamp.command) {
        parts.push(`command=${encodeURIComponent(stamp.command)}`);
    }

    return parts.join(" ");
}

/**
 * Appends the stamp to a rendered body. The hash covers the body, never the stamp itself.
 *
 * The hash is taken over the body EXACTLY as written, which is also what `stripStamp` hands back
 * on the next read. Hashing the body before its trailing whitespace was normalized made a CRLF
 * body, a body without a final newline, or one ending in several, read as hand-edited straight
 * after generation, and every later build refused.
 */
export function stampMarkdown(body: string, meta: Omit<Stamp, "version" | "content"> = {}): string {
    const written = `${stripStamp(body).body.replace(/\s*$/, "")}\n`;
    const stamp: Stamp = { version: STAMP_VERSION, content: hashText(written), ...meta };

    return `${written}\n<!-- json2md:stamp ${formatAttributes(stamp)} -->\n`;
}

/** Splits a document into its body and its stamp. A file with no stamp yields `null`. */
export function stripStamp(markdown: string): { body: string; stamp: Stamp | null } {
    const match = markdown.match(STAMP_RE);

    if (!match) {
        return { body: markdown, stamp: null };
    }

    const body = markdown.slice(0, match.index);
    const attributes = match[1]!.split(/\s+/);
    const stamp: Stamp = { version: 0, content: "" };

    for (const attribute of attributes) {
        if (/^v\d+$/.test(attribute)) {
            stamp.version = Number(attribute.slice(1));
            continue;
        }

        const separator = attribute.indexOf("=");

        if (separator === -1) {
            continue;
        }

        const key = attribute.slice(0, separator);
        const value = attribute.slice(separator + 1);

        if (key === "content") {
            stamp.content = value;
        } else if (key === "source") {
            stamp.source = value;
        } else if (key === "generator") {
            stamp.generator = decodeURIComponent(value);
        } else if (key === "generated") {
            stamp.generated = value.replace("T", " ");
        } else if (key === "command") {
            stamp.command = decodeURIComponent(value);
        }
    }

    return { body, stamp };
}

export type Verdict =
    /** The file matches what the generator produces right now. Nothing to do. */
    | "clean"
    /** The file is untouched, but the data moved. Regenerating is safe. */
    | "stale"
    /** Someone edited the markdown by hand. Regenerating would destroy that edit. */
    | "hand-edited"
    /** The file has no stamp, so a hand edit cannot be ruled out. */
    | "unstamped"
    /** A stamp from a newer format than this build understands. */
    | "unsupported";

export interface CheckInput {
    /** The file's current text, stamp included. */
    current: string;
    /** What the generator produces from today's data, stamp excluded. */
    regenerated?: string;
    /** Hash of today's input data. */
    sourceHash?: string;
}

export interface CheckResult {
    verdict: Verdict;
    stamp: Stamp | null;
    /** True when the data moved since the file was written. */
    dataChanged: boolean;
    /** One sentence naming what happened and what to do next. */
    message: string;
}

/**
 * Decides which of the two drifts happened.
 *
 * 🛑 The hand-edited verdict is decided ONLY by the content hash, never by diffing against
 * fresh output. Fresh output differs in the stale case too, so a diff cannot separate them.
 */
export function checkMarkdown(input: CheckInput): CheckResult {
    const { body, stamp } = stripStamp(input.current);

    if (!stamp) {
        return {
            verdict: "unstamped",
            stamp: null,
            dataChanged: false,
            message:
                "No json2md stamp. This file was not written by a generator, or the stamp was removed. Regenerate it once to start tracking it.",
        };
    }

    if (stamp.version > STAMP_VERSION) {
        return {
            verdict: "unsupported",
            stamp,
            dataChanged: false,
            message: `Stamp version ${stamp.version} is newer than this build understands (${STAMP_VERSION}). Upgrade GenesisTools rather than regenerating.`,
        };
    }

    const actual = hashText(body);
    const dataChanged = Boolean(input.sourceHash && stamp.source && input.sourceHash !== stamp.source);

    if (actual !== stamp.content) {
        return {
            verdict: "hand-edited",
            stamp,
            dataChanged,
            message:
                "The markdown was edited by hand after it was generated. Regenerating would discard that edit. Move the edit into the generator or the data, then regenerate.",
        };
    }

    if (
        input.regenerated !== undefined &&
        stripStamp(input.regenerated).body.replace(/\s*$/, "") !== body.replace(/\s*$/, "")
    ) {
        return {
            verdict: "stale",
            stamp,
            dataChanged,
            message: dataChanged
                ? "The data changed and the markdown is untouched. Regenerating is safe."
                : "The generator now produces different output for the same data. Regenerating is safe.",
        };
    }

    if (input.regenerated === undefined && dataChanged) {
        return {
            verdict: "stale",
            stamp,
            dataChanged,
            message: "The data changed since this file was written, and the file is untouched. Regenerating is safe.",
        };
    }

    return { verdict: "clean", stamp, dataChanged, message: "Up to date and untouched." };
}
