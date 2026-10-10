import { imageInputs } from "@app/question/lib/message";
import { type RecordDeps, recordAnswer } from "@app/question/lib/record";
import type { QaRef, QaTag } from "@app/question/lib/types";
import { SOURCE_MESSAGE_INPUT_SCHEMA, type SourceMessage } from "@genesiscz/utils/agent/source-anchor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { IMAGE_ATTACHMENT_INPUT_SCHEMA, type ImageAttachmentInput } from "@genesiscz/utils/image/attachments";

export interface QuestionAnswerArgs {
    sessionHint?: string;
    projectPath?: string;
    sourceMessage?: SourceMessage;
    question: string;
    answer: string;
    tag: QaTag;
    refs?: QaRef[];
    attachments?: ImageAttachmentInput[];
    /** Plain screenshot paths, the shorthand of `attachments`. */
    images?: string[];
    agentLabel?: string;
}

/** The warning an entry gets when no session could be named, so its card would land under `unknown`. */
export function unknownSessionWarnings(
    context: { sessionId: string; transcriptAnchor?: { kind: string } },
    cli: string
): string[] {
    if (context.sessionId !== "unknown" && context.transcriptAnchor?.kind !== "unanchored") {
        return [];
    }

    return [
        `This gateway could not identify the originating session. Supply its known sessionHint and projectPath, or use ${cli} from the agent's worktree. Do not invent an ID.`,
    ];
}

export async function handleQuestionAnswer(args: QuestionAnswerArgs, deps: RecordDeps = {}) {
    const res = await recordAnswer(
        {
            question: args.question,
            sessionId: args.sessionHint,
            projectPath: args.projectPath,
            sourceMessage: args.sourceMessage,
            answer: args.answer,
            tag: args.tag,
            refs: args.refs,
            attachments: imageInputs({ images: args.images, attachments: args.attachments, cwd: args.projectPath }),
            agentLabel: args.agentLabel,
            source: "mcp",
        },
        deps
    );
    return {
        id: res.id,
        sinks: res.sinks,
        context: res.context,
        warnings: unknownSessionWarnings(res.context, toolCommand("question record")),
        attachments: res.attachments ?? [],
        summary: `Logged Q→A ${res.id} (${args.tag}).`,
    };
}

export const QUESTION_ANSWER_INPUT_SCHEMA = {
    type: "object",
    properties: {
        sourceMessage: SOURCE_MESSAGE_INPUT_SCHEMA,
        sessionHint: {
            type: "string",
            description:
                "Known originating session ID when a multiplexed gateway cannot identify this caller. Omit if unavailable; never infer from a filename.",
        },
        projectPath: {
            type: "string",
            description:
                "Absolute source worktree directory when the gateway's process cwd is not the agent's working directory.",
        },
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
        attachments: IMAGE_ATTACHMENT_INPUT_SCHEMA,
        images: {
            type: "array",
            maxItems: 24,
            description: "shorthand for attachments: local PNG/JPEG/WebP screenshot paths",
            items: { type: "string" },
        },
        agentLabel: { type: "string", description: "if you are a subagent, your role/task label" },
    },
    required: ["question", "answer", "tag"],
} as const;
