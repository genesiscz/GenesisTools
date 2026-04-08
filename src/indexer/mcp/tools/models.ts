import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getModelsForType, MODEL_REGISTRY } from "../../lib/model-registry";

export function registerModelsTools(server: McpServer): void {
    server.tool(
        "indexer_models",
        "List available embedding models. Optionally filter by index type to see best recommendations.",
        {
            type: z
                .enum(["code", "files", "mail", "chat"])
                .describe("Filter models by index type. Best matches listed first.")
                .optional(),
        },
        async (args) => ({
            content: [{ type: "text", text: handleModels(args) }],
        })
    );
}

function handleModels(args: { type?: "code" | "files" | "mail" | "chat" }): string {
    const models = args.type ? getModelsForType(args.type) : MODEL_REGISTRY;

    const lines = [
        args.type
            ? `Embedding models for "${args.type}" indexes (best matches first):\n`
            : `All available embedding models:\n`,
    ];

    for (const m of models) {
        let runtime: string;

        if (m.provider === "cloud" || m.provider === "google") {
            runtime = "cloud";
        } else if (m.provider === "darwinkit" || m.provider === "coreml") {
            runtime = "built-in";
        } else {
            runtime = m.ramGB > 0 ? `${m.ramGB}GB RAM` : "local";
        }

        lines.push(`  ${m.id} — ${m.name} (${m.params}, ${m.dimensions}-dim, ${m.speed}, ${runtime})`);
        lines.push(`    ${m.description}`);
        lines.push(`    Best for: ${(m.bestFor ?? []).join(", ")}`);
        lines.push("");
    }

    lines.push("Use with indexer_index: indexer_index({ path: '/path', provider: '<provider>', model: '<model-id>' })");

    return lines.join("\n");
}
