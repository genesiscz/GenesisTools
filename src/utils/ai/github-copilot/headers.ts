/**
 * VS Code Copilot Chat identity headers.
 * Update from: https://github.com/microsoft/vscode-copilot-chat
 *   - src/platform/env/common/envService.ts (Editor-Version, Editor-Plugin-Version)
 *   - src/platform/networking/vscode-node/fetcherServiceImpl.ts (Copilot-Integration-Id)
 * Playground reference: pi-mono/packages/ai/src/providers/github-copilot-headers.ts
 */

export const COPILOT_STATIC_HEADERS = {
    "Copilot-Integration-Id": "vscode-chat",
    "User-Agent": "GitHubCopilotChat/0.52.0",
    "Editor-Version": "vscode/1.96.0",
    "Editor-Plugin-Version": "copilot-chat/0.52.0",
    "Openai-Organization": "github-copilot",
    "openai-intent": "conversation-agent",
    "x-github-api-version": "2026-06-01",
    "x-interaction-type": "conversation-agent",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function containsToolResult(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some((item) => containsToolResult(item));
    }

    if (!isRecord(value)) {
        return false;
    }

    if (value.type === "tool_result") {
        return true;
    }

    return containsToolResult(value.content);
}

export function inferCopilotInitiator(messages: unknown[]): "user" | "agent" {
    const last = messages[messages.length - 1];

    if (!isRecord(last)) {
        return "user";
    }

    if (last.role === "user" && containsToolResult(last.content)) {
        return "agent";
    }

    return last.role === "user" ? "user" : "agent";
}

export function hasCopilotVisionInput(messages: unknown[]): boolean {
    return messages.some((message) => {
        if (!isRecord(message) || !Array.isArray(message.content)) {
            return false;
        }

        return message.content.some((part) => {
            if (!isRecord(part)) {
                return false;
            }

            if (part.type === "image" || part.type === "image_url") {
                return true;
            }

            return isRecord(part.source) && part.source.type === "base64";
        });
    });
}

export function buildCopilotRequestHeaders(messages: unknown[]): Record<string, string> {
    const headers: Record<string, string> = {
        ...COPILOT_STATIC_HEADERS,
        "x-initiator": inferCopilotInitiator(messages),
    };

    if (hasCopilotVisionInput(messages)) {
        headers["Copilot-Vision-Request"] = "true";
    }

    return headers;
}
