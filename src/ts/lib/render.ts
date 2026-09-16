import { out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import pc from "picocolors";
import type { BarrelWaste } from "./barrels";
import type { ImportCycle } from "./cycles";
import { startupEdges } from "./graph";
import type { LazyCandidate } from "./lazy";
import type { AnalysisResult, AnalyzedModule, Finding, ImportGraph } from "./types";

export interface RenderAnalysisOptions {
    graph: ImportGraph;
    /** Hide tree rows whose total is below this. */
    minMs: number;
    /** Tree depth limit. */
    depth: number;
    /** Rows in the "heaviest modules" table. */
    top: number;
    /** Self time at or above which a module gets a "Why" paragraph even with only low findings. */
    slowMs: number;
}

export function fmtMs(ms: number): string {
    if (ms >= 100) {
        return `${ms.toFixed(0)} ms`;
    }

    if (ms >= 10) {
        return `${ms.toFixed(1)} ms`;
    }

    return `${ms.toFixed(2)} ms`;
}

function heat(ms: number, scale: number): (text: string) => string {
    if (scale <= 0) {
        return pc.white;
    }

    const share = ms / scale;

    if (share >= 0.25) {
        return pc.red;
    }

    if (share >= 0.08) {
        return pc.yellow;
    }

    return pc.white;
}

function severityDot(severity: Finding["severity"]): string {
    if (severity === "high") {
        return formatDotStatus("err", "");
    }

    if (severity === "medium") {
        return formatDotStatus("warn", "");
    }

    return formatDotStatus("dim", "");
}

function shortWhy(module: AnalyzedModule): string {
    const finding = module.findings[0];

    if (!finding) {
        return pc.dim("—");
    }

    const label: Record<Finding["kind"], string> = {
        "native-addon": "native addon",
        "top-level-await": "top-level await",
        "side-effects": "module-scope work",
        "large-subtree": `${module.descendants} modules under it`,
        barrel: "barrel",
        "unused-reexports": "unused re-exports",
        "exits-on-import": "exits on import",
        "import-error": "import failed",
        cycle: module.cycle?.paidBy === module.label ? "carries an import cycle" : "in an import cycle",
    };
    const rest = module.findings.length > 1 ? pc.dim(` +${module.findings.length - 1}`) : "";
    return `${label[finding.kind]}${rest}`;
}

function kindCell(module: AnalyzedModule): string {
    if (module.kind === "package") {
        return pc.magenta("pkg");
    }

    if (module.kind === "asset") {
        return pc.dim("asset");
    }

    if (module.kind === "builtin") {
        return pc.dim("builtin");
    }

    return "file";
}

function renderTree(result: AnalysisResult, graph: ImportGraph, options: RenderAnalysisOptions): void {
    const byId = new Map(result.modules.map((module) => [module.label, module]));
    const idToLabel = (id: string) => graph.nodes.get(id)?.label ?? id;
    const shown = new Set<string>();
    const printed = new Set<string>();
    let hidden = 0;

    const lines: string[] = [];
    const scale = result.coldMs > 0 ? result.coldMs : result.sumSelfMs;
    const lazyTargets = new Set<string>();

    for (const list of graph.edges.values()) {
        for (const edge of list) {
            if (edge.site.kind === "dynamic") {
                lazyTargets.add(edge.to);
            }
        }
    }

    function walk(id: string, prefix: string, isLast: boolean, depth: number): void {
        const label = idToLabel(id);
        const module = byId.get(label);

        if (!module) {
            return;
        }

        const branch = depth === 0 ? "" : `${prefix}${isLast ? "└─ " : "├─ "}`;
        const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
        const colour = heat(module.selfMs, scale);
        const timing = `${pc.dim("total")} ${colour(fmtMs(module.totalMs).padStart(9))}  ${pc.dim("self")} ${colour(fmtMs(module.selfMs).padStart(9))}`;
        const name = module.kind === "package" ? pc.magenta(label) : label;
        const cycleMark = module.cycle ? pc.cyan(" ⇄") : "";
        const lazyMark = lazyTargets.has(id) ? pc.dim(" (lazy)") : "";
        const tail = module.importError ? pc.red(`  ${module.importError}`) : "";
        lines.push(`${branch}${name}${cycleMark}${lazyMark}  ${timing}${tail}`);
        printed.add(id);

        if (depth >= options.depth) {
            return;
        }

        shown.add(id);
        const children = startupEdges(graph, id)
            .map((edge) => edge.to)
            .filter((child, index, all) => all.indexOf(child) === index)
            .map((child) => ({ id: child, total: byId.get(idToLabel(child))?.totalMs ?? 0 }))
            .sort((a, b) => b.total - a.total);
        const aboveBar = children.filter((child) => child.total >= options.minMs);
        hidden += children.length - aboveBar.length;
        // A module already expanded higher up is not expanded again: one dim line per parent
        // names them, so a wide graph with one shared logger does not repeat its subtree. A
        // module only ever printed at the depth limit still gets its one expansion when it shows
        // up shallower.
        const isShared = (child: string) => shown.has(child) || (printed.has(child) && depth + 1 >= options.depth);
        const fresh = aboveBar.filter((child) => !isShared(child.id));
        const shared = aboveBar.filter((child) => isShared(child.id));

        fresh.forEach((child, index) => {
            walk(child.id, childPrefix, index === fresh.length - 1 && shared.length === 0, depth + 1);
        });

        if (shared.length > 0) {
            const names = shared.map((child) => idToLabel(child.id));
            const listed = names.slice(0, 4).join(", ");
            const more = names.length > 4 ? ` +${names.length - 4}` : "";
            lines.push(pc.dim(`${childPrefix}└─ (shared, shown above: ${listed}${more})`));
        }
    }

    walk(graph.entry, "", true, 0);
    renderCliSection("Import tree (children sorted by total, hottest first)");

    for (const line of lines) {
        out.println(line);
    }

    if (hidden > 0) {
        out.println(pc.dim(`  ${hidden} edges below ${fmtMs(options.minMs)} hidden (--min-ms 0 shows all)`));
    }

    if (result.modules.some((module) => module.cycle)) {
        out.println(
            pc.dim("  ⇄ marks a module inside an import cycle: the whole cycle evaluates when its first member is")
        );
        out.println(
            pc.dim("    imported, so that member's self time is the cycle's and the rest read near zero (see `cycles`)")
        );
    }

    if (!graph.includeDynamic) {
        const dynamic: string[] = [];

        for (const list of graph.edges.values()) {
            for (const edge of list) {
                if (edge.site.kind === "dynamic") {
                    const from = graph.nodes.get(edge.from)?.label ?? edge.from;
                    dynamic.push(`${from}:${edge.site.line} → ${graph.nodes.get(edge.to)?.label ?? edge.to}`);
                }
            }
        }

        if (dynamic.length > 0) {
            renderCliSection(`Dynamic imports, not on the startup path (${dynamic.length})`);

            for (const line of dynamic.slice(0, 12)) {
                out.println(`  ${pc.dim(line)}`);
            }

            if (dynamic.length > 12) {
                out.println(pc.dim(`  +${dynamic.length - 12} more`));
            }

            out.println(pc.dim("  --include-dynamic walks and measures them too, marked (lazy) in the tree"));
        }
    }
}

export function renderAnalysis(result: AnalysisResult, options: RenderAnalysisOptions): void {
    const measured = result.modules.filter((module) => module.measured);
    const packages = measured.filter((module) => module.kind === "package").length;
    renderCliHeader(`tools ts imports analyze`, result.entry);
    const selfLabel = options.graph.includeDynamic ? "sum of self (lazy included)" : "sum of self";
    out.println(
        `  ${pc.dim("cold import")} ${pc.bold(fmtMs(result.coldMs))}   ${pc.dim(selfLabel)} ${fmtMs(result.sumSelfMs)}   ` +
            `${pc.dim("modules")} ${measured.length} ${pc.dim(`(${packages} packages)`)}   ${pc.dim("runs")} ${result.runs}, min kept`
    );

    if (
        !options.graph.includeDynamic &&
        result.coldMs > 0 &&
        Math.abs(result.coldMs - result.sumSelfMs) > Math.max(2, result.coldMs * 0.15)
    ) {
        out.println(
            pc.dim(
                "  cold and sum-of-self differ by more than 15%: the cold number includes the process's first transpile of every file; self times are per-module evaluation once everything under them is cached"
            )
        );
    }

    renderTree(result, options.graph, options);

    renderCliSection(`Heaviest modules by self time (top ${options.top})`);
    const table = createBoxTable(["MODULE", "SELF", "TOTAL", "UNDER IT", "KIND", "WHY"]);
    const scale = result.coldMs > 0 ? result.coldMs : result.sumSelfMs;

    for (const module of measured.slice(0, options.top)) {
        const colour = heat(module.selfMs, scale);
        table.push([
            truncateDisplay(module.label, 58),
            colour(fmtMs(module.selfMs)),
            fmtMs(module.totalMs),
            String(module.descendants),
            kindCell(module),
            shortWhy(module),
        ]);
    }

    out.println(table.toString());

    // Cheap modules with only structural findings ("in a cycle", "pulls N modules") would bury the
    // ones that explain time. A module is worth a paragraph when its own time is notable or when
    // a finding is more than low severity.
    const explained = measured
        .filter(
            (module) =>
                module.findings.length > 0 &&
                (module.selfMs >= options.slowMs ||
                    module.label === result.entry ||
                    module.findings.some((finding) => finding.severity !== "low"))
        )
        .slice(0, options.top);

    if (explained.length > 0) {
        renderCliSection("Why");

        for (const module of explained) {
            out.println(
                `${pc.bold(module.label)}  ${pc.dim(`self ${fmtMs(module.selfMs)}, total ${fmtMs(module.totalMs)}`)}`
            );

            for (const finding of module.findings) {
                out.println(`  ${severityDot(finding.severity)} ${finding.summary}`);

                for (const detail of finding.details) {
                    out.println(`      ${pc.dim(detail)}`);
                }
            }
        }
    }

    if (result.unresolved.length > 0) {
        renderCliSection(`Unresolved specifiers (${result.unresolved.length})`);

        for (const item of result.unresolved.slice(0, 10)) {
            out.println(`  ${pc.dim(item.from)}:${item.line}  ${item.specifier}`);
        }
    }
}

export function renderLazy(candidates: LazyCandidate[], entry: string, minMs: number): void {
    renderCliHeader("tools ts imports lazy", entry);
    const shown = candidates.filter((candidate) => candidate.savingMs >= minMs);

    if (shown.length === 0) {
        out.println(
            pc.dim(`  no static import saves ${fmtMs(minMs)} or more when made lazy (--min-ms lowers the bar)`)
        );
        return;
    }

    const table = createBoxTable(["IMPORTER", "LINE", "IMPORTS", "SAVES", "MODULES", "CAVEAT"]);

    for (const candidate of shown) {
        table.push([
            truncateDisplay(candidate.importer, 44),
            String(candidate.line),
            truncateDisplay(candidate.target, 44),
            pc.green(fmtMs(candidate.savingMs)),
            String(candidate.exclusiveModules),
            candidate.caveats.length > 0 ? pc.yellow(`${candidate.caveats.length} side effect(s)`) : pc.dim("—"),
        ]);
    }

    out.println(table.toString());
    renderCliSection("How to read it");
    out.println(
        pc.dim("  Every binding on the row is used only inside functions, so `await import()` at the use site keeps")
    );
    out.println(
        pc.dim("  the importer's own module scope identical. SAVES is the self time of modules on the startup path")
    );
    out.println(
        pc.dim("  through that one edge and nothing else. A CAVEAT names module-scope hooks, timers or assignments")
    );
    out.println(pc.dim("  in the target that would run later than they do today."));

    const withCaveats = shown.filter((candidate) => candidate.caveats.length > 0).slice(0, 5);

    if (withCaveats.length > 0) {
        renderCliSection("Caveats");

        for (const candidate of withCaveats) {
            out.println(`${pc.bold(candidate.target)}`);

            for (const caveat of candidate.caveats.slice(0, 3)) {
                out.println(`  ${pc.dim(caveat)}`);
            }
        }
    }
}

export function renderBarrels(waste: BarrelWaste[], entry: string, minMs: number): void {
    renderCliHeader("tools ts imports barrels", entry);
    const shown = waste.filter((item) => item.wastedMs >= minMs);

    if (shown.length === 0) {
        out.println(pc.dim(`  no barrel import wastes ${fmtMs(minMs)} or more on this startup path`));
        return;
    }

    const table = createBoxTable(["IMPORTER", "LINE", "BARREL", "USES", "OF", "WASTED", "MODULES"]);

    for (const item of shown) {
        table.push([
            truncateDisplay(item.importer, 40),
            String(item.importerLine),
            truncateDisplay(item.barrel, 40),
            String(item.usedTargets.length),
            String(item.usedTargets.length + item.unusedTargets.length),
            pc.yellow(fmtMs(item.wastedMs)),
            String(item.wastedModules),
        ]);
    }

    out.println(table.toString());
    renderCliSection("Detail");

    for (const item of shown.slice(0, 8)) {
        out.println(
            `${pc.bold(item.importer)}:${item.importerLine} imports {${item.used.join(", ")}} from ${pc.bold(item.barrel)}`
        );
        out.println(
            `  ${pc.green("needs")}  ${item.usedTargets.length > 0 ? item.usedTargets.join(", ") : pc.dim("(the barrel's own code)")}`
        );
        out.println(
            `  ${pc.yellow("drags")}  ${item.unusedTargets.slice(0, 6).join(", ")}${item.unusedTargets.length > 6 ? pc.dim(` +${item.unusedTargets.length - 6}`) : ""}`
        );
    }
}

export function renderCycles(cycles: ImportCycle[], entry: string): void {
    renderCliHeader("tools ts imports cycles", entry);

    if (cycles.length === 0) {
        out.println(pc.green("  no import cycles on the startup path"));
        return;
    }

    const table = createBoxTable(["SIZE", "SELF", "MEMBERS"]);

    for (const cycle of cycles) {
        table.push([String(cycle.members.length), fmtMs(cycle.selfMs), truncateDisplay(cycle.members.join(" ⇄ "), 90)]);
    }

    out.println(table.toString());
    renderCliSection("Edges inside each cycle");

    for (const cycle of cycles.slice(0, 10)) {
        out.println(pc.bold(`${cycle.members.length} modules`));

        for (const edge of cycle.edges.slice(0, 12)) {
            out.println(`  ${edge.from}:${edge.line} ${pc.dim("→")} ${edge.to}`);
        }
    }
}
