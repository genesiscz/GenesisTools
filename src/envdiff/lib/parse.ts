export interface EnvEntry {
    key: string;
    value: string;
}

export interface ParsedEnv {
    /** First-seen key order. */
    keys: string[];
    /** Key → value (last duplicate wins). */
    map: Map<string, string>;
    /** Parsed entries in first-seen order. */
    entries: EnvEntry[];
}

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function parseValue(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
        return "";
    }

    const first = trimmed[0];
    if (first === '"' || first === "'") {
        const closing = trimmed.indexOf(first, 1);
        if (closing !== -1) {
            return trimmed.slice(1, closing);
        }

        return trimmed.slice(1);
    }

    const hashIndex = trimmed.indexOf("#");
    if (hashIndex !== -1) {
        return trimmed.slice(0, hashIndex).trim();
    }

    return trimmed;
}

export function parseEnv(content: string): ParsedEnv {
    const keys: string[] = [];
    const map = new Map<string, string>();

    for (const line of content.split(/\r?\n/)) {
        const match = LINE_RE.exec(line);
        if (!match) {
            continue;
        }

        const key = match[1];
        const value = parseValue(match[2] ?? "");
        if (!map.has(key)) {
            keys.push(key);
        }

        map.set(key, value);
    }

    const entries: EnvEntry[] = keys.map((key) => ({ key, value: map.get(key) ?? "" }));
    return { keys, map, entries };
}
