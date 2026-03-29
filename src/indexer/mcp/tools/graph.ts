import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildCodeGraph, getGraphStats, toMermaidDiagram } from "../../lib/code-graph";
import { formatError, getManager } from "../shared";

export function registerGraphTools(server: McpServer): void {
    server.tool(
        "indexer_graph_build",
        "Build a code dependency graph using static import analysis. The index must already exist.",
        {
            name: z.string().describe("Index name."),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleGraphBuild(args) }],
        })
    );

    server.tool(
        "indexer_graph_query",
        "Query the dependency graph for a specific file. Shows what the file imports and what files depend on it.",
        {
            name: z.string().describe("Index name."),
            file: z.string().describe("File path (relative to index base dir) to query."),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleGraphQuery(args) }],
        })
    );

    server.tool(
        "indexer_graph_stats",
        "Get statistics about the code dependency graph: total files, edges, most connected files, orphans.",
        {
            name: z.string().describe("Index name."),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleGraphStats(args) }],
        })
    );

    server.tool(
        "indexer_graph_visualize",
        "Generate a Mermaid diagram of the code dependency graph. Shows the top N most-connected files.",
        {
            name: z.string().describe("Index name."),
            maxNodes: z.number().min(5).max(200).describe("Max nodes in diagram. Default: 30.").optional(),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleGraphVisualize(args) }],
        })
    );
}

/** Build graph from the index store's file contents. */
async function buildGraphFromIndex(name: string) {
    const manager = await getManager();
    const indexer = await manager.getIndex(name);
    const store = indexer.getStore();
    const config = indexer.getConfig();

    const fileContents = store.getAllFileContents();

    if (fileContents.size === 0) {
        return null;
    }

    return await buildCodeGraph(fileContents, config.baseDir);
}

async function handleGraphBuild(args: { name: string }): Promise<string> {
    try {
        const start = performance.now();
        const graph = await buildGraphFromIndex(args.name);

        if (!graph) {
            return `Index "${args.name}" has no file content. Ensure it has been synced with indexer_sync.`;
        }

        const durationMs = performance.now() - start;
        const stats = getGraphStats(graph);

        return [
            `Code graph built for "${args.name}" in ${(durationMs / 1000).toFixed(1)}s.`,
            `  Files: ${stats.totalNodes}`,
            `  Edges: ${stats.totalEdges}`,
            `  Avg imports/file: ${stats.avgImports}`,
            `  Orphan files: ${stats.orphanCount}`,
        ].join("\n");
    } catch (err) {
        return formatError("indexer_graph_build", err);
    }
}

async function handleGraphQuery(args: { name: string; file: string }): Promise<string> {
    try {
        const graph = await buildGraphFromIndex(args.name);

        if (!graph) {
            return `No graph data for "${args.name}". Ensure the index has content.`;
        }

        const node = graph.nodes.find((n) => n.path === args.file || n.path.endsWith(args.file));

        if (!node) {
            return `File "${args.file}" not found in graph. Make sure the path is relative to the index base dir.`;
        }

        const imports = graph.edges.filter((e) => e.from === node.path);
        const importedBy = graph.edges.filter((e) => e.to === node.path);

        const lines = [`Dependencies for: ${node.path} (${node.language})\n`];

        if (imports.length > 0) {
            lines.push(`Imports (${imports.length}):`);

            for (const e of imports) {
                const tag = e.isDynamic ? " (dynamic)" : "";
                lines.push(`  -> ${e.to}${tag}`);
            }
        }

        if (importedBy.length > 0) {
            lines.push(`\nImported by (${importedBy.length}):`);

            for (const e of importedBy) {
                lines.push(`  <- ${e.from}`);
            }
        }

        if (imports.length === 0 && importedBy.length === 0) {
            lines.push("No dependency connections found for this file.");
        }

        return lines.join("\n");
    } catch (err) {
        return formatError("indexer_graph_query", err);
    }
}

async function handleGraphStats(args: { name: string }): Promise<string> {
    try {
        const graph = await buildGraphFromIndex(args.name);

        if (!graph) {
            return `No graph data for "${args.name}". Ensure the index has content.`;
        }

        const stats = getGraphStats(graph);

        const lines = [
            `Code Graph Statistics for "${args.name}":\n`,
            `Total files: ${stats.totalNodes}`,
            `Total edges: ${stats.totalEdges}`,
            `Avg imports/file: ${stats.avgImports}`,
            `Orphan files: ${stats.orphanCount}`,
        ];

        if (stats.maxImporter) {
            lines.push(`Most imports: ${stats.maxImporter.path} (${stats.maxImporter.count})`);
        }

        if (stats.maxImported) {
            lines.push(`Most imported: ${stats.maxImported.path} (${stats.maxImported.count})`);
        }

        if (stats.circularDependencies) {
            lines.push(`Circular dependencies: ${stats.circularDependencies}`);
        }

        return lines.join("\n");
    } catch (err) {
        return formatError("indexer_graph_stats", err);
    }
}

async function handleGraphVisualize(args: { name: string; maxNodes?: number }): Promise<string> {
    try {
        const graph = await buildGraphFromIndex(args.name);

        if (!graph) {
            return `No graph data for "${args.name}". Ensure the index has content.`;
        }

        const mermaid = toMermaidDiagram(graph, { maxNodes: args.maxNodes ?? 30 });

        return [
            `Dependency graph for "${args.name}" (${graph.nodes.length} files, ${graph.edges.length} edges):`,
            "",
            "```mermaid",
            mermaid,
            "```",
        ].join("\n");
    } catch (err) {
        return formatError("indexer_graph_visualize", err);
    }
}
