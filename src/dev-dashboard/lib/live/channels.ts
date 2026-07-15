import type { LiveChannel } from "@app/dev-dashboard/lib/live/types";

const STATIC = new Set(["ports", "pulse", "qa"]);

export function isLiveChannel(s: string): s is LiveChannel {
    if (STATIC.has(s)) {
        return true;
    }

    if (s.startsWith("boards:") && s.length > "boards:".length) {
        return true;
    }

    if (s.startsWith("daemon:") && s.length > "daemon:".length) {
        return true;
    }

    return false;
}

export function parseChannelsQuery(raw: string | null): LiveChannel[] {
    if (!raw?.trim()) {
        return [];
    }

    const out: LiveChannel[] = [];
    const seen = new Set<string>();

    for (const part of raw.split(",")) {
        const t = part.trim();
        if (!t || seen.has(t) || !isLiveChannel(t)) {
            continue;
        }

        seen.add(t);
        out.push(t);
    }

    return out;
}
