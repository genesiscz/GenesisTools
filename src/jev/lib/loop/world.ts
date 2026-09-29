import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { z } from "zod";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

/**
 * A deterministic simulated computer, so the real goal loop can be driven end to end.
 *
 * Ported from typesafe-computer-use `tests/world.py`. The loop is one cycle over three seams: see the
 * screen, ask Jev, act. This module fakes only the outer ones: the screen (a real `GoalSurface`),
 * time (the loop's injected `sleep`) and Jev (a real `Evaluator` driven by a policy). `runGoalLoop`,
 * the fan-out and the admission gate run exactly as they ship, so a scenario that fails says the
 * loop cannot do that task, not that the harness is wrong.
 */

/** A static line: shown to Jev as evidence, never offered as an act. */
export const TEXT_ROLE = "AXStaticText";
export const LOADING_LINE = "Loading...";
export const LOADING_STOP = "Stop loading";

export interface WorldRow {
    label: string;
    /** `TEXT_ROLE` is a static line; any other role is a row the loop may press. */
    role: string;
}

/** A plain string is a button. */
export type RowSpec = string | WorldRow;

export function text(label: string): WorldRow {
    return { label, role: TEXT_ROLE };
}

/**
 * What acting on a row does: go to that page now, run a callback that may change the world and
 * returns the next page (or nothing to stay), or land on a page only at the next wait, the way a
 * slow app with no progress indicator does.
 */
export type Transition = string | ((world: World) => string | undefined) | { afterWait: string };

export interface WorldPage {
    name: string;
    /** The window or tab title: the loop's screen identity. Defaults to the name. */
    title?: string;
    /** A function is asked again on every read, so a page can show something that moves on its own. */
    rows: RowSpec[] | ((world: World) => RowSpec[]);
    /** Row label to transition. A row with no entry does nothing: a dead link, a refused press. */
    on?: Record<string, Transition>;
    /** Row label to the error the surface reports when that act fails to dispatch. */
    fails?: Record<string, string>;
    /** Waits before the rows appear. Until then the page shows a loading line and a stop button. */
    loadsIn?: number;
}

/** A Jev request as a policy reads it: exactly what the loop sent, nothing the world knows. */
export interface WorldRequest {
    goal: string;
    window: string;
    candidates: Array<{ id: string; label: string; role: string; action: string }>;
    observations: unknown;
    /** `already_tried_on_this_screen`, empty when the loop sent none. */
    triedHere: string[];
    /** False for a tournament shard, which asks only for a target. */
    final: boolean;
}

export type Move =
    | { kind: "pick"; label: string; risk?: number }
    | { kind: "done" }
    | { kind: "wait" }
    | { kind: "abstain" }
    | { kind: "blocked" };

/** A bare string is shorthand: "done", "wait", "abstain" or "blocked", and any other string picks that label. */
export type Policy = (request: WorldRequest) => Move | string;

/** The offered candidates live in the target question's criteria, keyed by id, beside `abstain`. */
const offeredSchema = z.object({ label: z.string(), role: z.string(), action: z.string() });
const requestSchema = z.object({
    state: z.object({
        goal: z.string(),
        window: z.string(),
        observations: z.unknown(),
        already_tried_on_this_screen: z.array(z.string()).optional(),
    }),
    questions: z.looseObject({
        target: z.object({ criteria: z.record(z.string(), z.union([offeredSchema, z.string()])) }),
    }),
});

/** The questions the loop asks today. A new one fails loudly, because the world would not answer it. */
const KNOWN_QUESTIONS = new Set(["target", "done", "blocked", "wait", "risk"]);
const CHOSEN = 0.95;
const YES = 0.95;
const NO = 0.02;

function toMove(answer: Move | string): Move {
    if (typeof answer !== "string") {
        return answer;
    }

    if (answer === "done" || answer === "wait" || answer === "abstain" || answer === "blocked") {
        return { kind: answer };
    }

    return { kind: "pick", label: answer };
}

