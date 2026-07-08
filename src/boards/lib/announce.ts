import type { WorkItemDto } from "@app/dev-dashboard/contract/dto";

export type SeenMap = Map<number, string>; // id → `${status}:${updatedAt}`

export interface AnnounceResult {
    lines: string[];
    next: SeenMap;
}

const PROMPT_CLIP = 100;

/** Announce items that are NEW or CHANGED since `seen`; items that left the open
 *  queue drop from the map so a later reopen re-announces. Pure — trivially testable. */
export function computeAnnouncements(seen: SeenMap, items: WorkItemDto[]): AnnounceResult {
    const next: SeenMap = new Map();
    const lines: string[] = [];
    for (const it of items) {
        const sig = `${it.status}:${it.updatedAt}`;
        next.set(it.id, sig);
        if (seen.get(it.id) !== sig) {
            const prompt = it.prompt.replace(/\s+/g, " ").trim();
            const clipped = prompt.length > PROMPT_CLIP ? `${prompt.slice(0, PROMPT_CLIP)}…` : prompt;
            lines.push(`№${it.id} [${it.intent}] ${it.board}: ${clipped}`);
        }
    }
    return { lines, next };
}
