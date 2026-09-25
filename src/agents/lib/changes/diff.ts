import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { formatPatch, structuredPatch } from "diff";
import { objectsDir } from "./objects";

const log = logger.child({ component: "agents/changes-diff" });

/** Codex's `TurnDiffTracker` gives each file 100 ms; a file that takes longer gets no diff, not a stall. */
export const DIFF_BUDGET_MS = 100;

const CAT_TIMEOUT_MS = 8_000;
/**
 * Oids per `cat-file --batch` run. The store keeps blobs of at most 2 MB, so a chunk stays near
 * 128 MB at worst, under the buffer below; one chunk that fails loses only its own blobs.
 */
const CAT_CHUNK = 64;

/**
 * Many blobs through a few `git cat-file --batch` runs. An oid the store does not hold is simply
 * absent from the result: the reader shows the file without a diff instead of failing the listing.
 * A blame over hundreds of change logs used to send every oid in one run, and one run past its
 * buffer or timeout returned no blob at all.
 */
export function readBlobs(oids: readonly string[], gitDir = objectsDir()): Map<string, Buffer> {
    const wanted = [...new Set(oids)];
    const found = new Map<string, Buffer>();

    if (wanted.length === 0 || !existsSync(gitDir)) {
        return found;
    }

    for (let start = 0; start < wanted.length; start += CAT_CHUNK) {
        const chunk = wanted.slice(start, start + CAT_CHUNK);
        const run = spawnSync("git", ["--git-dir", gitDir, "cat-file", "--batch"], {
            input: `${chunk.join("\n")}\n`,
            timeout: CAT_TIMEOUT_MS,
            maxBuffer: 256 * 1024 * 1024,
        });

        if (run.status !== 0 || !run.stdout) {
            log.debug({ gitDir, oids: chunk.length, status: run.status, error: run.error }, "blob chunk unreadable");
            continue;
        }

        parseBatch(run.stdout, found);
    }

    return found;
}

/** `git cat-file --batch` output into `found`: `<oid> blob <size>` then the bytes, or `<oid> missing`. */
function parseBatch(out: Buffer, found: Map<string, Buffer>): void {
    let at = 0;

    while (at < out.length) {
        const newline = out.indexOf(0x0a, at);

        if (newline === -1) {
            break;
        }

        const header = out.subarray(at, newline).toString("utf8").split(" ");
        at = newline + 1;

        // `<oid> missing` has no body; `<oid> blob <size>` is followed by the bytes and a newline.
        if (header[1] !== "blob" || header[0] === undefined) {
            continue;
        }

        const size = Number(header[2]);
        found.set(header[0], Buffer.from(out.subarray(at, at + size)));
        at += size + 1;
    }
}

export type FileDiff =
    | { diff: string; added: number; removed: number }
    | { diff: null; reason: "binary" | "budget" | "missing-blob" | "unchanged" };

function isBinary(bytes: Buffer): boolean {
    return bytes.subarray(0, 8192).includes(0);
}

/**
 * One file's unified diff, git-shaped (`--- a/<path>` / `+++ b/<path>`), from its before and
 * after bytes. `null` stands for "no file" (created or deleted); `undefined` for a blob the store
 * never got. A diff that overruns `budgetMs` is dropped with reason `budget`.
 */
export function fileDiff({
    path,
    before,
    after,
    budgetMs = DIFF_BUDGET_MS,
}: {
    path: string;
    before: Buffer | null | undefined;
    after: Buffer | null | undefined;
    budgetMs?: number;
}): FileDiff {
    if (before === undefined || after === undefined) {
        return { diff: null, reason: "missing-blob" };
    }

    if ((before && isBinary(before)) || (after && isBinary(after))) {
        return { diff: null, reason: "binary" };
    }

    const oldText = before?.toString("utf8") ?? "";
    const newText = after?.toString("utf8") ?? "";

    if (oldText === newText && (before === null) === (after === null)) {
        return { diff: null, reason: "unchanged" };
    }

    // An absolute path loses its leading slash, as `git diff --no-index` writes it: `a/tmp/x`, not `a//tmp/x`.
    const label = path.replace(/^\/+/, "");
    const patch = structuredPatch(
        before === null ? "/dev/null" : `a/${label}`,
        after === null ? "/dev/null" : `b/${label}`,
        oldText,
        newText,
        undefined,
        undefined,
        { context: 3, timeout: budgetMs }
    );

    if (!patch) {
        return { diff: null, reason: "budget" };
    }

    let added = 0;
    let removed = 0;

    for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
            if (line.startsWith("+")) {
                added += 1;
            } else if (line.startsWith("-")) {
                removed += 1;
            }
        }
    }

    // jsdiff opens with an `Index:` line and a `===` rule; the git shape starts at `---`.
    const text = formatPatch(patch);
    const start = text.indexOf("--- ");

    return { diff: start === -1 ? text : text.slice(start), added, removed };
}
