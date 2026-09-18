import type { Observation } from "@app/control/lib/decision/observation";
import type { PrefetchPayload } from "../prefetch";

export interface SurfaceCandidate {
    id: string;
    label: string;
    element: number;
    action: "press" | "set" | "chrome" | "click";
    chrome?: string;
}

export interface SurfaceSnapshot {
    id: string;
    label: string;
    observation?: Observation;
    candidates: SurfaceCandidate[];
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
