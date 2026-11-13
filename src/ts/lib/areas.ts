import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { UsageError } from "./format";
import { type ImportIndex, labelOf, realPath } from "./import-index";

/** The area of a file directly inside a grouping folder, beside the area folders it holds. */
export const ROOT_AREA = "(root)";

export interface AreaGroupingOptions {
    /** The scanned paths as typed. A file or a glob groups from its nearest existing folder. */
    roots: string[];
    /** Folders that group one level deeper: `src/utils` gives `src/utils/ai`, `src/utils/cli`. */
    split?: string[];
    /** Folder levels under a root (or a split folder) that make one area. Default 1. */
    depth?: number;
    /** Real path the area names are relative to. Defaults to the cwd. */
    cwd?: string;
}

export interface AreaGrouping {
    /** The area name of a real absolute path, or undefined when it is under no root. */
    areaOf: (path: string) => string | undefined;
}

function folderOf(input: string): string {
    let current = resolve(input);

    while (!existsSync(current) || !statSync(current).isDirectory()) {
        const parent = dirname(current);

        if (parent === current) {
            return current;
        }

        current = parent;
    }

    return realPath(current);
}

/**
 * How files become areas. The deepest root or split folder that holds a file is its base; the
 * first `depth` folders below the base name the area, and a file with fewer folders below the base
 * than that belongs to `<base>/…/(root)`.
 */
export function createAreaGrouping(options: AreaGroupingOptions): AreaGrouping {
    const cwd = options.cwd ?? realPath(process.cwd());
    const depth = Math.max(1, Math.floor(options.depth ?? 1));

    // A root may be a file or a glob, so it groups from its nearest folder. A split folder that does not
    // exist is a typo: grouping from its nearest parent instead split a folder nobody asked for.
    for (const dir of options.split ?? []) {
        const absolute = resolve(dir);

        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
            throw new UsageError(`--split ${dir}: no such folder`);
        }
    }

    const bases = [...new Set([...options.roots, ...(options.split ?? [])].map(folderOf))].sort(
        (a, b) => b.length - a.length
    );
    const cache = new Map<string, string | undefined>();

    const areaOf = (path: string): string | undefined => {
        const folder = dirname(path);

        if (cache.has(folder)) {
            return cache.get(folder);
        }

        const base = bases.find((candidate) => folder === candidate || folder.startsWith(candidate + sep));
        let area: string | undefined;

        if (base !== undefined) {
            const below = relative(base, folder).split(sep).filter(Boolean);
            const kept = below.slice(0, depth);
            const parts = [labelOf(base, cwd), ...kept];

            if (kept.length < depth) {
                parts.push(ROOT_AREA);
            }

            area = parts.filter((part) => part !== ".").join("/");
        }

        cache.set(folder, area);
        return area;
    };

    return { areaOf };
}

export interface AreaStats {
    area: string;
    files: number;
    lines: number;
    /** Distinct areas that import this one. */
    fanIn: number;
    /** Distinct areas this one imports. */
    fanOut: number;
    /** Import sites in other areas that land here. */
    edgesIn: number;
    /** Import sites here that land in another area. */
    edgesOut: number;
    /** Import sites that stay inside the area. */
    internal: number;
}

export interface AreaEdge {
    from: string;
    to: string;
    /** Import sites, static and dynamic together. */
    count: number;
    /** Of `count`, the `import()` and deferred `require()` sites: lazy, they load later if at all. */
    dynamic: number;
    /** Of `count`, the `import type` sites: compile-time coupling only. */
    typeOnly: number;
}

export interface MutualPair {
    a: string;
    b: string;
    /** Sites from `a` into `b`. */
    ab: number;
    /** Sites from `b` into `a`. */
    ba: number;
    abDynamic: number;
    baDynamic: number;
}

export interface ForbidRule {
    text: string;
    from: string;
    to: string;
}

export interface ViolationSite {
    file: string;
    line: number;
    specifier: string;
    target: string;
    dynamic: boolean;
}

export interface Violation {
    rule: string;
    from: string;
    to: string;
    count: number;
    dynamic: number;
    sites: ViolationSite[];
}

