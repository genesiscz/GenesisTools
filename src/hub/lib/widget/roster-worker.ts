import { listAgentSessionRows } from "@app/ai/lib/sessions/agent-session-rows";
import { profiler } from "@genesiscz/utils/profile";
import { hubAgents } from "../agents";
import type { WidgetRosterReply } from "./roster-reader";

declare const self: Worker;
const prof = profiler.scope("widget");

self.onmessage = async (event: MessageEvent<{ id: number }>) => {
    const { id } = event.data;
    try {
        const [rows, agents] = await prof.measureAsync("background roster", () =>
            Promise.all([
                listAgentSessionRows({ hours: 168, withUsage: false, refresh: false, failClosed: true }),
                hubAgents({ hours: 168, limit: 150, refresh: false }),
            ])
        );
        self.postMessage({ id, ok: true, rows, agents } satisfies WidgetRosterReply);
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        } satisfies WidgetRosterReply);
    }
};
