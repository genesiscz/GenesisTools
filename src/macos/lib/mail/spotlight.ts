import { homedir } from "node:os";
import { basename } from "node:path";
import logger from "@app/logger";

export function extractRowidFromEmlxPath(emlxPath: string): number | null {
    const base = basename(emlxPath);
    const m = base.match(/^(\d+)(?:\.partial)?\.emlx$/);

    if (!m) {
        return null;
    }

    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

/**
 * Sanitize a user query for safe interpolation into Spotlight's NSPredicate
 * string. Spotlight metacharacters that break the predicate parser:
 *   "  -- string terminator
 *   \  -- escape char
 *   *? -- wildcards (we add our own outer wildcards)
 *   ()[]{} -- grouping
 *   <>=!&|, -- operators
 *
 * Strategy: keep only word characters, whitespace, and a small set of safe
 * punctuation (apostrophe, dash, dot, @ — common in real searches). Drop the
 * rest. Conservative but predictable.
 */
export function sanitizeSpotlightQuery(query: string): string {
    // Escaped hyphen so the character class is all literals — no range that accidentally keeps ( ) * + ,
    return query
        .normalize("NFC")
        .replace(/[^\p{L}\p{N}\s'._@-]/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

/**
 * Use Spotlight to find Mail.app rowids whose body matches `query`.
 * Returns an empty array on Spotlight errors (e.g. mds disabled, mdfind missing).
 */
export async function mdfindMailRowids(query: string, limit = 10000): Promise<number[]> {
    const cleaned = sanitizeSpotlightQuery(query);

    if (cleaned.length === 0) {
        return [];
    }

    const onlyIn = `${homedir()}/Library/Mail`;
    // After sanitization the string contains no quotes/backslashes — safe to interpolate.
    const predicate = `kMDItemContentType == "com.apple.mail.emlx" && kMDItemTextContent == "*${cleaned}*"c`;

    const proc = Bun.spawn(["mdfind", "-onlyin", onlyIn, predicate], {
        stdout: "pipe",
        stderr: "pipe",
    });

    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;

    if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        logger.debug({ code, err }, "[spotlight] mdfind failed");
        return [];
    }

    const rowids = new Set<number>();

    for (const line of out.split("\n")) {
        const id = extractRowidFromEmlxPath(line.trim());
        if (id !== null) {
            rowids.add(id);
        }

        if (rowids.size >= limit) {
            break;
        }
    }

    return [...rowids];
}
