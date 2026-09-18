import { createHash } from "node:crypto";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { OperationBudget } from "@genesiscz/utils/operation-budget";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { z } from "zod";
import { semanticFingerprint } from "./await";
import { resolveIntent } from "./decisions";
import { type Candidate, candidatesFor, type Observation, observedEvidence } from "./observation";
import type { ControlSession } from "./session";
import { type Binding, matchingCandidates } from "./workflow";

export const chooserModeSchema = z.enum(["exact", "jev", "auto"]);
export type ChooserMode = z.infer<typeof chooserModeSchema>;
export const hostChoiceSchema = z
    .object({
        packetId: z.string().regex(/^[a-f0-9]{64}$/),
        choice: z.string().nullable(),
        evidence: z.array(z.string()).max(10),
    })
    .strict();
export interface EscalationPacket {
    version: 1;
    packetId: string;
    createdAt: number;
    expiresAt: number;
    question: string;
    scope: { app: string; pid: number; windowId: number; processLaunch?: number };
    candidates: Array<{ id: string; action: string; role: string; label: string; ancestors: string[] }>;
    evidence: ReturnType<typeof observedEvidence>;
    signals: {
        coverage: number | null;
        conflict: number | null;
        probability: number | null;
        margin: number | null;
        confidence: number | null;
        reason: string;
    };
    remaining: { timeMs: number; requests: number; actions: number };
}
export interface HostDecision {
    packet: EscalationPacket;
    answer: z.infer<typeof hostChoiceSchema>;
}
export function escalationPacket(options: {
    observation: Observation;
    intent: string;
    candidates: Candidate[];
    signals: EscalationPacket["signals"];
    budget: OperationBudget;
}): EscalationPacket {
    const { observation, intent, candidates, signals, budget } = options;
    const descriptions = candidates.map(({ id, action, role, label, ancestors }) => ({
        id,
        action,
        role,
        label,
        ancestors,
    }));
    const scope = {
        app: observation.app,
        pid: observation.pid,
        windowId: observation.window.id,
        processLaunch: observation.processLaunch,
    };
    const packetId = createHash("sha256")
        .update(
            SafeJSON.stringify({
                scope,
                intent,
                candidates: descriptions,
                semantic: semanticFingerprint(observation),
            })
        )
        .digest("hex");
    const packet: EscalationPacket = {
        version: 1,
        packetId,
        createdAt: Date.now(),
        expiresAt: Date.now() + Math.min(120000, budget.remaining()),
        question: intent,
        scope,
        candidates: descriptions,
        evidence: observedEvidence(observation),
        signals,
        remaining: {
            timeMs: budget.remaining(),
            requests: budget.limits.maxRequests - budget.requests,
            actions: budget.limits.maxActions - budget.actions,
        },
    };
    if (SafeJSON.stringify(packet).length > 32768) {
        throw new Error("Escalation evidence exceeds 32 KB. Narrow the observed scope.");
    }
    return packet;
}
export function acceptHostChoice(options: {
    response: unknown;
    packet: EscalationPacket;
    currentPacket: EscalationPacket;
    now?: number;
}) {
    const response = hostChoiceSchema.parse(options.response);
    const now = options.now ?? Date.now();
    if (
        response.packetId !== options.packet.packetId ||
        response.packetId !== options.currentPacket.packetId ||
        !Number.isFinite(options.packet.createdAt) ||
        !Number.isFinite(options.packet.expiresAt) ||
        options.packet.expiresAt - options.packet.createdAt > 120000 ||
        now < options.packet.createdAt ||
        now > options.packet.expiresAt
    ) {
        throw new Error("Host choice belongs to an expired or changed observation.");
    }
    if (
        response.choice !== null &&
        !options.currentPacket.candidates.some((candidate) => candidate.id === response.choice)
    ) {
        throw new Error("Host returned an unknown candidate ID.");
    }
    if (
        response.evidence.some((id) => !options.currentPacket.evidence.some((item) => item.id === id)) ||
        (response.choice !== null && response.evidence.length === 0)
    ) {
        throw new Error("Host choice requires current observed evidence.");
    }
    return response;
}
export async function chooseCandidate(options: {
    observation: Observation;
    intent: string;
    mode?: ChooserMode;
    action?: Candidate["action"];
    binding?: Binding;
    session: Pick<ControlSession, "budget" | "evaluate">;
    signal?: AbortSignal;
    hostDecision?: HostDecision;
    allowReobserve?: boolean;
}) {
    const intent = z.string().trim().min(1).max(4000).parse(options.intent);
    const mode = chooserModeSchema.parse(options.mode ?? "jev");
    const action = options.action ?? "press";
    const budget = options.session.budget;
    const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
    const clock = new Stopwatch();
    const candidates = candidatesFor({ observation: options.observation, action });
    const exact = options.binding
        ? matchingCandidates(candidates, options.binding)
        : candidates.filter((candidate) => candidate.label.trim().toLocaleLowerCase() === intent.toLocaleLowerCase());
    const base = {
        candidates,
        selected: null as Candidate | null,
        decision: null as Awaited<ReturnType<typeof resolveIntent>>["decision"],
        evaluation: null as Awaited<ReturnType<typeof resolveIntent>>["evaluation"],
        decisionMs: 0,
        source: "exact" as "exact" | "jev" | "host",
        packet: undefined as EscalationPacket | undefined,
        signals: {
            coverage: null,
            conflict: null,
            probability: null,
            margin: null,
            confidence: null,
            reason: "",
        } as EscalationPacket["signals"],
    };
    signal.throwIfAborted();
    if (mode !== "jev" && exact.length === 1) {
        return { ...base, status: "resolved" as const, reason: "unique_exact_binding", selected: exact[0] };
    }
    if (mode === "exact") {
        return {
            ...base,
            status: "abstained" as const,
            reason: exact.length > 1 ? "ambiguous_exact_binding" : "missing_exact_binding",
        };
    }
    const evaluate: Evaluator = async (call) => {
        const input = z
            .object({ questions: z.record(z.string(), z.unknown()) })
            .passthrough()
            .parse(call.input);
        return options.session.evaluate({
            ...call,
            signal,
            timeoutMs: Math.min(30000, budget.remaining()),
            input:
                mode === "auto"
                    ? {
                          ...input,
                          questions: {
                              ...input.questions,
                              coverage: {
                                  type: "boolean",
                                  instructions:
                                      "Does at least one permitted observed candidate directly match the requested action and target? False for missing coverage.",
                              },
                              conflict: {
                                  type: "boolean",
                                  instructions:
                                      "Does visible context contradict acting on the requested target now, such as already-satisfied toggles or a different requested action?",
                              },
                          },
                      }
                    : input,
        });
    };
    const resolution = await resolveIntent({ ...options, intent, action, evaluate, signal });
    const probability = (id: string) => {
        const answer = resolution.evaluation?.answers[id];
        return answer?.type === "boolean" &&
            Number.isFinite(answer.probability) &&
            answer.probability >= 0 &&
            answer.probability <= 1
            ? answer.probability
            : null;
    };
    const signals = {
        coverage: probability("coverage"),
        conflict: probability("conflict"),
        probability: resolution.decision?.probability ?? null,
        margin: resolution.decision?.margin ?? null,
        confidence: resolution.decision?.confidence ?? null,
        reason: resolution.reason,
    };
    const result = { ...base, ...resolution, source: "jev" as const, signals, decisionMs: clock.elapsedMs };
    if (
        mode === "jev" ||
        (resolution.selected &&
            signals.coverage !== null &&
            signals.coverage >= 0.8 &&
            signals.conflict !== null &&
            signals.conflict <= 0.1)
    ) {
        return result;
    }
    const packet = escalationPacket({ observation: options.observation, intent, candidates, signals, budget });
    const escalated = {
        ...result,
        selected: null,
        packet,
        status: "escalated" as const,
        reason: "Host decision required.",
    };
    if (signals.conflict !== null && signals.conflict >= 0.8) {
        return { ...escalated, reason: "Observed conflict requires inspection." };
    }
    if (!options.hostDecision || !candidates.length) {
        return escalated;
    }
    signal.throwIfAborted();
    budget.remaining();
    const admitted = acceptHostChoice({
        response: options.hostDecision.answer,
        packet: options.hostDecision.packet,
        currentPacket: packet,
    });
    const selected = candidates.find((candidate) => candidate.id === admitted.choice) ?? null;
    logger.debug({ selected: selected?.id ?? null }, "Explicit host choice matched fresh observed candidates");
    return {
        ...result,
        packet,
        selected,
        source: "host" as const,
        status: selected ? ("resolved" as const) : ("abstained" as const),
        reason: selected ? "Escalated choice bound to an observed candidate." : "Escalation abstained.",
        decisionMs: clock.elapsedMs,
    };
}

