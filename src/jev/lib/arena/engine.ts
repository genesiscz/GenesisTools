import type { CircuitGraph } from "./circuit";
import { MaleCnsCircuit } from "./neural";
import {
    ARENA_DURATION,
    ARENA_HEIGHT,
    ARENA_TARGET,
    ARENA_WIDTH,
    type ArenaAction,
    type ArenaDecision,
    type ArenaMode,
    type ArenaObservation,
    type ArenaSnapshot,
    needsCircuit,
    needsJev,
    type Point,
    seededRandom,
    type Wiring,
} from "./types";

const clamp = (value: number, max: number) => Math.max(18, Math.min(max - 18, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export interface ArenaOptions {
    mode: ArenaMode;
    seed: number;
    wiring: Wiring;
    graph?: CircuitGraph;
}

export class FlyArena {
    readonly state: ArenaSnapshot;
    private readonly random: () => number;
    private readonly brain: MaleCnsCircuit | null;
    private decision: ArenaDecision | null = null;
    private decisionAt = -10;
    private nextSwat = 2;
    private hazardHit = false;

    constructor(readonly options: ArenaOptions) {
        this.random = seededRandom(options.seed);
        if (needsCircuit(options.mode) && !options.graph) {
            throw new Error("Load a MaleCNS circuit before starting this mode.");
        }
        this.brain =
            needsCircuit(options.mode) && options.graph
                ? new MaleCnsCircuit(options.graph, { seed: options.seed, wiring: options.wiring })
                : null;
        this.state = {
            seed: options.seed,
            elapsed: 0,
            health: 3,
            sugar: 0,
            dodges: 0,
            status: "ready",
            fly: { x: 450, y: 260, angle: -Math.PI / 2, dash: 0, invulnerable: 0 },
            food: Array.from({ length: 5 }, () => this.foodPoint()),
            hazard: { x: 0, y: 0, radius: 68, until: 0, phase: "idle" },
            trail: [],
            neural: this.brain?.snapshot() ?? null,
            action: "forage",
            actionSource: options.mode === "human" ? "human" : "foraging baseline",
        };
    }

    start(): void {
        if (this.state.status === "ready" || this.state.status === "paused") {
            this.state.status = "running";
        }
    }
    pause(): void {
        if (this.state.status === "running") {
            this.state.status = "paused";
        }
    }
    setDecision(decision: ArenaDecision): void {
        this.decision = decision;
        this.decisionAt = this.state.elapsed;
    }
    clearDecision(): void {
        this.decision = null;
    }
    private foodPoint(): Point {
        return { x: 65 + this.random() * (ARENA_WIDTH - 130), y: 65 + this.random() * (ARENA_HEIGHT - 130) };
    }
    observe(): ArenaObservation {
        const { fly, hazard, food } = this.state;
        const target = food.reduce((best, point) => (distance(point, fly) < distance(best, fly) ? point : best));
        const foodAngle = angleDifference(Math.atan2(target.y - fly.y, target.x - fly.x), fly.angle);
        const hazardAngle = angleDifference(Math.atan2(hazard.y - fly.y, hazard.x - fly.x), fly.angle);
        const neural = this.state.neural;
        return {
            elapsed: this.state.elapsed,
            health: this.state.health,
            sugar: this.state.sugar,
            threat:
                hazard.phase === "idle" ? "none" : distance(hazard, fly) < hazard.radius * 1.6 ? "imminent" : "nearby",
            threatSide:
                Math.abs(hazardAngle) > 2.2
                    ? "behind"
                    : Math.abs(hazardAngle) < 0.5
                      ? "ahead"
                      : hazardAngle < 0
                        ? "left"
                        : "right",
            foodSide: Math.abs(foodAngle) < 0.35 ? "ahead" : foodAngle < 0 ? "left" : "right",
            wall: fly.x < 65 || fly.x > ARENA_WIDTH - 65 || fly.y < 65 || fly.y > ARENA_HEIGHT - 65 ? "near" : "clear",
            currentAction: this.state.action,
            neural: neural
                ? {
                      leftHz: neural.leftHz,
                      rightHz: neural.rightHz,
                      retreat: neural.retreat,
                      turn: neural.turn,
                      top: neural.top,
                  }
                : null,
        };
    }

    advance({
        milliseconds = 20,
        input = { x: 0, y: 0 },
        dash = false,
    }: {
        milliseconds?: number;
        input?: Point;
        dash?: boolean;
    } = {}): ArenaSnapshot {
        if (this.state.status !== "running") {
            return this.state;
        }
        const ms = Math.min(100, Math.max(1, Math.floor(milliseconds)));
        if (ms > 20) {
            for (let remaining = ms; remaining > 0; remaining -= 20) {
                this.advance({ milliseconds: Math.min(20, remaining), input, dash });
            }

            return this.state;
        }
        const dt = ms / 1000;
        const state = this.state;
        const fly = state.fly;
        state.elapsed += dt;
        fly.invulnerable = Math.max(0, fly.invulnerable - dt);
        fly.dash = Math.max(0, fly.dash - dt);
        const hazard = state.hazard;
        if (state.elapsed >= this.nextSwat && hazard.phase === "idle") {
            hazard.x = clamp(fly.x + Math.cos(fly.angle) * 55, ARENA_WIDTH);
            hazard.y = clamp(fly.y + Math.sin(fly.angle) * 55, ARENA_HEIGHT);
            hazard.phase = "warning";
            hazard.until = state.elapsed + 1.1;
            this.hazardHit = false;
        }

        if (hazard.phase === "warning" && state.elapsed >= hazard.until) {
            hazard.phase = "strike";
            hazard.until = state.elapsed + 0.25;
        }

        if (hazard.phase === "strike" && state.elapsed >= hazard.until) {
            if (!this.hazardHit) {
                state.dodges++;
            }
            hazard.phase = "idle";
            this.nextSwat = state.elapsed + 1.4 + this.random() * 0.9;
        }
        const towardHazard = angleDifference(Math.atan2(hazard.y - fly.y, hazard.x - fly.x), fly.angle);
        const loom =
            hazard.phase === "idle"
                ? 0
                : Math.max(0, 1 - distance(hazard, fly) / 240) *
                  (hazard.phase === "strike" ? 1 : 0.45 + 0.55 * (1 - Math.max(0, hazard.until - state.elapsed) / 1.1));
        this.brain?.advance({
            milliseconds: ms,
            left: loom * (towardHazard <= 0 ? 1 : 0.2),
            right: loom * (towardHazard >= 0 ? 1 : 0.2),
        });
        state.neural = this.brain?.snapshot() ?? null;
        let action: ArenaAction = "forage";
        let source: ArenaSnapshot["actionSource"] = "foraging baseline";
        if (needsJev(this.options.mode)) {
            const fresh = this.decision && state.elapsed - this.decisionAt <= 5;
            action = fresh && this.decision ? this.decision.action : "forage";
            source = fresh && !this.decision?.fallback ? "Jev" : "fallback";
        }

        if (needsCircuit(this.options.mode) && state.neural && state.neural.retreat > 0.08) {
            action = "dash";
            source = "MaleCNS reflex";
        }
        const target = state.food.reduce((best, point) => (distance(point, fly) < distance(best, fly) ? point : best));
        const targetAngle = Math.atan2(target.y - fly.y, target.x - fly.x);
        let speed = 102;
        if (this.options.mode === "human") {
            source = "human";
            action = dash ? "dash" : input.x || input.y ? "forage" : "wait";
            if (input.x || input.y) {
                fly.angle = Math.atan2(input.y, input.x);
            }
            speed = input.x || input.y ? speed : 0;
        } else if (action === "forage") {
            fly.angle += Math.max(-3 * dt, Math.min(3 * dt, angleDifference(targetAngle, fly.angle)));
        } else if (action === "left" || action === "right") {
            fly.angle += (action === "left" ? -1 : 1) * 3 * dt;
        } else if (action === "wait") {
            speed = 0;
        } else if (action === "dash" && hazard.phase !== "idle") {
            const away = Math.atan2(fly.y - hazard.y, fly.x - hazard.x);
            fly.angle += Math.max(-7 * dt, Math.min(7 * dt, angleDifference(away, fly.angle)));
        }

        if (action === "dash") {
            speed *= 2.15;
            fly.dash = 0.15;
        }
        fly.x = clamp(fly.x + Math.cos(fly.angle) * speed * dt, ARENA_WIDTH);
        fly.y = clamp(fly.y + Math.sin(fly.angle) * speed * dt, ARENA_HEIGHT);
        state.action = action;
        state.actionSource = source;
        state.trail.push({ x: fly.x, y: fly.y });
        if (state.trail.length > 60) {
            state.trail.shift();
        }

        for (let i = 0; i < state.food.length; i++) {
            if (distance(fly, state.food[i]) < 22) {
                state.sugar++;
                state.food[i] = this.foodPoint();
            }
        }

        if (
            hazard.phase === "strike" &&
            !this.hazardHit &&
            distance(fly, hazard) < hazard.radius &&
            fly.invulnerable === 0
        ) {
            state.health--;
            fly.invulnerable = 1;
            this.hazardHit = true;
        }

        if (state.sugar >= ARENA_TARGET) {
            state.status = "won";
        } else if (state.health <= 0 || state.elapsed >= ARENA_DURATION) {
            state.status = "lost";
        }

        return state;
    }
}
