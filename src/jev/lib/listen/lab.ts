import { NativeControlDriver } from "@app/control/lib/decision/native";
import { candidatesFor, type Observation } from "@app/control/lib/decision/observation";
import { type Evaluator, evaluateRequest } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { type LiveTranscriptEvent, openLiveStt } from "@genesiscz/utils/ai/stt";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { z } from "zod";
import type { PrefetchPayload } from "../prefetch";
import { axView, createListenPipeline, type ListenDecision } from "./pipeline";

const { log } = logger.scoped("jev-listen");
const prof = profiler.scope("jev-listen");

/** A lab session never runs longer than this, whatever the transcript says. */
const LAB_MAX_SECONDS = 45;

export class ListenSessionConflictError extends Error {
    readonly status = 409;

    constructor() {
        super("A listen session is already running.");
        this.name = "ListenSessionConflictError";
    }
}

export const listenLabEventSchema = z
    .object({
        kind: z.enum(["partial", "final", "speech_start", "speech_end", "error"]),
        text: z.string().max(4000),
        isFinal: z.boolean().optional(),
        startedAtMs: z.number().nonnegative().optional(),
    })
    .strict();

export const listenLabStartSchema = z
    .object({
        transcript: z.array(listenLabEventSchema).min(1).max(200).optional(),
        fixture: z.string().max(80).optional(),
        app: z.string().min(1).max(120).optional(),
        windowId: z.number().int().positive().optional(),
        goal: z.string().max(400).optional(),
        gate: z.number().min(0).max(1).optional(),
        act: z.boolean().optional(),
    })
    .strict();

export interface ListenLabTail {
    index: number;
    transcript: string;
    status: string;
    choice: string | null;
    probability: number;
    reason: string;
    /** Set when the wake gate rewrote the transcript to the command after the wake phrase. */
    command?: string;
}

export interface ListenLabStatus {
    running: boolean;
    /** The fixture id or `app` the running (or last) session read from. */
    transcript?: string;
    app?: string;
    dryRun: boolean;
    events: number;
    tail: ListenLabTail[];
    wouldPress?: string | null;
    error?: string;
}

export interface ListenLabFixture {
    id: string;
    title: string;
    events: LiveTranscriptEvent[];
}

function speech(text: string, startedAtMs: number, isFinal: boolean): LiveTranscriptEvent {
    return { kind: isFinal ? "final" : "partial", text, isFinal, startedAtMs };
}

/**
 * Bundled server-side transcripts. The lab never opens a microphone and never accepts audio from
 * the browser, so a fixture (or a caller-supplied transcript) is the only input the pipeline sees.
 */
export const LISTEN_LAB_FIXTURES: ListenLabFixture[] = [
    {
        id: "calculator-press-seven",
        title: "press seven → one admitted press",
        events: [
            speech("press", 0, false),
            speech("press se", 200, false),
            speech("press seven", 400, true),
            speech("stop", 1200, true),
        ],
    },
    {
        id: "calculator-ambiguous",
        title: "ambiguous utterance → abstain",
        events: [speech("press the other one", 0, true), speech("stop", 800, true)],
    },
];

export const LISTEN_LAB_FIXTURE_IDS = LISTEN_LAB_FIXTURES.map((fixture) => fixture.id);
export const LISTEN_LAB_DEFAULT_FIXTURE = "calculator-press-seven";

function pressButton(index: number, title: string) {
    return {
        index,
        depth: 1,
        role: "AXButton",
        AXTitle: title,
        AXEnabled: "1",
        visible: true,
        actions: ["AXPress"],
    };
}

/**
 * The retained observation every fixture session is choosing over. It is a synthetic calculator
 * window, not a `see` of this Mac: a browser must never be able to make the dashboard server read
 * the user's screen.
 */
