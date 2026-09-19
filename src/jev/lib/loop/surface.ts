import type { Candidate, Observation } from "@app/control/lib/decision/observation";
import type { PrefetchPayload } from "../prefetch";

export interface SurfaceCandidate {
    id: string;
    label: string;
    element: number;
    action: Candidate["action"] | "chrome" | "click";
    chrome?: string;
    /** Role as the surface reports it (AX role, or the page node role). */
    role?: string;
    /** Link target, when the row is a link; the strongest signal for "open <name>". */
    href?: string;
}

export interface SurfaceSnapshot {
    id: string;
    label: string;
    /** The native observation when the surface has one; browser-only snapshots have none. */
    observation?: Observation;
    candidates: SurfaceCandidate[];
    /**
     * Evidence rows Jev should see for this snapshot when there is no native observation, or when
     * the surface merges several sources. Kept small and text-only (Jev has no pixels).
     */
    evidence?: unknown;
}

export interface GoalSurface {
    kind: "ax" | "browser" | "cu";
    see(signal?: AbortSignal): Promise<SurfaceSnapshot>;
    act(
        snapshot: SurfaceSnapshot,
        candidate: SurfaceCandidate,
        payload?: PrefetchPayload
    ): Promise<{ ok: boolean; error?: string }>;
}
