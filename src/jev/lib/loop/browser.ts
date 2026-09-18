import { callTool, toolText } from "@app/chrome-devtools/lib/mcp";
import { parsePageSnapshot } from "@app/chrome-devtools/lib/page-snapshot";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

export function createBrowserSurface(options: { port: number; match?: string }): GoalSurface {
    return {
        kind: "browser",
        async see() {
            const result = await callTool("take_snapshot", {}, { port: options.port });
            const nodes = parsePageSnapshot(toolText(result));
            return {
                id: `cdp:${options.port}`,
                label: options.match ?? `port ${options.port}`,
                candidates: nodes.map((node) => ({
                    id: node.uid,
                    label: node.name || node.role,
                    element: -1,
                    action: "click" as const,
                })),
            };
        },
        async act(snapshot: SurfaceSnapshot, candidate: SurfaceCandidate) {
            if (!snapshot.candidates.some((item) => item.id === candidate.id)) {
                return { ok: false, error: "Candidate is outside the current page snapshot." };
            }

            if (!/^[A-Za-z0-9_-]+$/.test(candidate.id)) {
                return { ok: false, error: "Browser act requires a snapshot uid, not a selector." };
            }

            await callTool("click", { uid: candidate.id }, { port: options.port });
            return { ok: true };
        },
    };
}
