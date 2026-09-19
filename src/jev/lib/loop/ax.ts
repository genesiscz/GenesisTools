import type { ControlDriver } from "@app/control/lib/decision/native";
import { candidatesFor } from "@app/control/lib/decision/observation";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

export function createAxSurface(driver: ControlDriver): GoalSurface {
    return {
        kind: "ax",
        async see(signal) {
            const observation = await driver.observe({ signal });
            return {
                id: observation.snapshot,
                label: `${observation.app} ${observation.window.title}`,
                observation,
                candidates: candidatesFor({ observation }).map((candidate) => ({
                    id: candidate.id,
                    label: candidate.label,
                    element: candidate.element,
                    action: candidate.action,
                })),
            };
        },
        async act(snapshot: SurfaceSnapshot, candidate: SurfaceCandidate) {
            if (!snapshot.observation) {
                return { ok: false, error: "AX act requires an observation." };
            }

            const match = candidatesFor({ observation: snapshot.observation }).find((item) => item.id === candidate.id);
            if (!match) {
                return { ok: false, error: "Candidate is outside the current observed scope." };
            }

            return driver.act({ observation: snapshot.observation, candidate: match });
        },
    };
}
