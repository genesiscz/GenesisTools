import { type ArenaOptions, FlyArena } from "../lib/arena/engine";
import type { ArenaDecision, ArenaObservation, ArenaSnapshot, Point } from "../lib/arena/types";

export type ArenaWorkerInput =
    | { type: "init"; options: ArenaOptions }
    | { type: "advance"; milliseconds: number; input: Point; dash: boolean }
    | { type: "start" | "pause" | "step" | "fallback" }
    | { type: "decision"; decision: ArenaDecision };
export type ArenaWorkerOutput =
    | { type: "state"; state: ArenaSnapshot; observation: ArenaObservation }
    | { type: "error"; message: string };

let arena: FlyArena | undefined;
self.onmessage = (event: MessageEvent<ArenaWorkerInput>) => {
    try {
        const message = event.data;
        if (message.type === "init") {
            arena = new FlyArena(message.options);
        }

        if (!arena) {
            throw new Error("Arena is not initialized.");
        }

        if (message.type === "start") {
            arena.start();
        } else if (message.type === "pause") {
            arena.pause();
        } else if (message.type === "advance") {
            arena.advance(message);
        } else if (message.type === "step") {
            arena.start();
            arena.advance({ milliseconds: 100 });
            arena.pause();
        } else if (message.type === "fallback") {
            arena.clearDecision();
        } else if (message.type === "decision") {
            arena.setDecision(message.decision);
        }
        self.postMessage({
            type: "state",
            state: arena.state,
            observation: arena.observe(),
        } satisfies ArenaWorkerOutput);
    } catch (error) {
        self.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : "Arena worker failed.",
        } satisfies ArenaWorkerOutput);
    }
};