/** A full distribution over every offered key, the only shape the admission gate admits. */
function distribution(keys: string[], chosen: string): Record<string, number> {
    const rest = keys.length > 1 ? (1 - CHOSEN) / (keys.length - 1) : 0;
    return Object.fromEntries(keys.map((key) => [key, key === chosen ? (keys.length > 1 ? CHOSEN : 1) : rest]));
}

function scoreProbabilities(risk: number): Record<string, number> {
    const level = String(Math.max(0, Math.min(2, Math.round(risk))));
    return Object.fromEntries(["0", "1", "2"].map((key) => [key, key === level ? 1 : 0]));
}

/** Replays the moves in order, one per decision (tournament shards do not use one up), then says done. */
export function scripted(...moves: Array<Move | string>): Policy {
    let decisions = 0;
    return (request) => {
        const move = decisions < moves.length ? moves[decisions] : "done";
        if (request.final) {
            decisions += 1;
        }

        return move ?? "done";
    };
}

export class World {
    readonly pages: Map<string, WorldPage>;
    page: WorldPage;
    /** Screen reads so far. */
    reads = 0;
    /** Waits the loop spent through its injected sleep. */
    waits = 0;
    /** Every act the surface received, in order, with the page it was taken on. */
    readonly acts: Array<{ page: string; label: string }> = [];
    /** Every Jev request the loop sent, shards included, as the policy read it. */
    readonly requests: WorldRequest[] = [];
    private readonly loading: Map<string, number>;
    private pending?: string;
    private lastSnapshot?: string;

    constructor(pages: WorldPage[], start?: string) {
        this.pages = new Map(pages.map((page) => [page.name, page]));
        this.page = this.pageNamed(start ?? pages[0]?.name ?? "");
        this.loading = new Map(pages.map((page) => [page.name, page.loadsIn ?? 0]));
    }

    get loadingNow(): boolean {
        return (this.loading.get(this.page.name) ?? 0) > 0;
    }

    /** The rows now showing. A page still loading shows one line and a stop button. */
    rows(): WorldRow[] {
        if (this.loadingNow) {
            return [text(LOADING_LINE), { label: LOADING_STOP, role: "AXButton" }];
        }

        const specs = typeof this.page.rows === "function" ? this.page.rows(this) : this.page.rows;
        return specs.map((spec) => (typeof spec === "string" ? { label: spec, role: "AXButton" } : spec));
    }

    /** The decisions the loop asked for: final requests only, one per step that reached Jev. */
    decisions(): WorldRequest[] {
        return this.requests.filter((request) => request.final);
    }

    /** The loop's injected sleep: a wait lands a slow act first, and otherwise spends one tick of loading. */
    readonly sleep = async (_ms: number): Promise<void> => {
        this.waits += 1;
        if (this.pending !== undefined) {
            this.page = this.pageNamed(this.pending);
            this.pending = undefined;
            return;
        }

        const left = this.loading.get(this.page.name) ?? 0;
        if (left > 0) {
            this.loading.set(this.page.name, left - 1);
        }
    };

    readonly surface: GoalSurface = {
        kind: "cu",
        see: async () => this.see(),
        act: async (snapshot, candidate) => this.act(snapshot, candidate),
    };

    /** An Evaluator that validates every request as the real Jev would, then answers with the policy's move. */
    evaluator(policy: Policy): Evaluator {
        return async (call) => {
            evaluationSchema.parse(call.input);
            const parsed = requestSchema.parse(call.input);
            const unknown = Object.keys(parsed.questions).filter((id) => !KNOWN_QUESTIONS.has(id));
            if (unknown.length > 0) {
                throw new Error(`the loop asked ${unknown.join(", ")}, which the world does not answer`);
            }

            const criteria = parsed.questions.target.criteria;
            const request: WorldRequest = {
                goal: parsed.state.goal,
                window: parsed.state.window,
                candidates: Object.entries(criteria).flatMap(([id, row]) =>
                    typeof row === "string" ? [] : [{ id, label: row.label, role: row.role, action: row.action }]
                ),
                observations: parsed.state.observations,
                triedHere: parsed.state.already_tried_on_this_screen ?? [],
                final: "done" in parsed.questions,
            };
            this.requests.push(request);
            return this.answer(request, Object.keys(criteria), toMove(policy(request)));
        };
    }

