// The hook ledger. Every classic (settings and plugin) hook's answer passes through `classic.*`, so this counts what
// the hooks hand the model: `additionalContext` entries and `block` reasons (a Stop nudge is one), per event, for the
// main loop and for subagents. `mods.hooks.tokens` shows the total as a band chip (`hooks ~38.2k · 41`; tokens are
// characters / 4, an estimate), and a press on it opens the Hooks sidebar: the count per event, the latest injections
// with their text, and the dedupe switch for this session. The status line cannot take a click, so the count left it
// on 2026-10-23. The count is per session and survives a reload of the plugin. `mods.hooks.dedupe` drops a repeat: an
// entry, or an area-rule block inside one, already handed to the same loop since its last compaction becomes a
// one-line receipt. Each injection and each drop goes to `mods-log/hooks.jsonl`.
import type { ElementTable, RenderElement } from "claude-code";
import type { HookCount, HookLedger } from "../types";
import { liveSince } from "./live";
import { agentsDir, type Feature, type Host, isRecord, logMod, settingsOf } from "./shared";
import { barText, dimNote, divider, headerRow, type Kit, listRow, plural, sectionTitle, sidebarFrame } from "./sidebar";

export const HOOKS_PANE = "mods-hooks";

const EMPTY: HookLedger = {
    main: { fires: 0, chars: 0 },
    agents: { fires: 0, chars: 0 },
    byEvent: {},
    dropped: { fires: 0, chars: 0 },
};

/** Counted for this session. Kept in the plugin store under `hook-ledger:<session id>`, so a reload keeps the count. */
let ledger: HookLedger = EMPTY;
let storeKey: string | undefined;

function countOf(value: unknown): HookCount | undefined {
    return isRecord(value) && typeof value.fires === "number" && typeof value.chars === "number"
        ? { fires: value.fires, chars: value.chars }
        : undefined;
}

/** A ledger read back from the store, or undefined when it is not one. */
export function ledgerOf(value: unknown): HookLedger | undefined {
    if (!isRecord(value) || !isRecord(value.byEvent)) {
        return undefined;
    }

    const main = countOf(value.main);
    const agents = countOf(value.agents);
    const dropped = countOf(value.dropped);
    const byEvent = Object.fromEntries(
        Object.entries(value.byEvent).flatMap(([event, count]) => {
            const held = countOf(count);

            return held ? [[event, held]] : [];
        })
    );

    return main && agents && dropped ? { main, agents, dropped, byEvent } : undefined;
}

function save(host: Host): void {
    if (storeKey) {
        void host.storeSet(storeKey, ledger).catch(() => undefined);
    }
}

/** The latest injections, newest last, for the sidebar: the text cut at `ENTRY_TEXT` characters. */
interface Injection {
    at: number;
    event: string;
    agent: string;
    tool?: string;
    chars: number;
    text: string;
    dropped: string[];
}

