import { isAbsolute, relative, sep } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { isObject } from "@genesiscz/utils/object";
import type { CodexSessionStore, PendingApproval, PendingFileChange } from "./store";

/**
 * What the lead reads before it answers a `--write ask` approval. A file-change request carries only an item id;
 * the proposed content arrives earlier, in the `fileChange` item's `changes` (codex-cli 0.166.0:
 * `FileUpdateChange { path, kind, diff }`, where `diff` is the whole file for `add` and `delete` and a unified diff
 * for `update`), or inline in a legacy `applyPatchApproval` (`fileChanges: { [path]: FileChange }`). Before this the
 * daemon kept only the paths, so a lead approved a write it could not read (handoff h_qi7aydaj, 2026-10-30).
 */

/** Content lines one request shows in `tools codex requests` before the truncation marker. */
export const LIST_PREVIEW_LINES = 40;

/** Content lines the lead's `approval_request` bus message carries. */
export const NOTICE_PREVIEW_LINES = 12;

const FILE_CHANGE_METHODS = new Set(["item/fileChange/requestApproval", "applyPatchApproval"]);

export function isFileChangeApproval(method: string): boolean {
    return FILE_CHANGE_METHODS.has(method);
}

/** A path inside the cwd relative to it; any other path stays absolute, so a write outside the workspace reads as one. */
export function approvalDisplayPath(cwd: string, path: string): string {
    if (!isAbsolute(path)) {
        return path;
    }

    const rel = relative(cwd, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return path;
    }

    return rel;
}

/** The changes of an app-server `fileChange` item (`item/started`, `item/fileChange/patchUpdated`). */
export function fileChangesFromItem(changes: unknown, cwd: string): PendingFileChange[] {
    if (!Array.isArray(changes)) {
        return [];
    }

    return changes.flatMap((change): PendingFileChange[] => {
        if (!isObject(change) || typeof change.path !== "string") {
            return [];
        }

        const kind = isObject(change.kind) ? change.kind : {};
        const movePath = typeof kind.move_path === "string" ? approvalDisplayPath(cwd, kind.move_path) : undefined;

        return [
            {
                path: approvalDisplayPath(cwd, change.path),
                kind: typeof kind.type === "string" ? kind.type : "unknown",
                ...(movePath ? { movePath } : {}),
                ...(typeof change.diff === "string" ? { diff: change.diff } : {}),
            },
        ];
    });
}

/** The `fileChanges` map of a legacy `applyPatchApproval` request. */
export function fileChangesFromLegacy(fileChanges: unknown, cwd: string): PendingFileChange[] {
    if (!isObject(fileChanges)) {
        return [];
    }

    return Object.entries(fileChanges).flatMap(([path, change]): PendingFileChange[] => {
        if (!isObject(change) || typeof change.type !== "string") {
            return [];
        }

        const diff = change.type === "update" ? change.unified_diff : change.content;
        const movePath = typeof change.move_path === "string" ? approvalDisplayPath(cwd, change.move_path) : undefined;

        return [
            {
                path: approvalDisplayPath(cwd, path),
                kind: change.type,
                ...(movePath ? { movePath } : {}),
                ...(typeof diff === "string" ? { diff } : {}),
            },
        ];
    });
}

export interface PendingRequest {
    session: string;
    requestId: string;
    approval: PendingApproval;
}

/** The pending requests of one session, or of every session; read from the session files, never from the daemon. */
export function listPendingRequests(store: CodexSessionStore, name?: string): PendingRequest[] {
    const names = name ? [name] : store.listNames();
    const requests: PendingRequest[] = [];

    for (const session of names) {
        const meta = store.readMeta(session);

        if (!meta) {
            if (name) {
                throw new Error(`Codex session not found: ${name}`);
            }

            continue;
        }

        for (const [requestId, approval] of Object.entries(meta.pendingApprovals ?? {})) {
            requests.push({ session, requestId, approval });
        }
    }

    return requests;
}

/**
 * The first `max` content lines of `diff` and how many it has in all, as `diff.split("\n")` without its trailing
 * empty line would give. It walks the newline offsets and copies only the lines it keeps, so a preview of a large
 * generated file costs its few shown lines, not one string per line of the file.
 */
function contentLines(diff: string, max = Number.POSITIVE_INFINITY): { shown: string[]; total: number } {
    const shown: string[] = [];
    let total = 0;
    let start = 0;

    while (start < diff.length) {
        const newline = diff.indexOf("\n", start);
        const end = newline === -1 ? diff.length : newline;

        if (shown.length < max) {
            shown.push(diff.slice(start, end));
        }

        total++;
        start = end + 1;

        if (newline === -1) {
            break;
        }
    }

    return { shown, total };
}

function changeLabel(change: PendingFileChange): string {
    if (change.kind === "add") {
        return "proposed file";
    }

    if (change.kind === "delete") {
        return "file to delete";
    }

    return "unified diff";
}

/** The command that prints one request with every proposed line. */
export function fullRequestCommand(name: string, requestId: string): string {
    return toolCommand("codex request", "--name", name, "--request", requestId, "--full");
}

/**
 * Each file a request writes: a header with its path, then its content lines verbatim. `maxLines` caps the content
 * lines of the whole request; every file cut short ends with an explicit marker naming the hidden line count and the
 * command that prints them. Without `maxLines` nothing is cut.
 */
export function renderFileChanges(options: {
    name: string;
    requestId: string;
    approval: Pick<PendingApproval, "method" | "changes">;
    maxLines?: number;
}): string[] {
    const { name, requestId, approval } = options;

    if (!isFileChangeApproval(approval.method)) {
        return [];
    }

    if (!approval.changes || approval.changes.length === 0) {
        return [
            `(the proposed content is unknown: the daemon saw no file list for this request; read the thread with ${toolCommand("codex read", "--name", name)})`,
        ];
    }

    const lines: string[] = [];
    let budget = options.maxLines ?? Number.POSITIVE_INFINITY;

    for (const change of approval.changes) {
        const moved = change.movePath ? `, moved to ${change.movePath}` : "";

        if (change.diff === undefined) {
            lines.push(`=== ${change.kind} ${change.path}${moved}: Codex sent no content for this file ===`);
            continue;
        }

        const { shown, total } = contentLines(change.diff, Math.max(0, budget));
        lines.push(`=== ${change.kind} ${change.path}${moved}: ${changeLabel(change)}, ${total} lines ===`);
        for (const line of shown) {
            lines.push(line);
        }
        budget -= shown.length;
        const hidden = total - shown.length;

        if (hidden > 0) {
            lines.push(`… ${hidden} more lines, ${fullRequestCommand(name, requestId)}`);
        }
    }

    return lines;
}

/** One pending request for a human: what it asks, what it would write, and how to answer it. */
export function renderPendingApproval(options: {
    name: string;
    requestId: string;
    approval: PendingApproval;
    maxLines?: number;
}): string[] {
    const { name, requestId, approval } = options;
    const lines = [`${name} request ${requestId}: ${approval.method}, asked ${approval.requestedAt}`, approval.detail];

    if (approval.command !== undefined) {
        lines.push(`command: ${approval.command}`);
    }

    if (approval.cwd) {
        lines.push(`cwd: ${approval.cwd}`);
    }

    for (const line of renderFileChanges(options)) {
        lines.push(line);
    }
    lines.push(
        `answer: ${toolCommand("codex approve", "--name", name, "--request", requestId)} or ${toolCommand("codex deny", "--name", name, "--request", requestId)}`
    );

    return lines;
}
