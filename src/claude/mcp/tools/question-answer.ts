import { type RecordDeps, recordAnswer } from "@app/question/lib/record";
import type { QaRef, QaTag } from "@app/question/lib/types";

export interface QuestionAnswerArgs {
    question: string;
    answer: string;
    tag: QaTag;
    refs?: QaRef[];
    agentLabel?: string;
}

export async function handleQuestionAnswer(args: QuestionAnswerArgs, deps: RecordDeps = {}) {
    const res = await recordAnswer(
        {
            question: args.question,
            answer: args.answer,
            tag: args.tag,
            refs: args.refs,
            agentLabel: args.agentLabel,
            source: "mcp",
        },
        deps
    );
    return { id: res.id, sinks: res.sinks, summary: `Logged Q→A ${res.id} (${args.tag}).` };
}

export const QUESTION_ANSWER_INPUT_SCHEMA = {
    type: "object",
    properties: {
        question: { type: "string", description: "the user's question, verbatim or lightly cleaned" },
        answer: { type: "string", description: "your complete answer in markdown (rationale, links, refs)" },
        tag: { type: "string", enum: ["question", "action", "directive"] },
        refs: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    type: { type: "string", enum: ["commit", "file", "url", "plan"] },
                    value: { type: "string" },
                },
                required: ["type", "value"],
            },
        },
        agentLabel: { type: "string", description: "if you are a subagent, your role/task label" },
    },
    required: ["question", "answer", "tag"],
} as const;