    private answer(request: WorldRequest, keys: string[], move: Move): EvaluationResponse {
        let choice = "abstain";
        if (move.kind === "pick") {
            const match = request.candidates.find((candidate) => candidate.label === move.label);
            if (match) {
                choice = match.id;
            } else if (request.final) {
                const offered = request.candidates.map((candidate) => candidate.label).join(", ");
                throw new Error(`the policy picked "${move.label}", but the request offers only: ${offered}`);
            }
        }

        const target = { type: "choice" as const, choice, probabilities: distribution(keys, choice) };
        const answers: EvaluationResponse["answers"] = request.final
            ? {
                  target,
                  done: { type: "boolean", probability: move.kind === "done" ? YES : NO },
                  blocked: { type: "boolean", probability: move.kind === "blocked" ? YES : NO },
                  wait: { type: "boolean", probability: move.kind === "wait" ? YES : NO },
                  risk: {
                      type: "score",
                      score: move.kind === "pick" ? (move.risk ?? 0) : 0,
                      probabilities: scoreProbabilities(move.kind === "pick" ? (move.risk ?? 0) : 0),
                  },
              }
            : { target };
        return {
            model: "world",
            answers,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            warnings: [],
            rounding: undefined,
            providerMetadata: undefined,
        };
    }

    private pageNamed(name: string): WorldPage {
        const page = this.pages.get(name);
        if (!page) {
            throw new Error(`the world has no page "${name}"`);
        }

        return page;
    }

    /**
     * Ids renumber on every read, the way a page snapshot numbers its nodes afresh, so nothing in the
     * loop can lean on an id surviving from one read to the next.
     */
    private see(): SurfaceSnapshot {
        this.reads += 1;
        const rows = this.rows();
        const id = (index: number) => `${this.reads}_${index}`;
        const candidates: SurfaceCandidate[] = rows.flatMap((row, index) =>
            row.role === TEXT_ROLE
                ? []
                : [{ id: id(index), label: row.label, element: index, action: "press", role: row.role }]
        );
        const snapshot: SurfaceSnapshot = {
            id: `${this.page.name}#${this.reads}`,
            label: this.page.title ?? this.page.name,
            candidates,
            evidence: rows.map((row, index) => ({ id: id(index), role: row.role, label: row.label })),
        };
        this.lastSnapshot = snapshot.id;
        return snapshot;
    }

    /** Acts only on the screen the loop last saw, like a real surface: a stale snapshot is refused. */
    private act(snapshot: SurfaceSnapshot, candidate: SurfaceCandidate): { ok: boolean; error?: string } {
        if (snapshot.id !== this.lastSnapshot) {
            return { ok: false, error: `stale snapshot ${snapshot.id}` };
        }

        if (!this.rows().some((row) => row.label === candidate.label && row.role !== TEXT_ROLE)) {
            return { ok: false, error: `no row "${candidate.label}" on ${this.page.name}` };
        }

        this.acts.push({ page: this.page.name, label: candidate.label });
        const failure = this.page.fails?.[candidate.label];
        if (failure) {
            return { ok: false, error: failure };
        }

        // A page still loading drops every act, which is what a real app does to a press on a spinner.
        if (this.loadingNow) {
            return { ok: true };
        }

        const transition = this.page.on?.[candidate.label];
        if (typeof transition === "string") {
            this.page = this.pageNamed(transition);
        } else if (typeof transition === "function") {
            const next = transition(this);
            if (next !== undefined) {
                this.page = this.pageNamed(next);
            }
        } else if (transition) {
            this.pending = transition.afterWait;
        }

        return { ok: true };
    }
}
