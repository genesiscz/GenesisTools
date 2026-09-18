import { SafeJSON } from "@genesiscz/utils/json";

export interface PageNode {
    uid: string;
    role: string;
    name: string;
}

const LINE_RE =
    /(?:uid\s*[=:]\s*)?([A-Za-z0-9_-]+)\s+(button|link|textbox|heading|generic|combobox|checkbox|tab|menuitem)\s+"([^"]+)"/i;

export function parsePageSnapshot(text: string): PageNode[] {
    const nodes: PageNode[] = [];
    if (!text.trim()) {
        return nodes;
    }

    if (text.trim().startsWith("[") || text.trim().startsWith("{")) {
        try {
            const parsed = SafeJSON.parse(text) as unknown;
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            for (const row of rows) {
                if (!row || typeof row !== "object") {
                    continue;
                }

                const record = row as { uid?: unknown; role?: unknown; name?: unknown };
                if (typeof record.uid === "string") {
                    nodes.push({
                        uid: record.uid,
                        role: typeof record.role === "string" ? record.role : "generic",
                        name: typeof record.name === "string" ? record.name : "",
                    });
                }
            }
            return nodes;
        } catch {
            // fall through to line parser
        }
    }

    for (const line of text.split(/\r?\n/)) {
        const match = LINE_RE.exec(line);
        if (!match) {
            continue;
        }

        nodes.push({ uid: match[1], role: match[2].toLowerCase(), name: match[3] });
    }
    return nodes;
}
