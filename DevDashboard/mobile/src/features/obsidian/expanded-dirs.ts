/**
 * Pure expand-state helpers for the vault tree, mirroring the web route's `@app/utils/obsidian/
 * expanded-dirs` so the mobile tree's expand/collapse and "auto-open the note's ancestor folders"
 * behavior match exactly. Mobile cannot import the `@app/*` util across the Expo bundle boundary
 * cheaply, so the tiny pure functions are re-implemented here and unit-tested for parity.
 *
 * The expanded-dir set is serialized into the expo-router `open` search param (comma-joined) so the
 * open folders survive tab switches and deep links — exact parity with the web `?open=` param.
 */

export function parseOpenDirs(serialized: string | undefined): Set<string> {
    if (!serialized) {
        return new Set();
    }

    return new Set(
        serialized
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
    );
}

export function serializeOpenDirs(dirs: ReadonlySet<string>): string {
    return [...dirs].join(",");
}

export function ancestorDirsOf(notePath: string): string[] {
    const normalized = notePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    parts.pop();

    const dirs: string[] = [];
    let prefix = "";

    for (const part of parts) {
        if (!part) {
            continue;
        }

        prefix = prefix ? `${prefix}/${part}` : part;
        dirs.push(prefix);
    }

    return dirs;
}

export function expandedDirsForNote(notePath: string, current: ReadonlySet<string>): Set<string> {
    const next = new Set(current);

    for (const dir of ancestorDirsOf(notePath)) {
        next.add(dir);
    }

    return next;
}

export function expandedDirsForFolderToggle(
    dir: string,
    expanded: boolean,
    current: ReadonlySet<string>,
): Set<string> {
    const next = new Set(current);

    if (expanded) {
        next.add(dir);
    } else {
        next.delete(dir);
    }

    return next;
}
