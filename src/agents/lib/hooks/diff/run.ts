import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DiffConfig, HooksConfig } from "../config";
import { gitOut } from "../git";
import { hookDiag } from "../log";
import { callDir, safeSegment } from "../paths";
import type { HookPayload } from "../payload";
import { beforeCopy } from "./before";
import { type ChangedFile, changedFiles } from "./collect";
import { highlightRange, hunkRange, renderBlock, renderPatch } from "./render";

export interface DiffDecision {
    decision: "emitted" | "silent" | "skip";
    reason: string;
    message?: string;
    files: string[];
}

/**
 * Three sources for the before-state, in falling order of precision:
 * the captured copy, `/dev/null` for a file that did not exist, and `HEAD` for a file
 * that was clean when the command began. Passing a path that does not exist to
 * `--no-index` yields exit 128 and an empty patch, which reads exactly like "no change".
 */
function patchFor(file: ChangedFile, before: string | null, config: DiffConfig): string {
    const context = `-U${config.contextLines}`;

    if (before) {
        return gitOut(file.root, ["diff", "--no-index", context, "--", before, file.path]);
    }

    if (file.untracked) {
        return gitOut(file.root, ["diff", "--no-index", context, "--", "/dev/null", file.path]);
    }

    return gitOut(file.root, ["diff", "HEAD", context, "--", file.path]);
}

/** The paths the pre phase saw as already deleted in root `index`, written NUL-separated. */
function deletedAtCapture(dir: string, index: number): Set<string> {
    const path = join(dir, `${index + 1}.deleted`);

    if (!existsSync(path)) {
        return new Set();
    }

    return new Set(
        readFileSync(path, "utf8")
            .split("\0")
            .filter((name) => name.length > 0)
    );
}

export function runDiffPost(payload: HookPayload, config: HooksConfig): DiffDecision {
    if (!config.diff.enabled) {
        return { decision: "skip", reason: "diff disabled in config", files: [] };
    }

    const session = safeSegment(payload.sessionId);
    const call = safeSegment(payload.toolUseId);

    if (session === null || call === null) {
        // The post phase ends in a recursive delete of this directory, so an id that cannot
        // be a path segment must never reach `callDir`.
        return { decision: "skip", reason: "payload carries no usable session or tool call id", files: [] };
    }

    const dir = callDir(payload.harness, session, call);
    const rootsFile = join(dir, "roots.txt");

    if (!existsSync(rootsFile)) {
        return { decision: "skip", reason: "no capture from the pre phase", files: [] };
    }

    const roots = readFileSync(rootsFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
    const stampPath = join(dir, "stamp");
    const since = existsSync(stampPath) ? Number(readFileSync(stampPath, "utf8").trim()) * 1000 : Date.now() - 20_000;
    // The stand-down is per FILE. The harness emits a payload on every call once the
    // feature is on, and it is empty whenever the change landed outside the cwd repo,
    // so treating its mere presence as "already rendered" silences this exactly where
    // it is needed.
    const native = new Set(config.diff.standDownWhenNative ? payload.nativeDiffFiles : []);
    const blocks: string[] = [];
    const files: string[] = [];
    let covered = 0;

    for (const [index, root] of roots.entries()) {
        // The cap short-circuits the ROOT loop too. Breaking only the inner loop still called
        // `changedFiles` for every remaining root, and that is a `git status` plus an
        // `ls-files` per root, on the hot path, for output already capped away.
        if (blocks.length >= config.diff.maxFiles) {
            break;
        }

        const deletedBefore = deletedAtCapture(dir, index);

        for (const file of changedFiles(root, since, config.diff)) {
            if (blocks.length >= config.diff.maxFiles) {
                break;
            }

            // mtime cannot date a deletion, so `changedFiles` admits every one; a deletion that
            // was already there when the command began is not this command's doing.
            if (file.deleted && deletedBefore.has(file.path)) {
                continue;
            }

            if (native.has(file.path)) {
                covered += 1;
                continue;
            }

            const before = file.deleted ? null : beforeCopy(dir, root, file.path);
            const patch = patchFor(file, before, config.diff);
            // Highlight only the lines the hunks touch, never the whole file.
            const highlighted = file.deleted ? [] : highlightRange(file.path, hunkRange(patch), config.diff);
            const rendered = renderPatch(patch, highlighted, config.diff);

            if (rendered.body.length === 0 && !file.deleted) {
                continue;
            }

            files.push(file.path);
            blocks.push(renderBlock(file, rendered, before !== null, config.diff));
        }
    }

    try {
        rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        hookDiag("Could not remove the capture directory", { err, dir });
    }

    if (blocks.length === 0) {
        return {
            decision: "silent",
            reason:
                covered > 0 ? "every changed file was already rendered natively" : "no change since this command began",
            files: [],
        };
    }

    return { decision: "emitted", reason: "rendered a diff the harness did not", message: blocks.join("\n\n"), files };
}
