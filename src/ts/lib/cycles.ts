import { startupEdges } from "./graph";
import type { WorkerSample } from "./measure";
import type { ImportGraph } from "./types";

export interface ImportCycle {
    members: string[];
    /** `from:line -> to` for every startup edge inside the cycle. */
    edges: Array<{ from: string; to: string; line: number }>;
    selfMs: number;
}

/**
 * Tarjan's strongly connected components over startup edges. A component with two or more
 * members (or a self-import) is a cycle: whichever member is evaluated first sees the others'
 * exports as `undefined` until they finish, which is the classic "X is not a function at
 * import time" bug. Dynamic imports are not edges here, since they never cycle at load time.
 */
export function findCycles(graph: ImportGraph, self?: Map<string, WorkerSample>): ImportCycle[] {
    let counter = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];

    // Iterative Tarjan: a deep import chain would blow the recursion limit.
    const frames: Array<{ id: string; edges: string[]; next: number }> = [];

    function open(id: string): void {
        index.set(id, counter);
        low.set(id, counter);
        counter++;
        stack.push(id);
        onStack.add(id);
        frames.push({ id, edges: startupEdges(graph, id).map((edge) => edge.to), next: 0 });
    }

    for (const start of graph.nodes.keys()) {
        if (index.has(start)) {
            continue;
        }

        open(start);

        while (frames.length > 0) {
            const frame = frames[frames.length - 1];

            if (frame.next < frame.edges.length) {
                const child = frame.edges[frame.next];
                frame.next++;

                if (!index.has(child)) {
                    open(child);
                } else if (onStack.has(child)) {
                    low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(child) ?? 0));
                }

                continue;
            }

            frames.pop();
            const parent = frames[frames.length - 1];

            if (parent) {
                low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
            }

            if (low.get(frame.id) === index.get(frame.id)) {
                const component: string[] = [];
                let popped: string | undefined;

                do {
                    popped = stack.pop();

                    if (popped !== undefined) {
                        onStack.delete(popped);
                        component.push(popped);
                    }
                } while (popped !== undefined && popped !== frame.id);

                components.push(component);
            }
        }
    }

    const cycles: ImportCycle[] = [];

    for (const component of components) {
        const members = new Set(component);
        const selfLoop = component.length === 1 && startupEdges(graph, component[0]).some((e) => e.to === component[0]);

        if (component.length < 2 && !selfLoop) {
            continue;
        }

        const edges: ImportCycle["edges"] = [];
        let selfMs = 0;

        for (const id of component) {
            selfMs += self?.get(id)?.ms ?? 0;

            for (const edge of startupEdges(graph, id)) {
                if (members.has(edge.to)) {
                    edges.push({
                        from: graph.nodes.get(id)?.label ?? id,
                        to: graph.nodes.get(edge.to)?.label ?? edge.to,
                        line: edge.site.line,
                    });
                }
            }
        }

        cycles.push({
            members: component.map((id) => graph.nodes.get(id)?.label ?? id).sort(),
            edges,
            selfMs,
        });
    }

    cycles.sort((a, b) => b.members.length - a.members.length || b.selfMs - a.selfMs);
    return cycles;
}
