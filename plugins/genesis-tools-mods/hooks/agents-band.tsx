// The live agents band: one row per working subagent with its model, what it is for, how long it has run, how long
// since its last tool call, and how many tool calls it made. The engine's agents panel shows none of the first
// three, and a subagent past `mods.agentsBand.warnMinutes` turns red. The model and start come from `agent.spawn`'s
// answer (kept in `spawned`, which survives a reload); activity from the subagent's own `tool.call`s.
import type { AgentSpawnInput, AgentSpawnResult, ElementTable, RenderElement } from "claude-code";
import type { SpawnedAgents } from "../types";
import { modelLabel } from "./agent-model";
import { type Feature, type Host, settingsOf, shortDuration } from "./shared";

let spawned: SpawnedAgents = {};
const activity = new Map<string, { lastAt: number; lastTool: string; tools: number }>();
const BUSY = new Set(["pending", "running", "waiting"]);
const MAX_ROWS = 6;

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
            activity.set(e.agentId, { lastAt: Date.now(), lastTool: e.tool, tools: (before?.tools ?? 0) + 1 });
        }

        return undefined;
    },
};

/** Keeps the model and start of a spawned subagent, as `agent.spawn` answered. */
export function recordSpawn(host: Host, e: AgentSpawnInput, result: AgentSpawnResult): void {
    const agentId = result.agentId;

    if (!agentId) {
        return;
    }

    const model = result.model || e.model || e.parentModel;
    // The agent-model mod may have put the model in front already; the row prints it once, itself.
    const description = e.description.replace(/^\([A-Z]\) /, "").replace(`${modelLabel(model, "label")} · `, "");
    spawned = { ...spawned, [agentId]: { model, description, at: Date.now() } };
    host.redraw();
}

/** The band's agents rows, or null when no subagent works. */
export async function agentsRow(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    const all = await settingsOf(host);
    const settings = all.agentsBand;

    if (!settings.enabled) {
        return null;
    }

    const list = (await host.agents().catch(() => [])).filter((agent) => BUSY.has(agent.status) && !agent.teammateId);

    if (list.length === 0) {
        return null;
    }

    const held = spawned;
    const { Box, Text } = ui;
    const now = Date.now();
    const rows = list.slice(0, MAX_ROWS).map((agent) => {
        const known = held[agent.id];
        const seen = activity.get(agent.id);
        const age = known ? now - known.at : undefined;
        const late = age !== undefined && age > settings.warnMinutes * 60_000;
        const model = known ? modelLabel(known.model, all.agentModel.format) : "?";
        const idle = seen
            ? ` · idle ${shortDuration(now - seen.lastAt)} · ${seen.tools} tools, last ${seen.lastTool}`
            : "";

        return (
            <Text key={`agent-${agent.id}`} color={late ? "red" : undefined} dimColor={!late} wrap="truncate-end">
                {`${late ? "⚠ " : "● "}(${model}) ${known?.description ?? agent.description}${age === undefined ? "" : ` · ${shortDuration(age)}`}${idle}`}
            </Text>
        );
    });

    return (
        <Box key="agents-band" flexDirection="column">
            {rows}
            {list.length > MAX_ROWS ? <Text dimColor>{`+${list.length - MAX_ROWS} more agents`}</Text> : null}
        </Box>
    );
}
