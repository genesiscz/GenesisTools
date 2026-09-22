import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DiffConfig, diffFor, type HooksConfig } from "../config";
import { committedPaths, gitOut, objectId, statusOf } from "../git";
import { hookDiag } from "../log";
import { callDir, safeSegment } from "../paths";
import type { HookPayload } from "../payload";
import { alreadyGone, beforeCopy, leftOutOfCapture } from "./before";
import { claimChange } from "./claim";
import { classifyChange, type DiffCategory } from "./classify";
import { type ChangedFile, changedFiles } from "./collect";
import { namedChanges } from "./named";
import { assembleMessage, type DiffBlock, highlightRange, hunkRange, renderBlock, renderPatch } from "./render";

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
function patchFor(file: ChangedFile, before: string | null, config: DiffConfig, base: string): string {
    const context = `-U${config.contextLines}`;

    if (before) {
        return gitOut(file.root, ["diff", "--no-index", context, "--", before, file.path]);
    }

    if (file.untracked) {
        return gitOut(file.root, ["diff", "--no-index", context, "--", "/dev/null", file.path]);
    }

    // `base` is the HEAD the command STARTED on, not today's HEAD. The two differ exactly
    // when the command committed, and diffing a just-committed file against the commit that
    // created it reports nothing at all.
    return gitOut(file.root, ["diff", base, context, "--", file.path]);
}

/**
 * The rendered block for one changed file, or `null` when the diff turned out empty. A
 * DELETED file always renders: its block is the header alone when git has no patch for it.
 */
function blockFrom(
    file: ChangedFile,
    patch: string,
    hadBefore: boolean,
    config: DiffConfig,
    suppressed: Map<DiffCategory, number>
): DiffBlock | null {
    // The KIND is decided before any rendering work, so a category that is switched off
    // costs one classification rather than a `bat` spawn and a full render.
    const category = classifyChange(file.path, patch);

    if (!config.categories[category]) {
        suppressed.set(category, (suppressed.get(category) ?? 0) + 1);
        return null;
    }

    const rendered = renderPatch(patch);

    if (rendered.body.length === 0 && !file.deleted) {
        return null;
    }

    const block = renderBlock(file, rendered, hadBefore, category);

    // Highlight only the lines the hunks touch, never the whole file, and only once the
    // budget has decided a context line will really be printed. A deleted file has nothing
    // left on disk to highlight.
    if (!file.deleted) {
        block.colour = () => highlightRange(file.path, hunkRange(patch), config, patch);
    }

    return block;
}

/**
 * Takes the one render of this file state, so two sessions sharing a repository do not both
 * print the same change. A deleted file has no stat to key on and uses a fixed sentinel.
 */
function claim(path: string, deleted: boolean, config: DiffConfig, session: string | undefined): boolean {
    if (!config.dedupeAcrossSessions) {
        return true;
    }

    let mtimeMs = 0;
    let size = -1;

    if (!deleted) {
        try {
            const stat = statSync(path);

            mtimeMs = stat.mtimeMs;
            size = stat.size;
        } catch (err) {
            // It vanished between the render and here. Claiming a state we cannot read would
            // key on the sentinel and could silence a real deletion later.
            hookDiag("Could not stat a rendered file to claim it", { err, path });
            return true;
        }
    }

    return claimChange({ path, mtimeMs, size }, session);
}

/** Why nothing was printed. Each case needs a different fix, so they read differently. */
function silentReason(
    covered: number,
    uncaptured: number,
    claimed: number,
    stale: number,
    suppressed: Map<DiffCategory, number>
): string {
    if (suppressed.size > 0) {
        const kinds = [...suppressed].map(([kind, count]) => `${count} ${kind}`).join(", ");

        return `every changed file was a kind this config hides: ${kinds}`;
    }

    if (covered > 0) {
        return "every changed file was already rendered natively";
    }

    if (claimed > 0) {
        // Not "by another session" any more: a session also dedupes against itself.
        return `${claimed} changed file(s) had already been rendered`;
    }

    if (uncaptured > 0) {
        return `${uncaptured} changed file(s) had no captured before-state, over the capture cap`;
    }

    if (stale > 0) {
        return `${stale} deletion(s) had already happened before this command began`;
    }

    return "no change since this command began";
}

