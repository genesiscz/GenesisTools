import {
    createContext,
    type MouseEvent,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";

/**
 * History-API router for multi-page artifacts, with a BASE prefix so the same
 * artifact routes correctly standalone (`/__tsx/app.tsx/item/42`), under the
 * library server (`/a/<name>/__tsx/app.tsx/item/42`), or anywhere else it is
 * mounted. The serve middleware falls back every sub-path of an artifact to
 * its shell, so deep links reload fine.
 *
 * The base comes from `window.__ARTIFACT_BASE__` (injected by the tsx shell);
 * without it, everything up to and including the `*.tsx`/`*.jsx`/`*.html`
 * segment of the current pathname is used. In a BUILT single file opened from
 * `file://` there is no server, so the router degrades to hash routing there:
 * a `file://` origin cannot call `history.pushState` (the browser rejects it as
 * a cross-origin operation), and there is nothing to serve a deep path anyway.
 * Same components, no code change in the artifact.
 *
 *   <Router routes={[
 *       { path: "/", element: <Home /> },
 *       { path: "/item/:id", element: <Item /> },   // params via useParams()
 *   ]} fallback={<NotFound />} />
 * Navigate with <RouterLink to="/item/42"> or useNavigate()("/item/42").
 */

declare global {
    interface Window {
        __ARTIFACT_BASE__?: string;
    }
}

export interface RouteDef {
    /** Pattern over the route path: "/", "/items", "/items/:id". */
    path: string;
    element: ReactNode;
}

interface RouterState {
    path: string;
    params: Record<string, string>;
    navigate: (to: string) => void;
    /** Absolute href for a route path (for links). */
    hrefFor: (to: string) => string;
}

const RouterContext = createContext<RouterState | null>(null);

function isFileMode(): boolean {
    return window.location.protocol === "file:";
}

/**
 * URL prefix the artifact is mounted under: injected by the tsx shell, or read
 * off the pathname up to and including the `*.tsx`/`*.jsx`/`*.html` segment.
 * Exported for tests; components use the Router context.
 */
export function detectBase(): string {
    if (typeof window.__ARTIFACT_BASE__ === "string") {
        return window.__ARTIFACT_BASE__.replace(/\/$/, "");
    }

    const match = window.location.pathname.match(/^(.*?\.(?:tsx|jsx|html))(?:\/|$)/);

    return match ? match[1] : "";
}

function normalizePath(to: string): string {
    return to.startsWith("/") ? to : `/${to}`;
}

/** Route path for the current location, base prefix stripped (hash-based on `file://`). */
export function currentPath(base: string): string {
    if (isFileMode()) {
        const hash = window.location.hash.replace(/^#/, "");

        return hash.startsWith("/") ? hash : "/";
    }

    const pathname = window.location.pathname;
    const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;

    // Keep the path RAW here: matchRoute decodes per segment, and decoding the
    // whole path would corrupt %2F params and double-decode literals.
    return rest === "" ? "/" : normalizePath(rest);
}

function safeDecode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        // Malformed sequences (%zz) must not throw during render.
        return segment;
    }
}

/** Match a pattern like "/items/:id" against a concrete path. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = path.split("/").filter(Boolean);

    if (patternParts.length !== pathParts.length) {
        return null;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < patternParts.length; i++) {
        const expected = patternParts[i];
        const actual = pathParts[i];

        if (expected.startsWith(":")) {
            params[expected.slice(1)] = safeDecode(actual);
        } else if (expected !== actual) {
            return null;
        }
    }

    return params;
}

export interface RouterProps {
    routes: RouteDef[];
    /** Rendered when no route matches (default: the "/" route, else nothing). */
    fallback?: ReactNode;
}

export function Router({ routes, fallback }: RouterProps) {
    const base = useMemo(() => detectBase(), []);
    const [path, setPath] = useState(() => currentPath(base));

    useEffect(() => {
        const onChange = (): void => setPath(currentPath(base));
        const eventName = isFileMode() ? "hashchange" : "popstate";
        window.addEventListener(eventName, onChange);

        return () => window.removeEventListener(eventName, onChange);
    }, [base]);

    const hrefFor = useCallback(
        (to: string) => (isFileMode() ? `#${normalizePath(to)}` : `${base}${normalizePath(to)}`),
        [base]
    );

    const navigate = useCallback(
        (to: string) => {
            if (isFileMode()) {
                window.location.hash = normalizePath(to);

                return;
            }

            history.pushState(null, "", `${base}${normalizePath(to)}`);
            setPath(normalizePath(to));
        },
        [base]
    );

    const matched = useMemo(() => {
        for (const route of routes) {
            const params = matchRoute(route.path, path);

            if (params) {
                return { route, params };
            }
        }

        return null;
    }, [routes, path]);

    const state = useMemo<RouterState>(
        () => ({ path, params: matched?.params ?? {}, navigate, hrefFor }),
        [path, matched, navigate, hrefFor]
    );

    const content = matched?.route.element ?? fallback ?? routes.find((r) => r.path === "/")?.element ?? null;

    return <RouterContext.Provider value={state}>{content}</RouterContext.Provider>;
}

function useRouter(): RouterState {
    const state = useContext(RouterContext);

    if (!state) {
        throw new Error("useParams/useNavigate/RouterLink need a <Router> ancestor.");
    }

    return state;
}

export function useParams(): Record<string, string> {
    return useRouter().params;
}

export function useNavigate(): (to: string) => void {
    return useRouter().navigate;
}

export function useRoutePath(): string {
    return useRouter().path;
}

export interface RouterLinkProps {
    to: string;
    children: ReactNode;
    className?: string;
}

/** Link that navigates via pushState (plain anchor semantics preserved for cmd-click). */
export function RouterLink({ to, children, className }: RouterLinkProps) {
    const { navigate, hrefFor } = useRouter();
    const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
            return;
        }

        e.preventDefault();
        navigate(to);
    };

    return (
        <a href={hrefFor(to)} onClick={onClick} className={className ?? "text-accent hover:underline"}>
            {children}
        </a>
    );
}
