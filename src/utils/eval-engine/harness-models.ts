// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/harness-models.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * The judge and the simulated user: their prompts, the stop word and the answer parser. Builds requests; the
 * conversation sends them through the project's `complete`.
 */
import { z } from "zod";
import type { SimulatedStep } from "./document";
import type { JudgeRequest, Result, TranscriptLine } from "./evaluate";
import type { CompletionRequest } from "./system";

/** Bumped when the judge prompt or its answer format changes. `compare` leaves out judge expectations across a change. */
export const JudgePromptVersion = 1;
/** Bumped when the simulated user's prompt or its stop rule changes. Stored in the manifest. */
export const SimulatorPromptVersion = 1;
export const SimulatorStopWord = "###STOP###";

const JudgeMaxOutputTokens = 400;
const SimulatorMaxOutputTokens = 300;

function renderTranscript(lines: readonly TranscriptLine[]): string {
    return lines
        .map((line) => {
            const head = `${line.role === "user" ? "USER" : "ASSISTANT"}: ${line.text}`;
            const calls = line.toolCalls.map(
                (call) =>
                    `  [tool call] ${call.name} ${JSON.stringify(call.input)}${call.output !== undefined ? ` -> ${JSON.stringify(call.output)}` : ""}${call.error ? ` (error: ${call.error})` : ""}`
            );
            return [head, ...calls].join("\n");
        })
        .join("\n\n");
}

const JudgeSystem = [
    "You check one statement about a conversation between a user and an AI assistant.",
    "You see every message and every tool call the assistant made, with its input and output.",
    "Tool calls are the evidence of what the assistant did. When the assistant's text claims something the tool calls do not show, trust the tool calls.",
    "Judge only the statement you are given. Do not judge style unless the statement asks about it.",
    'Answer with ONE line of JSON and nothing else: {"answer":"yes"|"no"|"cannot-tell","reason":"one short sentence"}.',
    'Use "cannot-tell" only when the conversation does not hold enough information to decide.',
].join("\n");

/** The judge's request for one question. The last turn of the transcript is the turn in question. */
export function buildJudgeRequest(request: JudgeRequest, model: string): Omit<CompletionRequest, "signal"> {
    const where =
        request.scope.kind === "turn"
            ? `The statement is about the assistant's LAST reply (turn ${request.scope.turn}).`
            : "The statement is about the whole conversation.";
    return {
        purpose: "judge",
        model,
        system: JudgeSystem,
        messages: [
            {
                role: "user",
                content: `<conversation>\n${renderTranscript(request.scope.transcript)}\n</conversation>\n\n${where}\n\nStatement: ${request.question}\n\nIs the statement true?`,
            },
        ],
        maxOutputTokens: JudgeMaxOutputTokens,
    };
}

const JudgeAnswerSchema = z.object({ answer: z.enum(["yes", "no", "cannot-tell"]), reason: z.string() });
const AnswerResults: Record<z.infer<typeof JudgeAnswerSchema>["answer"], Result> = {
    yes: "pass",
    no: "fail",
    "cannot-tell": "inconclusive",
};

/** The first JSON object in the text, as the judge's answer; null when there is none or it is malformed. */
export function parseJudgeAnswer(text: string): { result: Result; reason: string } | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
        return null;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
    const parsed = JudgeAnswerSchema.safeParse(raw);
    if (!parsed.success) {
        return null;
    }
    return {
        result: AnswerResults[parsed.data.answer],
        reason: parsed.data.reason.trim() || "the judge gave no reason",
    };
}

/**
 * The simulated user's request: persona, goal, the conversation so far with the roles swapped (the assistant's
 * replies are the simulator's "user" messages), and the rule to write one short message, or the stop word alone.
 */
export function buildSimulatorRequest(
    simulate: SimulatedStep["simulate"],
    transcript: readonly TranscriptLine[],
    model: string
): Omit<CompletionRequest, "signal"> {
    const system = [
        simulate.persona,
        `Your goal: ${simulate.goal}`,
        "You are the USER in a chat with an assistant. Write the user's next message only: short, natural, in the language the conversation uses.",
        "Never write the assistant's part, never explain yourself, never mention that you are simulated.",
        `When the goal is reached, or clearly cannot be reached, answer with ${SimulatorStopWord} alone.`,
    ].join("\n");
    const messages: CompletionRequest["messages"] = [
        { role: "user", content: "(The chat starts. Write your first message.)" },
    ];
    for (const line of transcript) {
        messages.push({ role: line.role === "user" ? "assistant" : "user", content: line.text || "(no answer)" });
    }
    return { purpose: "simulator", model, system, messages, maxOutputTokens: SimulatorMaxOutputTokens };
}

/** The simulator's text as the next user message, or "stop". */
export function readSimulatorText(text: string): { stop: true } | { stop: false; text: string } {
    const trimmed = text.trim();
    if (!trimmed || trimmed.includes(SimulatorStopWord)) {
        return { stop: true };
    }
    return { stop: false, text: trimmed };
}