export function listenLabObservation(): Observation {
    return {
        ok: true,
        app: "FixtureCalculator",
        pid: 1,
        snapshot: "listen-lab-fixture",
        window: { id: 1, title: "Calculator" },
        scope: "window",
        elements: [
            { index: 0, depth: 0, role: "AXStaticText", AXValue: "0", visible: true },
            pressButton(1, "7"),
            pressButton(2, "8"),
            pressButton(3, "9"),
            pressButton(4, "Add"),
            pressButton(5, "Equals"),
            pressButton(6, "Clear"),
        ],
    };
}

export interface ListenLabStartOptions extends z.infer<typeof listenLabStartSchema> {
    /** Only a loopback request may bind a native driver; the route decides this, never the body. */
    allowNative?: boolean;
    provider?: EvaluationProviderId;
    /** Tests inject a fixture evaluator here, the way the 409 replay routes do. */
    evaluate?: Evaluator;
}

/**
 * Decides what a start request may touch. Separated from `start()` so the guard has a negative
 * control that does not spawn `ax-tool`: a loopback request keeps the native path, everything else
 * is refused, and an `act` without a bound app can never leave dry-run.
 */
export function resolveLabTarget(options: { app?: string; act?: boolean; allowNative?: boolean }): {
    app?: string;
    dryRun: boolean;
} {
    if (options.app && options.allowNative !== true) {
        throw new Error("A native app target is accepted from a loopback request only.");
    }

    const app = options.allowNative === true ? options.app : undefined;
    return { ...(app ? { app } : {}), dryRun: !(options.act === true && app !== undefined) };
}

interface LabSession {
    running: boolean;
    label: string;
    app?: string;
    dryRun: boolean;
    events: number;
    tail: ListenLabTail[];
    controller: AbortController;
    finished: Promise<void>;
    error?: string;
}

function toTail(decision: ListenDecision, index: number): ListenLabTail {
    return {
        index,
        transcript: decision.transcript,
        status: decision.status,
        choice: decision.choice,
        probability: decision.probability,
        reason: decision.reason,
        ...(decision.command ? { command: decision.command } : {}),
    };
}

/**
 * The `/listen/*` lab: ONE live-policy session per dashboard process.
 *
 * PR #411 kept an in-memory flag here and never ran the pipeline, so `Start` in the browser
 * changed a badge and nothing else (B40). This runs the real `createListenPipeline` over a
 * server-side transcript and appends every decision it makes to the tail.
 */
export class ListenLab {
    private session: LabSession | null = null;

    status(): ListenLabStatus {
        const session = this.session;
        if (!session) {
            return { running: false, dryRun: true, events: 0, tail: [] };
        }

        // The LAST row is often `stop` or a held partial, so the newest row that actually names a
        // target is what the strip reports. An admitted `abstain` is a decision, not a target.
        const pressed = session.tail.findLast(
            (row) => (row.status === "would" || row.status === "act") && row.choice !== null && row.choice !== "abstain"
        );
        return {
            running: session.running,
            transcript: session.label,
            ...(session.app ? { app: session.app } : {}),
            dryRun: session.dryRun,
            events: session.events,
            tail: session.tail,
            wouldPress: pressed?.choice ?? null,
            ...(session.error ? { error: session.error } : {}),
        };
    }

    tail(): ListenLabTail[] {
        return this.session?.tail ?? [];
    }

    /** Appends one decision. Public so the pipeline runner and its tests share one writer. */
    append(decision: ListenDecision): ListenLabStatus {
        const session = this.session;
        if (!session) {
            throw new Error("No listen session is running.");
        }

        session.tail.push(toTail(decision, session.tail.length));
        return this.status();
    }

