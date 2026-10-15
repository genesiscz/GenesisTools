import { existsSync, lstatSync } from "node:fs";
import { run } from "./run";

export type TrashResult = { ok: true; trashPath: string | null } | { ok: false; error: string };

/**
 * A symbolic link, or a missing path, is refused before the Trash sees it: the review shows a target, and a link is
 * not the space the user chose to free.
 */
function refuseUnsafe(path: string): string | null {
    try {
        return lstatSync(path).isSymbolicLink()
            ? `${path} is a symbolic link: the Trash would take its target, so it is refused`
            : null;
    } catch {
        return `${path} does not exist`;
    }
}

/** The system's own Trash command (macOS 15 and later): NSFileManager's trashItem, so no Finder, no Automation grant. */
export const TRASH_COMMAND = "/usr/bin/trash";

/**
 * Move items to the Trash with one `/usr/bin/trash -v` call and say where each landed, so the result can name it for
 * Put Back. `-v` prints `# Moved "<source>" to "<destination>"` for each item AS IT GOES, and each failure on its own,
 * so one failure does not hide the others. A timeout or a crash part-way loses nothing: an item with no line is
 * settled by whether its source is still there (gone means it moved, with the destination unknown). The items stay on
 * the same volume: this frees nothing until the Trash is emptied.
 */
export async function moveManyToTrash(
    paths: string[],
    options: { command?: string; timeoutMs?: number } = {}
): Promise<TrashResult[]> {
    const results: Array<TrashResult | null> = paths.map((path) => {
        const refused = refuseUnsafe(path);
        return refused ? { ok: false, error: refused } : null;
    });
    const todo = paths.filter((_, index) => results[index] === null);

    if (todo.length === 0) {
        return results.map((done) => done ?? { ok: false, error: "not tried" });
    }

    const command = options.command ?? TRASH_COMMAND;

    if (!existsSync(command)) {
        return results.map(
            (done) => done ?? { ok: false, error: `${command} is missing: moving to the Trash needs macOS 15 or later` }
        );
    }

    const res = await run(command, ["-v", "--", ...todo], {
        timeoutMs: options.timeoutMs ?? 30_000 + 2_000 * todo.length,
    });
    const output = `${res.stdout}\n${res.stderr}`;

    return results.map((done, index) => {
        if (done) {
            return done;
        }

        const path = paths[index];
        const moved = movedLine(output, path);

        if (moved !== undefined) {
            return { ok: true, trashPath: moved };
        }

        if (!existsSync(path)) {
            return { ok: true, trashPath: null };
        }

        const why = errorLine(output, path) ?? (res.timedOut ? "timed out before this item" : `exit ${res.status}`);
        return { ok: false, error: why };
    });
}

/** The destination `trash -v` printed for `path`, or undefined when it printed none. */
function movedLine(output: string, path: string): string | undefined {
    const prefix = `# Moved "${path}" to "`;
    const line = output.split("\n").find((candidate) => candidate.startsWith(prefix) && candidate.endsWith('"'));
    return line?.slice(prefix.length, -1);
}

/** The reason `trash` gave for `path`, trimmed to its message, or undefined. */
function errorLine(output: string, path: string): string | undefined {
    const line = output.split("\n").find((candidate) => candidate.includes(`Error attempting to move ${path} `));
    const message = line?.match(/"([^"]+)"/)?.[1];
    return line ? (message ?? line.trim()) : undefined;
}

/** One item; see {@link moveManyToTrash}. */
export async function moveToTrash(path: string): Promise<TrashResult> {
    const [result] = await moveManyToTrash([path]);
    return result ?? { ok: false, error: "no result" };
}