let recent: Injection[] = [];
const RECENT = 40;
const ENTRY_TEXT = 4_000;
/** The sidebar's dedupe switch for this session; null follows `mods.hooks.dedupe`. */
let dedupeHere: boolean | null = null;
/** The injection the sidebar shows in full, by its `at`. */
let opened: number | undefined;

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
        const dedupe = dedupeHere ?? settings.dedupe;
        const held = seen.get(agent) ?? new Map<string, number>();
        seen.set(agent, held);
        const now = Date.now();
        let droppedChars = 0;
        const dropped: string[] = [];
        const kept = entries.map((entry) => {
            if (!dedupe) {
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
        save(host);
        recent = [
            ...recent,
            {
                at: now,
                event,
                agent,
                tool: typeof input.tool_name === "string" ? input.tool_name : undefined,
                chars,
                text: [...kept, block].filter(Boolean).join("\n\n").slice(0, ENTRY_TEXT),
                dropped,
            },
        ].slice(-RECENT);
        host.redraw();

        return dropped.length ? kept : undefined;
    }
}

export const hookLedger: Feature = {
    async start(host) {
        // Sessions that ran 1.7.0 pinned the count as a status line; the chip replaces it.
        host.status(undefined);
        const key = `hook-ledger:${await host.sessionId()}`;

        if (key !== storeKey) {
            storeKey = key;
            ledger = ledgerOf(await host.storeGet(key).catch(() => undefined)) ?? EMPTY;
            host.redraw();
        }
    },
    compacted(_host, agentId) {
        seen.delete(agentId ?? "main");
    },
    sidebars: [{ id: HOOKS_PANE, title: "Hooks", draw: hooksPane }],
    commands: [
        {
            name: "mod-hooks",
            description: "The Hooks sidebar: what the hooks handed the model, per event, with the latest injections",
            async run(host) {
                await host.togglePane(HOOKS_PANE, "Hooks", "command");

                return {};
            },
        },
    ],
};

/** The band chip's two texts: `hooks ~38.2k · 41`, and what the dedupe dropped. */
function chipTexts(): { total: string; dropped: string } {
    const held = ledger;

    return {
        total: `hooks ${tokensText(held.main.chars + held.agents.chars)} · ${held.main.fires + held.agents.fires}`,
        dropped: held.dropped.fires ? ` −${tokensText(held.dropped.chars)}` : "",
    };
}

/** The columns the band chip's text takes. */
export function hooksChipWidth(): number {
    const { total, dropped } = chipTexts();

    return [...total, ...dropped].length;
}

/** The band chip, `hooks ~38.2k · 41`, or null while `mods.hooks.tokens` is off. */
export async function hooksChip(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    if (!(await settingsOf(host)).hooks.tokens) {
        return null;
    }

    const { Button, Text } = ui;
    const { total, dropped } = chipTexts();

    return (
        <Button key="hooks-chip" plain onPress={() => void host.togglePane(HOOKS_PANE, "Hooks")}>
            <Text dimColor>{total}</Text>
            {dropped ? <Text color="green">{dropped}</Text> : null}
        </Button>
    );
}

function ago(at: number, now: number): string {
    return liveSince(at, now);
}

/** The Hooks sidebar: the totals, the count per event as bars, and the latest injections, each opening its text. */
async function hooksPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    const held = ledger;
    const now = Date.now();
    const settings = (await settingsOf(host)).hooks;
    const dedupe = dedupeHere ?? settings.dedupe;
    const total = held.main.chars + held.agents.chars;
    const events = Object.entries(held.byEvent).sort((a, b) => b[1].chars - a[1].chars);
    const most = events[0]?.[1].chars ?? 1;
    const log = `${(await agentsDir(host)) ?? "~/.genesis-tools/agents"}/mods-log/hooks.jsonl`;
    const shown = recent.find((entry) => entry.at === opened);
    const reset = () => {
        ledger = EMPTY;
        save(host);
        recent = [];
        host.redraw();
    };

    return sidebarFrame(
        kit,
        <Box flexDirection="column">
            {headerRow(
                kit,
                <Text wrap="truncate-end">
                    <Text bold>{`${tokensText(total)} tokens`}</Text>
                    <Text dimColor>{` from hooks · ${plural(held.main.fires + held.agents.fires, "fire")}`}</Text>
                </Text>,
                [
                    {
                        key: "hooks-dedupe",
                        label: `dedupe: ${dedupe ? "on" : "off"}`,
                        onPress: () => {
                            dedupeHere = !dedupe;
                            void logMod(host, "hooks", { event: "dedupe-switch", on: dedupeHere });
                            host.redraw();
                        },
                    },
                    {
                        key: "hooks-log",
                        label: "show log",
                        isDim: true,
                        // Finder straight away: a reveal needs no link router.
                        onPress: () => void host.run(["/usr/bin/open", "-R", log], { timeoutMs: 10_000 }),
                    },
                    { key: "hooks-reset", label: "reset", isDim: true, onPress: reset },
                ]
            )}
            {dimNote(
                kit,
                `main ${tokensText(held.main.chars)} · ${held.main.fires}   agents ${tokensText(held.agents.chars)} · ${held.agents.fires}   deduped ${tokensText(held.dropped.chars)} · ${held.dropped.fires}`
            )}
            {dimNote(kit, "Counted for this session; tokens are characters / 4.")}
            <Box flexDirection="column" marginTop={1}>
                {sectionTitle(kit, "By event")}
                {events.length === 0 ? dimNote(kit, "No hook added context yet.") : null}
                {events.map(([event, count]) => (
                    <Box key={`event-${event}`} flexDirection="row" gap={1}>
                        <Text wrap="truncate-end">{event}</Text>
                        <Box flexGrow={1} />
                        <Text dimColor>{`${count.fires}×`}</Text>
                        <Text color="cyan">{barText(count.chars / most, 10)}</Text>
                        <Text>{tokensText(count.chars).padStart(6)}</Text>
                    </Box>
                ))}
            </Box>
            <Box flexDirection="column" marginTop={1}>
                {sectionTitle(kit, "Latest", "(press one to read it)")}
                {[...recent]
                    .reverse()
                    .slice(0, 15)
                    .map((entry) =>
                        listRow(
                            kit,
                            {
                                key: `entry-${entry.at}`,
                                label: `${entry.at === opened ? "▾" : "▸"} ${entry.event}${entry.tool ? ` ${entry.tool}` : ""}${entry.agent === "main" ? "" : " (agent)"}`,
                                isDim: entry.at !== opened,
                                onPress: () => {
                                    opened = entry.at === opened ? undefined : entry.at;
                                    host.redraw();
                                },
                            },
                            <Text
                                dimColor
                            >{`${entry.dropped.length ? "deduped · " : ""}${tokensText(entry.chars)} · ${ago(entry.at, now)}`}</Text>
                        )
                    )}
            </Box>
            {shown ? (
                <Box flexDirection="column" marginTop={1}>
                    {divider(kit)}
                    <Text dimColor wrap="wrap">
                        {shown.text.split("\n").slice(0, 30).join("\n")}
                    </Text>
                </Box>
            ) : null}
        </Box>
    );
}