export function readHostDecision(input: unknown): HostDecision {
    const parsed = z
        .object({
            packet: z
                .object({
                    version: z.literal(1),
                    packetId: z.string().regex(/^[a-f0-9]{64}$/),
                    createdAt: z.number().finite(),
                    expiresAt: z.number().finite(),
                    question: z.string().max(4000),
                    scope: z
                        .object({
                            app: z.string(),
                            pid: z.number().int().positive(),
                            windowId: z.number().int().positive(),
                            processLaunch: z.number().optional(),
                        })
                        .strict(),
                    candidates: z
                        .array(
                            z
                                .object({
                                    id: z.string(),
                                    action: z.string(),
                                    role: z.string(),
                                    label: z.string().max(300),
                                    ancestors: z.array(z.string()).max(4),
                                })
                                .strict()
                        )
                        .max(80),
                    evidence: z
                        .array(
                            z
                                .object({
                                    id: z.string(),
                                    role: z.string(),
                                    kind: z.string(),
                                    label: z.string().max(300),
                                    value: z.string().max(500),
                                    enabled: z.boolean(),
                                    checked: z.boolean().optional(),
                                })
                                .strict()
                        )
                        .max(300),
                    signals: z
                        .object({
                            coverage: z.number().nullable(),
                            conflict: z.number().nullable(),
                            probability: z.number().nullable(),
                            margin: z.number().nullable(),
                            confidence: z.number().nullable(),
                            reason: z.string(),
                        })
                        .strict(),
                    remaining: z.object({ timeMs: z.number(), requests: z.number(), actions: z.number() }).strict(),
                })
                .strict(),
            answer: hostChoiceSchema,
        })
        .strict()
        .parse(input);
    if (SafeJSON.stringify(parsed).length > 65536) {
        throw new Error("Host decision exceeds 64 KB.");
    }
    return parsed;
}
