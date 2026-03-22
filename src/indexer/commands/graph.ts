import { SafeJSON } from "@app/utils/json";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { buildCodeGraph, getGraphStats, toMermaidDiagram } from "../lib/code-graph";
import type { CodeGraph } from "../lib/code-graph";
import { IndexerManager } from "../lib/manager";

export function registerGraphCommand(program: Command): void {
    program
        .command("graph")
        .description("Show code dependency graph for an index")
        .argument("<name>", "Index name")
        .option("--format <format>", "Output format: mermaid | stats | json", "stats")
        .option("--max-nodes <n>", "Max nodes in Mermaid diagram", "30")
        .option("--file <path>", "Show dependencies for a specific file")
        .action(async (name: string, opts: { format: string; maxNodes: string; file?: string }) => {
            const manager = await IndexerManager.load();

            try {
                const indexer = await manager.getIndex(name);
                const store = indexer.getStore();
                const config = indexer.getConfig();
                const meta = store.getMeta();

                // Try loading cached graph first
                let graph: CodeGraph;
                const cached = store.loadCodeGraph();
                const lastSync = meta.lastSyncAt ?? 0;

                if (cached && cached.builtAt >= lastSync) {
                    p.log.info("Using cached graph");
                    graph = SafeJSON.parse(cached.graphJson) as CodeGraph;
                } else {
                    p.log.step("Building code graph...");
                    const startTime = performance.now();
                    const fileContents = store.getAllFileContents();
                    graph = buildCodeGraph(fileContents, config.baseDir);
                    const buildMs = performance.now() - startTime;
                    p.log.info(`Graph built in ${Math.round(buildMs)}ms`);

                    // Persist for next time
                    store.saveCodeGraph(SafeJSON.stringify(graph), graph.builtAt);
                }

                if (opts.file) {
                    showFileDependencies(graph, opts.file);
                    return;
                }

                switch (opts.format) {
                    case "mermaid":
                        console.log(toMermaidDiagram(graph, { maxNodes: parseInt(opts.maxNodes, 10) }));
                        break;

                    case "json":
                        console.log(SafeJSON.stringify(graph));
                        break;

                    default:
                        showGraphStats(graph);
                        break;
                }
            } finally {
                await manager.close();
            }
        });
}

function showGraphStats(graph: ReturnType<typeof buildCodeGraph>): void {
    const stats = getGraphStats(graph);

    const entries: Array<[string, string]> = [
        ["Total nodes", String(stats.totalNodes)],
        ["Total edges", String(stats.totalEdges)],
        ["Avg imports/file", String(stats.avgImports)],
        ["Orphan files", String(stats.orphanCount)],
    ];

    if (stats.maxImporter) {
        entries.push(["Most imports", `${stats.maxImporter.path} (${stats.maxImporter.count})`]);
    }

    if (stats.maxImported) {
        entries.push(["Most imported", `${stats.maxImported.path} (${stats.maxImported.count})`]);
    }

    if (stats.circularDependencies) {
        entries.push(["Circular deps", String(stats.circularDependencies)]);
    }

    for (const [label, value] of entries) {
        p.log.step(`${pc.bold(label)}: ${value}`);
    }

    // Top 10 most-connected files
    const ranked = [...graph.nodes]
        .sort((a, b) => b.importCount + b.importedByCount - (a.importCount + a.importedByCount))
        .slice(0, 10);

    if (ranked.length > 0) {
        console.log("");
        p.log.step(pc.bold("Top connected files:"));

        const rows = ranked.map((n) => [n.path, String(n.importCount), String(n.importedByCount), n.language]);

        console.log(formatTable(rows, ["File", "Imports", "Imported By", "Language"], { alignRight: [1, 2] }));
    }
}

function showFileDependencies(graph: ReturnType<typeof buildCodeGraph>, filePath: string): void {
    const node = graph.nodes.find((n) => n.path === filePath || n.path.endsWith(filePath));

    if (!node) {
        p.log.error(`File "${filePath}" not found in graph`);
        return;
    }

    p.log.step(`${pc.bold("File")}: ${node.path}`);
    p.log.step(`${pc.bold("Language")}: ${node.language}`);

    const outgoing = graph.edges.filter((e) => e.from === node.path);
    const incoming = graph.edges.filter((e) => e.to === node.path);

    if (outgoing.length > 0) {
        p.log.step(pc.bold(`Imports (${outgoing.length}):`));

        for (const edge of outgoing) {
            const label = edge.isDynamic ? pc.dim(" (dynamic)") : "";
            p.log.step(`  -> ${edge.to}${label}`);
        }
    }

    if (incoming.length > 0) {
        p.log.step(pc.bold(`Imported by (${incoming.length}):`));

        for (const edge of incoming) {
            p.log.step(`  <- ${edge.from}`);
        }
    }

    if (outgoing.length === 0 && incoming.length === 0) {
        p.log.info("This file has no dependencies and is not imported by any other file.");
    }
}
