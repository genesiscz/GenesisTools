export const ARENA_MODES = ["human", "malecns", "jev", "hybrid"] as const;
export type ArenaMode = (typeof ARENA_MODES)[number];
export const ARENA_ACTIONS = ["forage", "left", "right", "dash", "wait"] as const;
export type ArenaAction = (typeof ARENA_ACTIONS)[number];
export type Wiring = "original" | "shuffled" | "disconnected";
export interface Point {
    x: number;
    y: number;
}
export interface NeuralSnapshot {
    leftHz: number;
    rightHz: number;
    sensoryLeftHz: number;
    sensoryRightHz: number;
    meanHz: number;
    retreat: number;
    turn: number;
    spikes: number;
    activity: number[];
    top: Array<{ id: string; type: string; hz: number }>;
}
export interface ArenaSnapshot {
    seed: number;
    elapsed: number;
    health: number;
    sugar: number;
    dodges: number;
    status: "ready" | "running" | "paused" | "won" | "lost";
    fly: Point & { angle: number; dash: number; invulnerable: number };
    food: Point[];
    hazard: Point & { phase: "idle" | "warning" | "strike"; until: number; radius: number };
    trail: Point[];
    neural: NeuralSnapshot | null;
    action: ArenaAction;
    actionSource: "human" | "foraging baseline" | "MaleCNS reflex" | "Jev" | "fallback";
}
export interface ArenaObservation {
    elapsed: number;
    health: number;
    sugar: number;
    threat: "none" | "nearby" | "imminent";
    threatSide: "left" | "right" | "behind" | "ahead";
    foodSide: "left" | "right" | "ahead";
    wall: "clear" | "near";
    currentAction: ArenaAction;
    neural: { leftHz: number; rightHz: number; retreat: number; turn: number; top: NeuralSnapshot["top"] } | null;
}
export interface ArenaDecision {
    action: ArenaAction;
    confidence: number | null;
    threatProbability: number;
    survivalScore: number;
    probabilities: Record<string, number>;
    fallback: boolean;
    latencyMs: number;
    usage: { inputTokens?: number; outputTokens?: number };
}
export const ARENA_WIDTH = 900;
export const ARENA_HEIGHT = 520;
export const ARENA_DURATION = 60;
export const ARENA_TARGET = 12;
export function needsCircuit(mode: ArenaMode): boolean {
    return mode === "malecns" || mode === "hybrid";
}
export function needsJev(mode: ArenaMode): boolean {
    return mode === "jev" || mode === "hybrid";
}
export function seededRandom(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 4294967296;
    };
}
