export interface ReactMatcher {
    /** Label of this matcher in the result. */
    name: string;
    /**
     * Dotted props path that must resolve to a function, e.g. `client.getQueryCache`.
     * The object that owns the function is the match (here the QueryClient).
     */
    hasFunction?: string;
    /** Dotted props path that must resolve to a value other than undefined. That value is the match. */
    hasPath?: string;
    /** Only fibers whose component name is exactly this. Alone, the match is the props object. */
    component?: string;
    /** Store the live match on `window[exposeAs]` (an array when `limit` > 1), for later in-page calls. */
    exposeAs?: string;
    /** How many matches to collect. Default 1, the outermost one in tree order. */
    limit?: number;
}

export interface ReactFindArgs {
    matchers: ReactMatcher[];
    /** Stop the walk after this many fibers. Default 200 000. */
    maxFibers?: number;
}

export interface ReactMatch {
    matcher: string;
    component: string;
    depth: number;
    /** The props path of the matched value, "" when the match is the props object itself. */
    propPath: string;
    exposedAs: string | null;
    /** Names of the nearest named ancestor components, closest first. */
    ancestors: string[];
}

export interface ReactFindResult {
    roots: number;
    fibers: number;
    truncated: boolean;
    matches: ReactMatch[];
    /** Matchers that found nothing. */
    missing: string[];
    error?: string;
}

/**
 * Walks every React root on the page (createRoot `__reactContainer$*` and legacy `_reactRootContainer`)
 * and finds fibers whose props satisfy structured matchers. No eval or `new Function`, so it runs under
 * a CSP without 'unsafe-eval'. Self-contained: only its source text reaches the page.
 */
export function reactFind(args: ReactFindArgs): ReactFindResult {
    type Fiber = {
        type?: unknown;
        tag?: number;
        memoizedProps?: unknown;
        child?: Fiber | null;
        sibling?: Fiber | null;
        return?: Fiber | null;
    };
    type Obj = Record<string, unknown>;

    const maxFibers = args.maxFibers ?? 200_000;
    const result: ReactFindResult = { roots: 0, fibers: 0, truncated: false, matches: [], missing: [] };

    const isObj = (value: unknown): value is Obj =>
        (typeof value === "object" || typeof value === "function") && value !== null;

    const nameOf = (fiber: Fiber): string => {
        const type = fiber.type;
        if (typeof type === "string") {
            return type;
        }

        if (typeof type === "function") {
            const fn = type as { displayName?: string; name?: string };
            return fn.displayName || fn.name || "Anonymous";
        }

        if (isObj(type)) {
            const render = isObj(type.render) ? (type.render as { displayName?: string; name?: string }) : null;
            const inner = isObj(type.type) ? (type.type as { displayName?: string; name?: string }) : null;
            const context = isObj(type._context) ? (type._context as { displayName?: string }) : null;
            return (
                (type.displayName as string | undefined) ||
                render?.displayName ||
                render?.name ||
                inner?.displayName ||
                inner?.name ||
                (context ? `${context.displayName || "Context"}.Provider` : "") ||
                "Object"
            );
        }

        return fiber.tag === 3 ? "HostRoot" : "Unknown";
    };

    const resolve = (root: unknown, path: string[]): unknown => {
        let current = root;
        for (const segment of path) {
            if (!isObj(current)) {
                return undefined;
            }

            current = current[segment];
        }

        return current;
    };

    const ancestorsOf = (fiber: Fiber): string[] => {
        const names: string[] = [];
        let current = fiber.return;
        while (current && names.length < 6) {
            if (typeof current.type === "function" || isObj(current.type)) {
                names.push(nameOf(current));
            }

            current = current.return;
        }

        return names;
    };

    try {
        const roots: Fiber[] = [];
        for (const element of Array.from(document.querySelectorAll("*"))) {
            const host = element as unknown as Obj;
            for (const key of Object.keys(host)) {
                if (key.startsWith("__reactContainer$") && isObj(host[key])) {
                    // The key holds the HostRoot fiber from mount time; after a commit the live tree can be on
                    // its alternate. The FiberRoot (stateNode) always points at the current one.
                    const mounted = host[key] as Obj;
                    const fiberRoot = isObj(mounted.stateNode) ? mounted.stateNode : null;
                    roots.push((fiberRoot && isObj(fiberRoot.current) ? fiberRoot.current : mounted) as Fiber);
                } else if (key === "_reactRootContainer" && isObj(host[key])) {
                    const container = host[key] as Obj;
                    const fiberRoot = isObj(container._internalRoot) ? container._internalRoot : container;
                    if (isObj(fiberRoot.current)) {
                        roots.push(fiberRoot.current as Fiber);
                    }
                }
            }
        }

        result.roots = roots.length;
        const found = new Map<string, unknown[]>();
        const pending = args.matchers.filter((matcher) => matcher.hasFunction || matcher.hasPath || matcher.component);
        for (const matcher of pending) {
            found.set(matcher.name, []);
        }

        const stack: Array<[Fiber, number]> = roots.map((root) => [root, 0]);
        while (stack.length > 0 && pending.length > 0) {
            const [fiber, depth] = stack.pop() as [Fiber, number];
            result.fibers++;
            if (result.fibers > maxFibers) {
                result.truncated = true;
                break;
            }

            const props = fiber.memoizedProps;
            if (isObj(props)) {
                for (let i = pending.length - 1; i >= 0; i--) {
                    const matcher = pending[i];
                    if (matcher.component && nameOf(fiber) !== matcher.component) {
                        continue;
                    }

                    let value: unknown = props;
                    let propPath = "";
                    if (matcher.hasFunction) {
                        const path = matcher.hasFunction.split(".");
                        const owner = resolve(props, path.slice(0, -1));
                        if (!isObj(owner) || typeof owner[path[path.length - 1]] !== "function") {
                            continue;
                        }

                        value = owner;
                        propPath = path.slice(0, -1).join(".");
                    } else if (matcher.hasPath) {
                        value = resolve(props, matcher.hasPath.split("."));
                        if (value === undefined) {
                            continue;
                        }

                        propPath = matcher.hasPath;
                    }

                    const values = found.get(matcher.name) as unknown[];
                    if (values.includes(value)) {
                        continue;
                    }

                    values.push(value);
                    result.matches.push({
                        matcher: matcher.name,
                        component: nameOf(fiber),
                        depth,
                        propPath,
                        exposedAs: matcher.exposeAs ?? null,
                        ancestors: ancestorsOf(fiber),
                    });
                    if (values.length >= (matcher.limit ?? 1)) {
                        pending.splice(i, 1);
                    }
                }
            }

            if (fiber.sibling) {
                stack.push([fiber.sibling, depth]);
            }

            if (fiber.child) {
                stack.push([fiber.child, depth + 1]);
            }
        }

        const target = window as unknown as Obj;
        for (const matcher of args.matchers) {
            const values = found.get(matcher.name) ?? [];
            if (values.length === 0) {
                result.missing.push(matcher.name);
                continue;
            }

            if (matcher.exposeAs) {
                target[matcher.exposeAs] = (matcher.limit ?? 1) > 1 ? values : values[0];
            }
        }
    } catch (error) {
        result.error = String(error);
    }

    return result;
}
