import type { RouteDef } from "@app/dev-dashboard/server/types";

interface CompiledRoute {
    def: RouteDef;
    regex: RegExp;
    paramNames: string[];
}

export interface RouteMatch {
    def: RouteDef;
    params: Record<string, string>;
}

function compile(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const source = pattern
        .split("/")
        .map((seg) => {
            if (seg.startsWith(":")) {
                paramNames.push(seg.slice(1));
                return "([^/]+)";
            }

            return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");

    return { regex: new RegExp(`^${source}$`), paramNames };
}

export class Router {
    private readonly routes: CompiledRoute[] = [];

    add(def: RouteDef): this {
        const { regex, paramNames } = compile(def.pattern);
        this.routes.push({ def, regex, paramNames });

        return this;
    }

    addAll(defs: RouteDef[]): this {
        for (const def of defs) {
            this.add(def);
        }

        return this;
    }

    match(method: string, pathname: string): RouteMatch | null {
        for (const route of this.routes) {
            if (route.def.method !== method) {
                continue;
            }

            const m = route.regex.exec(pathname);

            if (!m) {
                continue;
            }

            const params: Record<string, string> = {};
            try {
                route.paramNames.forEach((name, i) => {
                    params[name] = decodeURIComponent(m[i + 1] ?? "");
                });
            } catch {
                return null;
            }

            return { def: route.def, params };
        }

        return null;
    }
}
