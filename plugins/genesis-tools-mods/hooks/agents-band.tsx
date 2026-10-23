// The live agents band: the working subagents with their model, what they are for, how long they have run, how long
// since their last tool call, and how many tool calls they made. The engine's agents panel shows none of the first
// three, and a subagent past `mods.agentsBand.warnMinutes` turns red. Up to three agents show as rows; more fold
// into one `▸ 8 agents` line that a press opens. A press on an agent opens the Agents sidebar on it: its recent tool
// calls, what it said last, and actions (message it, ask about it, stop it, copy its id or transcript path).
//
// The model and start come from `agent.spawn`'s answer; for an agent spawned before this module loaded (a reload, or
// a resumed session) from the `agent-<id>.meta.json` Claude Code writes beside its transcript. Activity comes from
// the subagent's own `tool.call`s.
import type { AgentInfo, AgentSpawnInput, AgentSpawnResult, ElementTable, RenderElement } from "claude-code";
import type { SpawnedAgents } from "../types";
import { modelLabel } from "./agent-model";
import { liveAgo, liveSince } from "./live";
import { type Feature, type Host, isRecord, settingsOf } from "./shared";
import {
    actionRow,
    dimNote,
    divider,
    headerRow,
    type Kit,
    listRow,
    plural,
    sectionTitle,
    sidebarFrame,
} from "./sidebar";
import { toolLabel } from "./spinner";

export const AGENTS_PANE = "mods-agents";

let spawned: SpawnedAgents = {};
const activity = new Map<string, { lastAt: number; lastTool: string; tools: number; recent: Recent[] }>();
/** What `agent-<id>.meta.json` said; null once read and found without a model. */
const metas = new Map<string, { model: string; at?: number } | null>();
/** The end of each agent's transcript: its last words, read at most every 5 s. */
const tails = new Map<string, { at: number; said: string }>();
const BUSY = new Set(["pending", "running", "waiting"]);
const MAX_ROWS = 6;
const FOLD_OVER = 3;
/** The session's transcript folder, `<projects>/<encoded cwd>/<session id>`, from a classic hook's `transcript_path`. */
let sessionDir: string | undefined;
/** The person's fold of the band; null folds it past `FOLD_OVER` agents. */
let expanded: boolean | null = null;
let selected: string | undefined;

interface Recent {
    label: string;
    at: number;
}

async function beat(host: Host): Promise<void> {
    if (!(await settingsOf(host)).agentsBand.enabled) {
        return;
    }

    const list = await host.agents().catch(() => []);

    if (list.some((agent) => BUSY.has(agent.status))) {
        host.redraw();
    }
}

export const agentsBand: Feature = {
    async start(host) {
        host.every(10_000, () => {
            void beat(host);
        });
    },
    beforeTool(_host, e) {
        if (e.agentId !== undefined) {
            const before = activity.get(e.agentId);
            const now = Date.now();
            activity.set(e.agentId, {
                lastAt: now,
                lastTool: e.tool,
                tools: (before?.tools ?? 0) + 1,
                recent: [...(before?.recent ?? []), { label: toolLabel(e.tool, e), at: now }].slice(-12),
            });
        }

        return undefined;
    },
    sidebars: [{ id: AGENTS_PANE, title: "Agents", draw: agentsPane }],
    commands: [
        {
            name: "mod-agents",
            description: "The Agents sidebar: every subagent with its model, recent tools, last words and actions",
            async run(host) {
                await host.togglePane(AGENTS_PANE, "Agents", "command");

                return {};
            },
        },
    ],
};

/** Keeps the model and start of a spawned subagent, as `agent.spawn` answered. */
export function recordSpawn(host: Host, e: AgentSpawnInput, result: AgentSpawnResult): void {
    const agentId = result.agentId;

    if (!agentId) {
        return;
    }

    const model = result.model || e.model || e.parentModel;
    spawned = { ...spawned, [agentId]: { model, description: bareDescription(e.description), at: Date.now() } };
    host.redraw();
}

