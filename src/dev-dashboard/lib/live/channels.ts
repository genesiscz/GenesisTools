import { isLiveChannel } from "@app/dev-dashboard/lib/live/producers";
import type { LiveChannel } from "@app/dev-dashboard/lib/live/types";

export { isLiveChannel };

/** The channels of `?channels=a,b`: known names only, each once, in the order given. */
export function parseChannels(raw: Iterable<unknown>): LiveChannel[] {
    const out: LiveChannel[] = [];
    const seen = new Set<string>();

    for (const part of raw) {
        if (typeof part !== "string") {
            continue;
        }

        const t = part.trim();
        if (!t || seen.has(t) || !isLiveChannel(t)) {
            continue;
        }

        seen.add(t);
        out.push(t);
    }

    return out;
}

export function parseChannelsQuery(raw: string | null): LiveChannel[] {
    if (!raw?.trim()) {
        return [];
    }

    return parseChannels(raw.split(","));
}