export interface AreaReport {
    scanned: {
        files: number;
        lines: number;
        areas: number;
        /** Cross-area import sites. */
        crossEdges: number;
        /** Of `crossEdges`, the dynamic ones. */
        dynamicEdges: number;
        /** Import sites whose target is a source file outside the scanned paths. */
        outside: number;
        unresolved: number;
        /** Files that could not be read or parsed. Above zero, the scan is incomplete and no rule is proven kept. */
        failed: number;
    };
    areas: AreaStats[];
    edges: AreaEdge[];
    mutual: MutualPair[];
    violations: Violation[];
    /** The unreadable files, with the error each one gave. Their imports are missing from every table. */
    failed: Array<{ file: string; error: string }>;
}

/** Forward slashes, no leading `./`, no trailing `/`: `src/utils/` and `./src/utils` name the same folder. */
function normalisePrefix(text: string): string {
    return text.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** An area is inside a prefix when it is that folder or below it: `src/utils` holds `src/utils/ai`, never `src/utilsX`. */
export function isInside(area: string, prefix: string): boolean {
    return area === prefix || area.startsWith(`${prefix}/`);
}

/** `"src/utils->src/"`: no area inside `src/utils` may import an area inside `src` outside `src/utils`. */
export function parseForbid(text: string): ForbidRule {
    const parts = text.split("->");

    if (parts.length !== 2 || normalisePrefix(parts[0]) === "" || normalisePrefix(parts[1]) === "") {
        throw new UsageError(`--forbid wants "<from>-><to>", for example "src/utils->src/". Got: ${text}`);
    }

    return { text, from: normalisePrefix(parts[0]), to: normalisePrefix(parts[1]) };
}

/**
 * An edge breaks a rule when its source area is inside `from` and its target inside `to`, whole
 * folder names only. An edge that stays inside `from` is exempt: `src/utils->src` forbids utils
 * importing a tool, not utils importing utils. A rule whose target is itself inside its source
 * (`src/utils->src/utils/ai`) forbids exactly such edges, so only the target's own internal edges
 * are exempt then.
 */
export function breaksRule(rule: ForbidRule, from: string, to: string): boolean {
    if (!isInside(from, rule.from) || !isInside(to, rule.to)) {
        return false;
    }

    if (isInside(rule.to, rule.from)) {
        return !isInside(from, rule.to);
    }

    return !isInside(to, rule.from);
}

function edgeKey(from: string, to: string): string {
    return `${from}\u0000${to}`;
}

export function buildAreaReport(
    index: ImportIndex,
    grouping: AreaGrouping,
    options: { forbid?: ForbidRule[] } = {}
): AreaReport {
    const stats = new Map<string, AreaStats>();
    const fileArea = new Map<string, string>();
    let lines = 0;

    const statsOf = (area: string): AreaStats => {
        let entry = stats.get(area);

        if (!entry) {
            entry = { area, files: 0, lines: 0, fanIn: 0, fanOut: 0, edgesIn: 0, edgesOut: 0, internal: 0 };
            stats.set(area, entry);
        }

        return entry;
    };

    for (const file of index.files.values()) {
        const area = grouping.areaOf(file.path);

        if (area === undefined) {
            continue;
        }

        fileArea.set(file.path, area);
        const entry = statsOf(area);
        entry.files++;
        entry.lines += file.lines;
        lines += file.lines;
    }

    const edges = new Map<string, AreaEdge>();
    const violations = new Map<string, Violation>();
    const rules = options.forbid ?? [];
    let outside = 0;

    for (const file of index.files.values()) {
        const from = fileArea.get(file.path);

        if (from === undefined) {
            continue;
        }

        for (const site of file.imports) {
            const to = fileArea.get(site.to);

            if (to === undefined) {
                outside++;
                continue;
            }

            if (to === from) {
                statsOf(from).internal++;
                continue;
            }

            const key = edgeKey(from, to);
            const edge = edges.get(key) ?? { from, to, count: 0, dynamic: 0, typeOnly: 0 };
            edge.count++;
            edge.dynamic += site.kind === "dynamic" ? 1 : 0;
            edge.typeOnly += site.typeOnly ? 1 : 0;
            edges.set(key, edge);

            for (const rule of rules) {
                if (!breaksRule(rule, from, to)) {
                    continue;
                }

                const violationKey = `${rule.text}\u0000${key}`;
                const violation = violations.get(violationKey) ?? {
                    rule: rule.text,
                    from,
                    to,
                    count: 0,
                    dynamic: 0,
                    sites: [],
                };
                violation.count++;
                violation.dynamic += site.kind === "dynamic" ? 1 : 0;
                violation.sites.push({
                    file: file.label,
                    line: site.line,
                    specifier: site.specifier,
                    target: index.files.get(site.to)?.label ?? site.to,
                    dynamic: site.kind === "dynamic",
                });
                violations.set(violationKey, violation);
            }
        }
    }

    for (const edge of edges.values()) {
        const source = statsOf(edge.from);
        const target = statsOf(edge.to);
        source.fanOut++;
        source.edgesOut += edge.count;
        target.fanIn++;
        target.edgesIn += edge.count;
    }

    const mutual: MutualPair[] = [];

    for (const edge of edges.values()) {
        const back = edges.get(edgeKey(edge.to, edge.from));

        if (!back || edge.from > edge.to) {
            continue;
        }

        mutual.push({
            a: edge.from,
            b: edge.to,
            ab: edge.count,
            ba: back.count,
            abDynamic: edge.dynamic,
            baDynamic: back.dynamic,
        });
    }

    mutual.sort((x, y) => Math.min(y.ab, y.ba) - Math.min(x.ab, x.ba) || y.ab + y.ba - (x.ab + x.ba));
    const edgeList = [...edges.values()].sort((x, y) => y.count - x.count || x.from.localeCompare(y.from));
    const areaList = [...stats.values()].sort((x, y) => y.lines - x.lines || x.area.localeCompare(y.area));
    const violationList = [...violations.values()].sort(
        (x, y) => x.rule.localeCompare(y.rule) || y.count - x.count || x.from.localeCompare(y.from)
    );
    let dynamicEdges = 0;
    let crossEdges = 0;

    for (const edge of edgeList) {
        crossEdges += edge.count;
        dynamicEdges += edge.dynamic;
    }

    return {
        scanned: {
            files: fileArea.size,
            lines,
            areas: areaList.length,
            crossEdges,
            dynamicEdges,
            outside,
            unresolved: index.unresolved.length,
            failed: index.failed.length,
        },
        areas: areaList,
        edges: edgeList,
        mutual,
        violations: violationList,
        failed: index.failed,
    };
}

/**
 * A Mermaid flowchart of the areas: every edge with at least `minEdges` sites, labelled with its
 * count. A mutual pair is drawn red, an edge whose every site is dynamic is dashed.
 */
export function renderMermaid(report: AreaReport, options: { minEdges: number }): string {
    const kept = report.edges.filter((edge) => edge.count >= options.minEdges);
    const mutual = new Set<string>();

    for (const pair of report.mutual) {
        mutual.add(edgeKey(pair.a, pair.b));
        mutual.add(edgeKey(pair.b, pair.a));
    }

    const ids = new Map<string, string>();
    const idOf = (area: string): string => {
        let id = ids.get(area);

        if (!id) {
            id = `a${ids.size}`;
            ids.set(area, id);
        }

        return id;
    };

    const lines = ["flowchart LR"];
    const edgeLines: string[] = [];
    const red: number[] = [];

    for (const edge of kept) {
        const arrow = edge.dynamic === edge.count ? "-.->" : "-->";

        if (mutual.has(edgeKey(edge.from, edge.to))) {
            red.push(edgeLines.length);
        }

        edgeLines.push(`    ${idOf(edge.from)} ${arrow}|${edge.count}| ${idOf(edge.to)}`);
    }

    for (const [area, id] of ids) {
        lines.push(`    ${id}["${area.replace(/"/g, "'")}"]`);
    }

    lines.push(...edgeLines);

    if (red.length > 0) {
        lines.push(`    linkStyle ${red.join(",")} stroke:#d33,stroke-width:2px`);
    }

    return lines.join("\n");
}
