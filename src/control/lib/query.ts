import { type AxResult, type AxRun, runAx } from "./runner";

/** The read-only element queries every door shares: `control find`, `control get`, and the MCP twin. */
export type ElementQueryVerb = "find" | "get";

/** Selector fields, each a plain ax-tool flag. `exact` is a bare switch. */
export interface ElementTarget {
    q?: string;
    id?: string;
    role?: string;
    title?: string;
    desc?: string;
    value?: string;
    subrole?: string;
    text?: string;
    window?: string;
    depth?: string | number;
    exact?: boolean;
}

/**
 * Which selector flags each verb accepts, in ax-tool's order, and the depth it defaults to. `find`
 * filters many elements (value, text); `get` resolves one element (id). A new query verb is one row.
 */
const QUERY_VERBS: Record<ElementQueryVerb, { flags: ReadonlyArray<keyof ElementTarget>; depth?: string }> = {
    find: { flags: ["role", "title", "value", "desc", "subrole", "text", "q", "window"], depth: "15" },
    get: { flags: ["q", "id", "role", "title", "desc", "subrole", "window"] },
};

export function elementQueryArgs({
    verb,
    app,
    target,
}: {
    verb: ElementQueryVerb;
    app: string;
    target: ElementTarget;
}): string[] {
    const spec = QUERY_VERBS[verb];
    const depth = target.depth ?? spec.depth;
    const args = [verb, "--app", app];

    for (const flag of spec.flags) {
        const value = target[flag];
        if (typeof value === "string" && value.length > 0) {
            args.push(`--${flag}`, value);
        }
    }

    if (target.exact === true) {
        args.push("--exact");
    }

    if (depth !== undefined) {
        args.push("--depth", String(depth));
    }

    return args;
}

/** Runs one query. Nothing is dispatched to the app: find and get only read the AX tree. */
export async function queryElements({
    verb,
    app,
    target,
    run = runAx,
}: {
    verb: ElementQueryVerb;
    app: string;
    target: ElementTarget;
    run?: AxRun;
}): Promise<AxResult> {
    return run(elementQueryArgs({ verb, app, target }));
}
