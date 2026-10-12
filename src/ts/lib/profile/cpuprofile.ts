import { relative } from "node:path";

/** One frame of a Chrome DevTools CPU profile, as `bun --cpu-prof` writes it. `lineNumber` is 0-based. */
export interface CpuProfileCallFrame {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
}

export interface CpuProfileNode {
    id: number;
    callFrame: CpuProfileCallFrame;
    children?: number[];
}

export interface CpuProfile {
    nodes: CpuProfileNode[];
    startTime: number;
    endTime: number;
    /** The leaf node of each sample. */
    samples: number[];
    /** Microseconds from the previous sample (the first from `startTime`). */
    timeDeltas: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isNode(value: unknown): value is CpuProfileNode {
    if (!isRecord(value) || typeof value.id !== "number" || !isRecord(value.callFrame)) {
        return false;
    }

    const frame = value.callFrame;
    return (
        typeof frame.functionName === "string" &&
        typeof frame.url === "string" &&
        typeof frame.lineNumber === "number" &&
        (value.children === undefined || isNumberArray(value.children))
    );
}

/** The value as a CPU profile, or null when it is not one. */
export function asCpuProfile(value: unknown): CpuProfile | null {
    if (
        !isRecord(value) ||
        !Array.isArray(value.nodes) ||
        !value.nodes.every(isNode) ||
        !isNumberArray(value.samples) ||
        !isNumberArray(value.timeDeltas) ||
        typeof value.startTime !== "number" ||
        typeof value.endTime !== "number"
    ) {
        return null;
    }

    return {
        nodes: value.nodes,
        samples: value.samples,
        timeDeltas: value.timeDeltas,
        startTime: value.startTime,
        endTime: value.endTime,
    };
}

/** A function as the report names it: one row per name, file and line. */
export interface ProfileFunction {
    key: string;
    name: string;
    /** `src/x.ts:12` for a repository file, the URL otherwise, `[native]` when there is none. */
    location: string;
    /** True for a file of the profiled repository outside `node_modules`. */
    inRepo: boolean;
}

export interface FunctionCost {
    fn: ProfileFunction;
    /** Sampled time with this function on top of the stack. */
    selfUs: number;
    /** Sampled time with this function anywhere on the stack (counted once per sample under recursion). */
    totalUs: number;
}

export interface RepoTreeNode {
    fn: ProfileFunction;
    totalUs: number;
    children: RepoTreeNode[];
}

export interface ProfileSummary {
    /** Sampled time of all profiles added together. */
    sampledUs: number;
    samples: number;
    profiles: number;
    /** Every function, by self time. */
    functions: FunctionCost[];
    /**
     * Repository functions only. `selfUs` here is the time with this function as the deepest repository frame, so it
     * includes the library and native calls it makes, but not the repository functions it calls.
     */
    repoFunctions: FunctionCost[];
    /** Stacks reduced to their repository frames, from the outermost; time below a frame includes its callees. */
    repoTree: RepoTreeNode[];
}

const SPECIAL = new Set(["(root)", "(program)", "(idle)", "(garbage collector)"]);

function functionOf(frame: CpuProfileCallFrame, repoRoot: string): ProfileFunction {
    const name = frame.functionName || "(anonymous)";
    const url = frame.url.startsWith("file://") ? frame.url.slice("file://".length) : frame.url;
    const line = frame.lineNumber + 1;
    const inRepo = url.startsWith(`${repoRoot}/`) && !url.includes("/node_modules/");
    const location = !url
        ? "[native]"
        : url.startsWith(`${repoRoot}/`)
          ? `${relative(repoRoot, url)}:${line}`
          : `${url}${frame.lineNumber >= 0 ? `:${line}` : ""}`;
    return { key: `${name}|${url}|${line}`, name, location, inRepo };
}

/** How long each sample stands for: the gap to the next sample, and the median gap for the last one. */
function sampleWeights(profile: CpuProfile): number[] {
    const deltas = profile.timeDeltas.map((delta) => Math.max(0, delta));
    const sorted = [...deltas].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return deltas.map((_, index) => (index + 1 < deltas.length ? deltas[index + 1] : median));
}

/**
 * Self and total time per function, and the call tree of repository frames, over one or more profiles. The times
 * are sampled time on the JavaScript thread: a native call that blocks (a `stat`, a file read) counts in full, and
 * work on other threads does not count at all.
 */
export function summarizeProfiles(profiles: CpuProfile[], repoRoot: string): ProfileSummary {
    const costs = new Map<string, FunctionCost>();
    const repoCosts = new Map<string, FunctionCost>();
    const treeRoots: RepoTreeNode[] = [];
    let sampledUs = 0;
    let samples = 0;

    const cost = (table: Map<string, FunctionCost>, fn: ProfileFunction) => {
        let entry = table.get(fn.key);

        if (!entry) {
            entry = { fn, selfUs: 0, totalUs: 0 };
            table.set(fn.key, entry);
        }

        return entry;
    };

    for (const profile of profiles) {
        const parent = new Map<number, number>();
        const fnOf = new Map<number, ProfileFunction>();

        for (const node of profile.nodes) {
            fnOf.set(node.id, functionOf(node.callFrame, repoRoot));

            for (const child of node.children ?? []) {
                parent.set(child, node.id);
            }
        }

        const weights = sampleWeights(profile);

        for (const [index, leaf] of profile.samples.entries()) {
            const weight = weights[index] ?? 0;
            const stack: ProfileFunction[] = [];

            for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) {
                const fn = fnOf.get(id);

                if (fn && !SPECIAL.has(fn.name)) {
                    stack.push(fn);
                }
            }

            if (stack.length === 0) {
                continue;
            }

            sampledUs += weight;
            samples++;
            cost(costs, stack[0]).selfUs += weight;
            const seen = new Set<string>();

            for (const fn of stack) {
                if (!seen.has(fn.key)) {
                    seen.add(fn.key);
                    cost(costs, fn).totalUs += weight;
                }
            }

            const repoStack = stack.filter((fn) => fn.inRepo).reverse();

            if (repoStack.length === 0) {
                continue;
            }

            cost(repoCosts, repoStack[repoStack.length - 1]).selfUs += weight;
            const repoSeen = new Set<string>();
            let level = treeRoots;

            for (const fn of repoStack) {
                if (!repoSeen.has(fn.key)) {
                    repoSeen.add(fn.key);
                    cost(repoCosts, fn).totalUs += weight;
                }

                let node = level.find((candidate) => candidate.fn.key === fn.key);

                if (!node) {
                    node = { fn, totalUs: 0, children: [] };
                    level.push(node);
                }

                node.totalUs += weight;
                level = node.children;
            }
        }
    }