    start(options: ListenLabStartOptions = {}): ListenLabStatus {
        if (this.session?.running) {
            throw new ListenSessionConflictError();
        }

        const events = this.resolveEvents(options);
        const { app, dryRun } = resolveLabTarget(options);
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), LAB_MAX_SECONDS * 1000);
        const session: LabSession = {
            running: true,
            label: options.fixture ?? (options.transcript ? "inline transcript" : LISTEN_LAB_DEFAULT_FIXTURE),
            ...(app ? { app } : {}),
            dryRun,
            events: events.length,
            tail: [],
            controller,
            finished: Promise.resolve(),
        };
        this.session = session;
        log.info(
            { fixture: session.label, app, dryRun, events: events.length, gate: options.gate },
            "listen lab session starting"
        );
        session.finished = this.run({ session, events, options, app, dryRun })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    session.error = error instanceof Error ? error.message : "Listen session failed.";
                    log.warn({ error }, "listen lab session failed");
                }
            })
            .finally(() => {
                clearTimeout(deadline);
                session.running = false;
                log.info({ fixture: session.label, decisions: session.tail.length }, "listen lab session finished");
            });
        return this.status();
    }

    stop(): ListenLabStatus {
        this.session?.controller.abort();
        if (this.session) {
            this.session.running = false;
        }

        return this.status();
    }

    /** Awaits the running session. Tests and `dispose()` use it; no route waits on a session. */
    async settle(): Promise<void> {
        await this.session?.finished;
    }

    dispose(): void {
        this.session?.controller.abort();
        this.session = null;
    }

    private resolveEvents(options: ListenLabStartOptions): LiveTranscriptEvent[] {
        if (options.transcript?.length) {
            return options.transcript.map((event) => ({
                kind: event.kind,
                text: event.text,
                isFinal: event.isFinal ?? event.kind === "final",
                startedAtMs: event.startedAtMs ?? 0,
            }));
        }

        const id = options.fixture ?? LISTEN_LAB_DEFAULT_FIXTURE;
        const fixture = LISTEN_LAB_FIXTURES.find((item) => item.id === id);
        if (!fixture) {
            throw new Error(`Unknown listen fixture ${id}. Known: ${LISTEN_LAB_FIXTURE_IDS.join(", ")}.`);
        }

        return fixture.events;
    }

    private async run(input: {
        session: LabSession;
        events: LiveTranscriptEvent[];
        options: ListenLabStartOptions;
        app?: string;
        dryRun: boolean;
    }): Promise<void> {
        const { session, events, options, app, dryRun } = input;
        const signal = session.controller.signal;
        const provider = options.provider;
        const evaluate: Evaluator =
            options.evaluate ?? ((call) => evaluateRequest({ ...call, ...(provider ? { provider } : {}) }));
        const driver = app
            ? new NativeControlDriver({ app, ...(options.windowId ? { windowId: options.windowId } : {}) })
            : undefined;
        const retained = listenLabObservation();
        const stt = await openLiveStt({ provider: "fixture", events, signal });
        const pipeline = createListenPipeline({
            dryRun,
            gate: options.gate,
            goal: options.goal,
            signal,
            evaluate,
            surface: {
                see: async () => axView(driver ? await driver.observe({ signal }) : retained),
                act: async (payload: PrefetchPayload, view) => {
                    const observation = view.observation;
                    if (!driver || !observation) {
                        return { ok: false, error: "the lab has no native driver; this session is dry-run only" };
                    }

                    const candidate = candidatesFor({ observation }).find(
                        (item) => item.element === payload.element && item.action === payload.action
                    );
                    if (!candidate) {
                        return { ok: false, error: "payload is not an observed candidate" };
                    }

                    return driver.act({ observation, candidate });
                },
            },
        });
        const stopSession = prof.start("lab-session");
        try {
            for await (const event of stt.events()) {
                const decision = await pipeline.decide(event);
                this.append(decision);
                if (decision.status === "stop") {
                    break;
                }
            }
        } catch (error) {
            if (!signal.aborted) {
                throw error;
            }

            log.debug({ error }, "listen lab session aborted");
        } finally {
            stopSession();
            await stt.close();
        }
    }
}
