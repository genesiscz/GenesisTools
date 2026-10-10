import { messageNote } from "@app/question/lib/inbox-guidance";
import { sendInboxMessage } from "@app/question/lib/message";
import type { RecordDeps } from "@app/question/lib/record";
import type { QaRef } from "@app/question/lib/types";
import { SOURCE_MESSAGE_INPUT_SCHEMA, type SourceMessage } from "@genesiscz/utils/agent/source-anchor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { IMAGE_ATTACHMENT_INPUT_SCHEMA, type ImageAttachmentInput } from "@genesiscz/utils/image/attachments";
import { type NativeInboxState, nativeInboxState } from "@genesiscz/utils/macos/native-inbox";
import { unknownSessionWarnings } from "./question-answer";

export interface InboxSendArgs {
    text?: string;
    title?: string;
    images?: string[];
    attachments?: ImageAttachmentInput[];
    refs?: QaRef[];
    sessionHint?: string;
    projectPath?: string;
    sourceMessage?: SourceMessage;
    agentLabel?: string;
}

export async function handleInboxSend(args: InboxSendArgs, deps: RecordDeps & { inboxState?: NativeInboxState } = {}) {
    const res = await sendInboxMessage(
        {
            text: args.text ?? "",
            title: args.title,
            images: args.images,
            attachments: args.attachments,
            refs: args.refs,
            sessionHint: args.sessionHint,
            projectPath: args.projectPath,
            sourceMessage: args.sourceMessage,
            agentLabel: args.agentLabel,
            source: "mcp",
        },
        deps
    );

    return {
        id: res.id,
        context: res.context,
        attachments: res.attachments ?? [],
        warnings: unknownSessionWarnings(res.context, toolCommand("question message")),
        summary: `Sent message ${res.id} to session ${res.context.sessionId}. ${messageNote(deps.inboxState ?? nativeInboxState())}`,
    };
}

export const INBOX_SEND_INPUT_SCHEMA = {
    type: "object",
    properties: {
        text: { type: "string", description: "the message, markdown ok. May be omitted when images are given." },
        title: { type: "string", description: "short card title; defaults to the first line of text" },
        images: {
            type: "array",
            maxItems: 24,
            description: "local PNG/JPEG/WebP screenshot paths (absolute, or relative to projectPath)",
            items: { type: "string" },
        },
        attachments: IMAGE_ATTACHMENT_INPUT_SCHEMA,
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
        agentLabel: { type: "string", description: "if you are a subagent, your role/task label" },
    },
} as const;
