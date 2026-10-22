// The hook ledger. Every classic (settings and plugin) hook's answer passes through `classic.*`, so this counts what
// the hooks hand the model: `additionalContext` entries and `block` reasons (a Stop nudge is one), per event, for
// the main loop and for subagents. `mods.hooks.tokens` pins the total as this plugin's status line
// (`hooks ~38.2k tok · 41 fires`; tokens are characters / 4, an estimate). `mods.hooks.dedupe` drops a repeat:
// an entry, or an area-rule block inside one, already handed to the same loop since its last compaction becomes a
// one-line receipt. Each injection and each drop goes to `mods-log/hooks.jsonl`.
import type { HookCount, HookLedger } from "../types";
import { type Feature, type Host, isRecord, logMod, settingsOf } from "./shared";

/** Counted since this module loaded: a hot reload of the plugin starts the count again. */
let ledger: HookLedger = {
    main: { fires: 0, chars: 0 },
    agents: { fires: 0, chars: 0 },
    byEvent: {},
    dropped: { fires: 0, chars: 0 },
};

/** Shorter entries are never dropped: a receipt would save nothing. */
const MIN_DEDUPE_CHARS = 200;
const AREA_BLOCK = /(?=Contents of \S+ \(area rules\):)/;

/** What each loop has been handed since its last compaction: a key per whole entry and per area-rule block. */
const seen = new Map<string, Map<string, number>>();

function keyOf(text: string): string {
    let hash = 5381;

    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }

    return `${text.length}:${hash >>> 0}`;
}

export function tokensText(chars: number): string {
    const tokens = chars / 4;

    return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${Math.round(tokens)}`;
}

function receipt(what: string, chars: number, at: number): string {
    return `[genesis-tools-mods: ${what} repeated, ${chars} characters already in this context since ${new Date(at).toLocaleTimeString()}; dropped]`;
}

/**
 * One entry with its repeats taken out: a whole repeat becomes a receipt; an entry of area-rule blocks keeps its
 * new blocks and names the dropped ones. `held` remembers what the loop has now.
 */
export function dedupeEntry(
    text: string,
    held: Map<string, number>,
    now: number
): { text: string; droppedChars: number; dropped: string[] } {
    const whole = keyOf(text);
    const before = held.get(whole);

    if (before !== undefined && text.length >= MIN_DEDUPE_CHARS) {
        const head = text.split("\n")[0]?.slice(0, 80) ?? "hook context";
        const note = receipt(`"${head}"`, text.length, before);

        return { text: note, droppedChars: text.length - note.length, dropped: [head] };
    }

    held.set(whole, now);
    const [preface = "", ...blocks] = text.split(AREA_BLOCK);

    if (blocks.length === 0) {
        return { text, droppedChars: 0, dropped: [] };
    }

    const kept: string[] = [];
    const dropped: string[] = [];
    let droppedChars = 0;

    for (const block of blocks) {
        const key = keyOf(block.trim());
        const at = held.get(key);
        const path = /^Contents of (\S+)/.exec(block)?.[1] ?? "area rules";

        if (at === undefined) {
            held.set(key, now);
            kept.push(block);
            continue;
        }

        const note = receipt(`area rules ${path}`, block.length, at);
        dropped.push(path);
        droppedChars += block.length - note.length;
        kept.push(`${note}\n\n`);
    }

    return { text: dropped.length ? `${preface}${kept.join("")}`.trimEnd() : text, droppedChars, dropped };
}

function add(count: HookCount, chars: number): HookCount {
    return { fires: count.fires + 1, chars: count.chars + chars };
}

async function showStatus(host: Host): Promise<void> {
    if (!(await settingsOf(host)).hooks.tokens) {
        host.status(undefined);
        return;
    }

    const held = ledger;
    const parts = [`hooks ${tokensText(held.main.chars)} tok · ${held.main.fires} fires`];

    if (held.agents.fires > 0) {
        parts.push(`agents ${tokensText(held.agents.chars)}`);
    }

    if (held.dropped.fires > 0) {
        parts.push(`deduped ${tokensText(held.dropped.chars)}`);
    }

    host.status(parts.join(" · "));
}

/**
 * Counts what one classic hook event handed the model and takes out the repeats. Answers the `additionalContext` to
 * pass on in place of the hooks' own, or undefined to pass their answer on unchanged.
 */
export async function ledgerClassic(host: Host, input: unknown, answer: unknown): Promise<string[] | undefined> {
    {
        if (!isRecord(input) || !isRecord(answer)) {
            return undefined;
        }

        const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "?";
        const agent = typeof input.agent_id === "string" ? input.agent_id : "main";

        if (event === "SessionStart" && (input.source === "compact" || input.source === "clear")) {
            seen.delete(agent);
        }

        const entries = Array.isArray(answer.additionalContext)
            ? answer.additionalContext.filter((entry): entry is string => typeof entry === "string")
            : [];
        const block = typeof answer.block === "string" ? answer.block : "";

        if (entries.length === 0 && !block) {
            return undefined;
        }

        const settings = (await settingsOf(host)).hooks;
        const held = seen.get(agent) ?? new Map<string, number>();
        seen.set(agent, held);
        const now = Date.now();
        let droppedChars = 0;
        const dropped: string[] = [];
        const kept = entries.map((entry) => {
            if (!settings.dedupe) {
                return entry;
            }

            const out = dedupeEntry(entry, held, now);
            droppedChars += out.droppedChars;
            dropped.push(...out.dropped);

            return out.text;
        });
        const chars = kept.reduce((sum, entry) => sum + entry.length, 0) + block.length;

        const before = ledger;
        ledger = {
            main: agent === "main" ? add(before.main, chars) : before.main,
            agents: agent === "main" ? before.agents : add(before.agents, chars),
            byEvent: { ...before.byEvent, [event]: add(before.byEvent[event] ?? { fires: 0, chars: 0 }, chars) },
            dropped: dropped.length ? add(before.dropped, droppedChars) : before.dropped,
        };
        await logMod(host, "hooks", {
            event,
            agent,
            tool: typeof input.tool_name === "string" ? input.tool_name : undefined,
            chars,
            heads: kept.map((entry) => entry.split("\n")[0]?.slice(0, 100)),
            block: block ? block.slice(0, 100) : undefined,
            dropped: dropped.length ? dropped : undefined,
            droppedChars: droppedChars || undefined,
        });
        await showStatus(host);

        return dropped.length ? kept : undefined;
    }
}

export const hookLedger: Feature = {
    async start(host) {
        await showStatus(host);
    },
    compacted(agentId) {
        seen.delete(agentId ?? "main");
    },
};
