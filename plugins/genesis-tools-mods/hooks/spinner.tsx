// Live progress on the spinner line: while the main loop waits on a tool, the line names the tool, what it runs and
// for how long, and how many subagents are working (`Sauteing… · Bash bun run test 2m 10s · 2 agents`). A timer
// draws the line again every 2 s while anything runs. `mods.spinner.enabled` switches it.
import { type Feature, type Host, isRecord, settingsOf, shortDuration } from "./shared";

const running = new Map<string, { label: string; at: number }>();
let agents = 0;
const BUSY = new Set(["pending", "running", "waiting"]);

export function toolLabel(tool: string, input: unknown): string {
    const held = isRecord(input) ? input : {};
    const what = [held.description, held.command, held.file_path, held.pattern, held.url].find(
        (value): value is string => typeof value === "string" && value.trim() !== ""
    );
    const short = what ? what.replace(/\s+/g, " ").trim() : "";

    return short ? `${tool} ${short.length > 40 ? `${short.slice(0, 40)}…` : short}` : tool;
}

/** The suffix after the spinner word: the engine's own, then the longest running tool and the busy agents. */
export function progressSuffix(base: string, now: number): string {
    const parts: string[] = [];
    const oldest = [...running.values()].sort((a, b) => a.at - b.at)[0];

    if (oldest) {
        const more = running.size > 1 ? ` +${running.size - 1}` : "";
        parts.push(`${oldest.label} ${shortDuration(now - oldest.at)}${more}`);
    }

    if (agents > 0) {
        parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
    }

    return parts.length ? `${base} · ${parts.join(" · ")}` : base;
}

async function beat(host: Host): Promise<void> {
    if (!(await settingsOf(host)).spinner.enabled) {
        return;
    }

    const list = await host.agents().catch(() => []);
    agents = list.filter((agent) => BUSY.has(agent.status)).length;

    if (running.size > 0 || agents > 0) {
        host.redraw();
    }
}

export const spinner: Feature = {
    async start(host) {
        host.every(2_000, () => {
            void beat(host);
        });
    },
    beforeTool(_host, e) {
        if (e.agentId !== undefined) {
            return undefined;
        }

        const id = e.tool_use_id;
        running.set(id, { label: toolLabel(e.tool, e), at: Date.now() });

        return () => {
            running.delete(id);
        };
    },
};