export function runDiffPost(payload: HookPayload, config: HooksConfig): DiffDecision {
    const diff = diffFor(config, payload.harness);

    if (!diff.enabled) {
        return { decision: "skip", reason: `diff disabled in config for ${payload.harness}`, files: [] };
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
    const headsPath = join(dir, "heads.txt");
    const heads = existsSync(headsPath) ? readFileSync(headsPath, "utf8").split("\n") : [];
    const stampPath = join(dir, "stamp");
    const since = existsSync(stampPath) ? Number(readFileSync(stampPath, "utf8").trim()) * 1000 : Date.now() - 20_000;
    // The stand-down is per FILE. The harness emits a payload on every call once the
    // feature is on, and it is empty whenever the change landed outside the cwd repo,
    // so treating its mere presence as "already rendered" silences this exactly where
    // it is needed.
    const native = new Set(diff.standDownWhenNative ? payload.nativeDiffFiles : []);
    const blocks: DiffBlock[] = [];
    const files: string[] = [];
    let covered = 0;
    let uncaptured = 0;
    let claimed = 0;
    let stale = 0;
    const suppressed = new Map<DiffCategory, number>();

    roots.forEach((root, index) => {
        // The cap short-circuits the ROOT loop too. Breaking only the inner loop still called
        // `changedFiles` for every remaining root, and that is a `git status` plus an
        // `ls-files` per root, on the hot path, for output already capped away.
        if (blocks.length >= diff.maxFiles) {
            return;
        }

        // ONE status read per root, reused for the entries AND the current HEAD: porcelain
        // v2's `--branch` header already carries the oid, so noticing a commit costs nothing
        // until one has actually happened.
        const summary = statusOf(root);
        const startedOn = objectId(heads[index]?.trim());
        const nowOn = objectId(summary.branch?.oid);
        const moved = startedOn !== null && nowOn !== null && startedOn !== nowOn;
        const base = moved && startedOn ? startedOn : "HEAD";
        const committed = moved && startedOn && nowOn ? committedPaths(root, startedOn, nowOn) : [];

        for (const file of changedFiles(root, since, diff, { entries: summary.entries, committed })) {
            if (blocks.length >= diff.maxFiles) {
                break;
            }

            if (native.has(file.path)) {
                covered += 1;
                continue;
            }

            if (file.deleted && alreadyGone(dir, root, file.path)) {
                // It was already deleted when this command began, so this command did not
                // delete it. A deletion carries no mtime and therefore bypasses the `since`
                // filter every edit passes, which made `git status` reprint it on every
                // later command until someone committed it.
                stale += 1;
                continue;
            }

            const before = file.deleted ? null : beforeCopy(dir, root, file.path);

            if (before === null && file.untracked && !file.deleted && leftOutOfCapture(dir, root, file.path)) {
                // It was already on disk when the command began, and its before-state did not
                // fit the capture budget. Diffing it against `/dev/null` would claim the
                // command wrote every line of it, so the honest answer is to say nothing.
                uncaptured += 1;
                continue;
            }

            const block = blockFrom(file, patchFor(file, before, diff, base), before !== null, diff, suppressed);

            if (block === null) {
                continue;
            }

            if (!claim(file.path, file.deleted, diff, payload.sessionId)) {
                claimed += 1;
                continue;
            }

            files.push(file.path);
            blocks.push(block);
        }
    });

    // Files the command NAMED rather than worked in. They are read from a copy, so this adds
    // no git process unless one of them actually changed.
    for (const change of namedChanges(dir)) {
        if (blocks.length >= diff.maxFiles) {
            break;
        }

        if (native.has(change.path)) {
            covered += 1;
            continue;
        }

        if (files.includes(change.path)) {
            // Already rendered above: a named path can also sit inside a captured root.
            continue;
        }

        if (change.before === null && !change.deleted && !diff.namedPathsShowCreated) {
            // A file this command created, known only because the command named it. That is
            // a scratch file far more often than not, and the command's own output already
            // says what it wrote. An edit to a file that ALREADY existed still renders.
            continue;
        }

        const file: ChangedFile = {
            path: change.path,
            root: dirname(change.path),
            // "Added" is right only when there was genuinely no before-state.
            untracked: change.before === null,
            deleted: change.deleted,
        };
        // Always `--no-index`, in both directions: a named path may live outside every
        // repository, so `git diff HEAD` is not available to it. A deletion is the copy
        // against `/dev/null`, which is what gives the removed lines.
        const patch = gitOut(file.root, [
            "diff",
            "--no-index",
            `-U${diff.contextLines}`,
            "--",
            change.before ?? "/dev/null",
            change.deleted ? "/dev/null" : change.path,
        ]);
        const block = blockFrom(file, patch, change.before !== null, diff, suppressed);

        if (block === null) {
            continue;
        }

        if (!claim(change.path, change.deleted, diff, payload.sessionId)) {
            claimed += 1;
            continue;
        }

        files.push(change.path);
        blocks.push(block);
    }

    try {
        rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        hookDiag("Could not remove the capture directory", { err, dir });
    }

    if (blocks.length === 0) {
        return { decision: "silent", reason: silentReason(covered, uncaptured, claimed, stale, suppressed), files: [] };
    }

    return {
        decision: "emitted",
        reason: "rendered a diff the harness did not",
        message: assembleMessage(blocks, diff),
        files,
    };
}
