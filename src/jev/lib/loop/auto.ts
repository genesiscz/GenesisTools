import { observedEvidence } from "@app/control/lib/decision/observation";
import { prefixCandidateId, stripCandidatePrefix } from "./prefix";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

/**
 * One state, two sources: native AX rows (`ax:` ids) and the CDP page rows (`cdp:` ids). The
 * evidence Jev sees is the merged list, so a page row is as choosable as a native one.
 */
export function createAutoSurface(options: { ax?: GoalSurface; browser?: GoalSurface }): GoalSurface {
    return {
        kind: "cu",
        async see(signal) {
            const ax = options.ax ? await options.ax.see(signal) : undefined;
            const browser = options.browser ? await options.browser.see(signal) : undefined;
            const axEvidence = ax?.observation ? observedEvidence(ax.observation) : (ax?.evidence ?? []);
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
                evidence: {
                    native: axEvidence,
                    page:
                        browser?.evidence ??
                        browser?.candidates.map((row) => ({ id: row.id, role: row.role, label: row.label })) ??
                        [],
                },
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
