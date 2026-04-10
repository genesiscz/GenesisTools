import type { AgentContentBlock, AgentMessage, AgentRole } from "../types";
import { formatToolDiff, formatToolResult, formatToolSignature } from "./tool-formatter";
import type { BlockMeta, FormatOptions, FormattedBlock } from "./types";

// ─── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_INPUT_MAX_CHARS = 200;
const DEFAULT_OUTPUT_MAX_CHARS = 500;

// ─── Helpers ──────────────────────────────────────────────────────────────

function toMetaRole(role: AgentRole): BlockMeta["role"] {
    if (role === "user" || role === "assistant" || role === "system") {
        return role;
    }

    return undefined;
}

// ─── Block Mappers ────────────────────────────────────────────────────────

function blockToFormatted(block: AgentContentBlock, role: AgentRole, options: FormatOptions): FormattedBlock[] {
    const detailLevel = options.toolDetailLevel ?? "signature";
    const inputMax = options.toolInputMaxChars ?? DEFAULT_INPUT_MAX_CHARS;
    const outputMax = options.toolOutputMaxChars ?? DEFAULT_OUTPUT_MAX_CHARS;
    const metaRole = toMetaRole(role);

    switch (block.type) {
        case "text":
            return [{ type: "text", content: block.text, meta: { role: metaRole } }];

        case "thinking": {
            if (!options.showThinking) {
                return [];
            }

            return [{ type: "thinking", content: block.text }];
        }

        case "tool_call": {
            const signature = formatToolSignature(block.name, block.input, {
                primaryMaxChars: inputMax,
                detailLevel,
            });

            const blocks: FormattedBlock[] = [
                {
                    type: "tool-signature",
                    content: signature,
                    meta: { toolName: block.name },
                },
            ];

            if (detailLevel === "full") {
                const diffLines = formatToolDiff(block.name, block.input, inputMax);

                if (diffLines) {
                    blocks.push({
                        type: "tool-diff",
                        content: diffLines[0],
                        lines: diffLines,
                        meta: { toolName: block.name },
                    });
                }
            }

            return blocks;
        }

        case "tool_result": {
            const result = formatToolResult(block.content, outputMax, {
                isError: block.isError,
            });

            return [
                {
                    type: "tool-result",
                    content: result,
                    meta: { isError: block.isError },
                },
            ];
        }

        case "image":
            return [
                {
                    type: "image",
                    content: `[image: ${block.mediaType}]`,
                },
            ];

        case "agent_notification":
            return [
                {
                    type: "agent-notification",
                    content: block.summary,
                    meta: { agentId: block.agentId, status: block.status },
                },
            ];
    }
}

// ─── Public API ───────────────────────────────────────────────────────────

export function messageToBlocks(msg: AgentMessage, options: FormatOptions): FormattedBlock[] {
    const result: FormattedBlock[] = [];

    if (options.showRoleHeaders) {
        result.push({
            type: "role-header",
            content: msg.role,
            meta: {
                role: toMetaRole(msg.role),
                timestamp: msg.timestamp,
                model: msg.model,
            },
        });
    }

    for (const block of msg.blocks) {
        const formatted = blockToFormatted(block, msg.role, options);
        result.push(...formatted);
    }

    return result;
}

export function conversationToBlocks(messages: AgentMessage[], options: FormatOptions): FormattedBlock[] {
    return messages.flatMap((msg) => messageToBlocks(msg, options));
}