    const bySelf = (left: FunctionCost, right: FunctionCost) => right.selfUs - left.selfUs;
    const sortTree = (nodes: RepoTreeNode[]) => {
        nodes.sort((left, right) => right.totalUs - left.totalUs);

        for (const node of nodes) {
            sortTree(node.children);
        }
    };
    sortTree(treeRoots);

    return {
        sampledUs,
        samples,
        profiles: profiles.length,
        functions: [...costs.values()].sort(bySelf),
        repoFunctions: [...repoCosts.values()].sort((left, right) => right.totalUs - left.totalUs),
        repoTree: treeRoots,
    };
}

/** The subtrees rooted at every repository frame whose name contains `focus`, merged by function. */
export function focusTree(tree: RepoTreeNode[], focus: string): RepoTreeNode[] {
    const found: RepoTreeNode[] = [];
    const visit = (nodes: RepoTreeNode[]) => {
        for (const node of nodes) {
            if (node.fn.name.includes(focus)) {
                const existing = found.find((candidate) => candidate.fn.key === node.fn.key);

                if (existing) {
                    existing.totalUs += node.totalUs;
                    existing.children.push(...node.children);
                } else {
                    found.push({ ...node, children: [...node.children] });
                }

                continue;
            }

            visit(node.children);
        }
    };
    visit(tree);
    return found.sort((left, right) => right.totalUs - left.totalUs);
}