/** A description without the model the agent-model mod put in front (`(H) `, `haiku-5-5 · `): the row prints it once. */
export function bareDescription(description: string): string {
    return description.replace(/^\([A-Z]\) /, "").replace(/^[a-z]+(?:-[\w.]+)* · /, "");
}

/** Remembers where the session's transcripts are, from any classic hook input. */
export function noteTranscript(input: unknown): void {
    if (isRecord(input) && typeof input.transcript_path === "string" && !input.agent_id) {
        sessionDir = input.transcript_path.replace(/\.jsonl$/, "");
    }
}

async function sessionDirOf(host: Host): Promise<string | undefined> {
    if (sessionDir) {
        return sessionDir;
    }

    const home = await host.env("HOME");

    if (!home) {
        return undefined;
    }

    const cwd = await host.cwd();

    return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${await host.sessionId()}`;
}

async function transcriptOf(host: Host, agentId: string): Promise<string | undefined> {
    const dir = await sessionDirOf(host);

    return dir ? `${dir}/subagents/agent-${agentId}.jsonl` : undefined;
}

/** Reads an agent's meta file once, in the background; the band draws again when it knows more. */
function loadMeta(host: Host, agentId: string): void {
    if (metas.has(agentId)) {
        return;
    }

    metas.set(agentId, null);
    void (async () => {
        const transcript = await transcriptOf(host, agentId);

        if (!transcript) {
            return;
        }

        const path = transcript.replace(/\.jsonl$/, ".meta.json");
        const text = await host.read(path).catch(() => "");
        const parsed: unknown = text ? JSON.parse(text) : undefined;

        if (isRecord(parsed) && typeof parsed.model === "string") {
            const stat = await host.stat(path).catch(() => undefined);
            metas.set(agentId, { model: parsed.model, at: stat?.mtimeMs });
            host.redraw();
        }
    })().catch(() => undefined);
}

/** The text of the last assistant message in a transcript's end, or "" without one. */
export function lastSaidOf(tail: string): string {
    const lines = tail.split("\n").reverse();

    for (const line of lines) {
        if (!line.includes('"assistant"')) {
            continue;
        }

        try {
            const row: unknown = JSON.parse(line);
            const message = isRecord(row) && isRecord(row.message) ? row.message : undefined;
            const content = message && Array.isArray(message.content) ? message.content : [];
            const text = content
                .flatMap((part) =>
                    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
                )
                .join("\n")
                .trim();

            if (text) {
                return text;
            }
        } catch {
            // The first line of a byte-cut tail is half a row.
        }
    }

    return "";
}

function loadTail(host: Host, agentId: string): void {
    const held = tails.get(agentId);

    if (held && Date.now() - held.at < 5_000) {
        return;
    }

    tails.set(agentId, { at: Date.now(), said: held?.said ?? "" });
    void (async () => {
        const path = await transcriptOf(host, agentId);
        const done = path ? await host.run(["tail", "-c", "131072", path], { timeoutMs: 5_000 }) : undefined;
        const said = done?.exitCode === 0 ? lastSaidOf(done.stdout) : "";

        if (said !== held?.said) {
            tails.set(agentId, { at: Date.now(), said });
            host.redraw();
        }
    })().catch(() => undefined);
}

interface AgentFacts {
    agent: AgentInfo;
    model: string | undefined;
    description: string;
    age: number | undefined;
    /** When it started, for its live run time. */
    startedAt: number | undefined;
    late: boolean;
    seen: ReturnType<typeof activity.get>;
}

async function factsOf(host: Host, list: readonly AgentInfo[]): Promise<AgentFacts[]> {
    const all = await settingsOf(host);
    const now = Date.now();

    return list.map((agent) => {
        const known = spawned[agent.id];

        if (!known) {
            loadMeta(host, agent.id);
        }

        const meta = metas.get(agent.id);
        const model = known?.model ?? meta?.model;
        const at = known?.at ?? meta?.at;
        const age = at === undefined ? undefined : now - at;

        return {
            agent,
            model: model ? modelLabel(model, all.agentModel.format) : undefined,
            description: known?.description ?? bareDescription(agent.description),
            age,
            startedAt: at,
            late: BUSY.has(agent.status) && age !== undefined && age > all.agentsBand.warnMinutes * 60_000,
            seen: activity.get(agent.id),
        };
    });
}

function nameOf(facts: AgentFacts): string {
    return `${facts.model ? `(${facts.model}) ` : ""}${facts.description}`;
}

function tailOf(facts: AgentFacts, now: number): string {
    const parts = [facts.startedAt === undefined ? "" : liveSince(facts.startedAt, now)];

    if (facts.seen) {
        parts.push(`idle ${liveSince(facts.seen.lastAt, now)}`, plural(facts.seen.tools, "tool"));
    }

    return parts.filter(Boolean).join(" · ");
}

function cut(text: string, width: number): string {
    return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

function openOn(host: Host, agentId: string | undefined): void {
    selected = agentId;
    void host.openPane(AGENTS_PANE, "Agents");
}

/** The band's agents rows, or null when no subagent works. */
export async function agentsRow(host: Host, ui: ElementTable, columns: number): Promise<RenderElement | null> {
    const settings = (await settingsOf(host)).agentsBand;

    if (!settings.enabled) {
        return null;
    }

    const list = (await host.agents().catch(() => [])).filter((agent) => BUSY.has(agent.status) && !agent.teammateId);

    if (list.length === 0) {
        return null;
    }

    const { Box, Button, Text } = ui;
    const now = Date.now();
    const all = await factsOf(host, list);
    const isOpen = expanded ?? list.length <= FOLD_OVER;
    const late = all.filter((facts) => facts.late).length;
    const toggle = () => {
        expanded = !isOpen;
        host.redraw();
    };
    const row = (facts: AgentFacts) => {
        const tail = tailOf(facts, now);
        const label = cut(`${facts.late ? "⚠" : "●"} ${nameOf(facts)}`, Math.max(20, columns - tail.length - 3));

        return (
            <Box key={`agent-${facts.agent.id}`} flexDirection="row">
                <Button key={`agent-${facts.agent.id}`} plain onPress={() => openOn(host, facts.agent.id)}>
                    {facts.late ? <Text color="red">{label}</Text> : <Text dimColor>{label}</Text>}
                </Button>
                <Box flexGrow={1} />
                <Text dimColor>{tail}</Text>
            </Box>
        );
    };
    const header =
        list.length > FOLD_OVER || expanded === true ? (
            <Box key="agents-head" flexDirection="row" gap={1}>
                <Button key="agents-toggle" plain onPress={toggle}>
                    <Text bold>{`${isOpen ? "▾" : "▸"} ${list.length} agents`}</Text>
                </Button>
                {late ? <Text color="red">{`${late} past ${settings.warnMinutes}m`}</Text> : null}
                {isOpen ? null : (
                    <Text dimColor wrap="truncate-end">
                        {all.map(nameOf).join(" · ")}
                    </Text>
                )}
                <Box flexGrow={1} />
                <Button key="agents-open" plain dimColor onPress={() => openOn(host, selected)}>
                    details
                </Button>
            </Box>
        ) : null;
    const shown = isOpen ? all.slice(0, MAX_ROWS) : [];

    return (
        <Box key="agents-band" flexDirection="column">
            {header}
            {shown.map(row)}
            {isOpen && all.length > MAX_ROWS ? (
                <Button key="agents-more" plain dimColor onPress={() => openOn(host, all[MAX_ROWS]?.agent.id)}>
                    {`+${all.length - MAX_ROWS} more in the sidebar`}
                </Button>
            ) : null}
        </Box>
    );
}

/** The Agents sidebar: every agent of the session, the working ones first, and the chosen one in detail. */
async function agentsPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    const list = (await host.agents().catch(() => [])).filter((agent) => !agent.teammateId);
    const ordered = [...list.filter((agent) => BUSY.has(agent.status)), ...list.filter((a) => !BUSY.has(a.status))];
    const all = await factsOf(host, ordered);
    const now = Date.now();
    const chosen = all.find((facts) => facts.agent.id === selected) ?? all[0];
    const busy = all.filter((facts) => BUSY.has(facts.agent.status)).length;
    const refresh = { key: "agents-refresh", label: "refresh", isDim: true, onPress: () => host.redraw() };

    if (all.length === 0) {
        return sidebarFrame(kit, dimNote(kit, "No agents in this session yet."));
    }

    const rows = all.map((facts) => {
        const isChosen = facts === chosen;
        const status = BUSY.has(facts.agent.status) ? tailOf(facts, now) : facts.agent.status;

        return listRow(
            kit,
            {
                key: `pick-${facts.agent.id}`,
                label: cut(
                    `${isChosen ? "▸" : facts.late ? "⚠" : " "} ${nameOf(facts)}`,
                    kit.columns - status.length - 2
                ),
                isDim: !isChosen,
                onPress: () => {
                    selected = facts.agent.id;
                    host.redraw();
                },
            },
            <Text dimColor={!facts.late} color={facts.late ? "red" : undefined}>
                {status}
            </Text>
        );
    });

    return sidebarFrame(
        kit,
        <Box flexDirection="column">
            {headerRow(
                kit,
                <Text wrap="truncate-end">
                    <Text bold>{`${all.length} agents`}</Text>
                    <Text dimColor>{` · ${busy} working`}</Text>
                </Text>,
                [refresh]
            )}
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
                {rows}
            </Box>
            {chosen ? await detailOf(host, kit, chosen, now) : null}
        </Box>
    );
}

async function detailOf(host: Host, kit: Kit, facts: AgentFacts, now: number): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    const { agent, seen } = facts;
    const transcript = (await transcriptOf(host, agent.id)) ?? "";
    loadTail(host, agent.id);
    const said = tails.get(agent.id)?.said ?? "";
    const address = agent.name ?? agent.id;
    const quoted = `"${facts.description}" (${agent.id})`;
    const facts1 = [agent.type, agent.status, agent.name, agent.id].filter(Boolean).join(" · ");
    const facts2 = [
        facts.startedAt === undefined ? "" : `ran ${liveSince(facts.startedAt, now)}`,
        seen ? plural(seen.tools, "tool call") : "",
        seen ? `last ${seen.lastTool} ${liveAgo(seen.lastAt, { now })}` : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const fill = (text: string) => void host.fill({ text, mode: "replace" });

    return (
        <Box flexDirection="column">
            {divider(kit)}
            {sectionTitle(kit, nameOf(facts))}
            {dimNote(kit, facts1, "facts1")}
            {facts2 ? dimNote(kit, facts2, "facts2") : null}
            <Box marginTop={1}>
                {actionRow(kit, [
                    {
                        key: "agent-message",
                        label: "message",
                        isPrimary: true,
                        onPress: () => fill(`SendMessage to ${address}: `),
                    },
                    {
                        key: "agent-ask",
                        label: "ask about it",
                        onPress: () => fill(`What is the agent ${quoted} doing now? Its transcript: ${transcript}`),
                    },
                    {
                        key: "agent-stop",
                        label: "stop",
                        onPress: () => fill(`Stop the agent ${quoted} with TaskStop, then tell me what it finished.`),
                    },
                    { key: "agent-copy-id", label: "copy id", isDim: true, onPress: () => void host.copy(agent.id) },
                    {
                        key: "agent-copy-path",
                        label: "copy transcript path",
                        isDim: true,
                        onPress: () => void host.copy(transcript),
                    },
                ])}
            </Box>
            {seen?.recent.length ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Recent tools")}
                    {[...seen.recent].reverse().map((call, index) => (
                        <Box key={`recent-${index}`} flexDirection="row">
                            <Text dimColor wrap="truncate-end">
                                {call.label}
                            </Text>
                            <Box flexGrow={1} />
                            <Text dimColor>{liveSince(call.at, now)}</Text>
                        </Box>
                    ))}
                </Box>
            ) : null}
            {said ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Said last")}
                    <Text dimColor italic wrap="wrap">
                        {said.split("\n").slice(-8).join("\n").slice(-900)}
                    </Text>
                </Box>
            ) : null}
        </Box>
    );
}
