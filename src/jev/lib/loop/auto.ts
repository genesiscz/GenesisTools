import { prefixCandidateId, stripCandidatePrefix } from "./prefix";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

export function createAutoSurface(options: { ax?: GoalSurface; browser?: GoalSurface }): GoalSurface {
    return {
        kind: "cu",
        async see(signal) {
            const ax = options.ax ? await options.ax.see(signal) : undefined;
            const browser = options.browser ? await options.browser.see(signal) : undefined;
            return {
                id: `auto:${ax?.id ?? ""}:${browser?.id ?? ""}`,
                label: [ax?.label, browser?.label].filter(Boolean).join(" + ") || "auto",
                observation: ax?.observation,
                candidates: [
                    ...(ax?.candidates.map((candidate) => ({
                        ...candidate,
                        id: prefixCandidateId("ax", candidate.id),
                    })) ?? []),
                    ...(browser?.candidates.map((candidate) => ({
                        ...candidate,
                        id: prefixCandidateId("cdp", candidate.id),
                    })) ?? []),
                ],
            };
        },
        async act(snapshot: SurfaceSnapshot, candidate: SurfaceCandidate) {
            const parsed = stripCandidatePrefix(candidate.id);
            if (parsed.surface === "cdp") {
                if (!options.browser) {
                    return { ok: false, error: "No browser surface is bound." };
                }

                return options.browser.act(snapshot, { ...candidate, id: parsed.id });
            }

            if (!options.ax) {
                return { ok: false, error: "No AX surface is bound." };
            }

            return options.ax.act(snapshot, { ...candidate, id: parsed.id });
        },
    };
}
