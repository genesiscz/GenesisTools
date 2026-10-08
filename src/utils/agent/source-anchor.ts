import { z } from "zod";
import type { AgentRuntimeContext } from "./context";

const sourceId = z.string().trim().min(1).max(512);
export const sourceMessageSchema = z
    .object({ messageId: sourceId.optional(), turnId: sourceId.optional(), toolCallId: sourceId.optional() })
    .strict()
    .refine(
        (value) => Boolean(value.messageId || value.turnId || value.toolCallId),
        "Provide at least one native source ID"
    );
export type SourceMessage = z.infer<typeof sourceMessageSchema>;

const identity = {
    provider: z.enum(["claude", "codex", "grok", "copilot"]),
    sessionId: sourceId,
    receivedAt: z.number().finite().nonnegative(),
};
export const transcriptAnchorSchema = z.discriminatedUnion("kind", [
    z
        .object({
            kind: z.literal("native"),
            ...identity,
            messageId: sourceId.optional(),
            turnId: sourceId.optional(),
            toolCallId: sourceId.optional(),
        })
        .refine(
            (value) => Boolean(value.messageId || value.turnId || value.toolCallId),
            "Native anchors need a source ID"
        ),
    z.object({ kind: z.literal("receipt-time"), ...identity }),
    z.object({ kind: z.literal("unanchored"), receivedAt: z.number().finite().nonnegative() }),
]);
export type TranscriptAnchor = z.infer<typeof transcriptAnchorSchema>;

export const SOURCE_MESSAGE_INPUT_SCHEMA = {
    type: "object",
    description:
        "Only native IDs actually supplied by your harness. Omit when unavailable; receipt-time context is automatic. Never invent IDs from an ordinal or timestamp.",
    properties: {
        messageId: { type: "string", minLength: 1, maxLength: 512 },
        turnId: { type: "string", minLength: 1, maxLength: 512 },
        toolCallId: { type: "string", minLength: 1, maxLength: 512 },
    },
    anyOf: [{ required: ["messageId"] }, { required: ["turnId"] }, { required: ["toolCallId"] }],
    additionalProperties: false,
} as const;

/** No transcript reads or invented identifiers on the publishing path. */
export function createTranscriptAnchor({
    context,
    receivedAt,
    sourceMessage = context.sourceMessage,
}: {
    context: Pick<AgentRuntimeContext, "agent" | "sessionId" | "sourceMessage">;
    receivedAt: number;
    sourceMessage?: SourceMessage;
}): TranscriptAnchor {
    const source = sourceMessage === undefined ? undefined : sourceMessageSchema.parse(sourceMessage);
    const provider = context.agent === "claude-code" ? "claude" : context.agent;
    const sessionId = context.sessionId?.trim();
    if (!["claude", "codex", "grok", "copilot"].includes(provider) || !sessionId || sessionId === "unknown") {
        if (source) {
            throw new Error("Native source IDs require an identified provider and session.");
        }
        return transcriptAnchorSchema.parse({ kind: "unanchored", receivedAt });
    }
    return transcriptAnchorSchema.parse({
        kind: source ? "native" : "receipt-time",
        provider,
        sessionId,
        receivedAt,
        ...source,
    });
}
