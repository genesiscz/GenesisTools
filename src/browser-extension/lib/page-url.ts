/**
 * What a GitHub or GitLab page URL points at. Pure and DOM-free: the content script, the native
 * host and the CLI all parse the same way, and the host never trusts a parse done in the page.
 */
export type ForgeKind = "github" | "gitlab";
export type ForgeView = "pr" | "blob" | "tree" | "commit" | "project";

export interface ForgePage {
    kind: ForgeKind;
    /** Lowercased, with a port when the URL has one. */
    host: string;
    /** `o/r` on GitHub, `group/sub/app` on GitLab, as written in the URL. */
    project: string;
    /** `https://host/project`, the shape `originWebBase` gives for a remote. */
    webBase: string;
    view: ForgeView;
    /** PR / MR number. */
    number?: number;
    /** Blob and tree pages: `<ref>/<path>`, split later against the local branch names. */
    refPath?: string;
    /** From `#L12`, `#L12-L20`, `#L12-20` or a diff anchor `#diff-<sha>R12`. */
    line?: number;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function lineFromHash(hash: string): number | undefined {
    const match = /^#L(\d{1,7})(?:-L?\d+)?$/.exec(hash) ?? /^#diff-[0-9a-f]+R(\d{1,7})$/.exec(hash);
    return match ? Number(match[1]) : undefined;
}

function isGitlabHost(host: string, gitlabHosts: readonly string[]): boolean {
    return host.includes("gitlab") || gitlabHosts.some((known) => known.toLowerCase() === host);
}

function decodedPath(segments: string[]): string | null {
    try {
        return segments.map(decodeURIComponent).join("/");
    } catch (error) {
        if (error instanceof URIError) {
            return null;
        }

        throw error;
    }
}

function tail(kind: ForgeKind, rest: string[]): Pick<ForgePage, "view" | "number" | "refPath"> {
    const [verb, ...more] = rest;
    const prVerb = kind === "github" ? "pull" : "merge_requests";

    if (verb === prVerb && more[0] && /^\d{1,9}$/.test(more[0])) {
        return { view: "pr", number: Number(more[0]) };
    }

    if ((verb === "blob" || verb === "tree") && more.length > 0) {
        const refPath = decodedPath(more);

        // A malformed escape (`%zz`) is not a page this parser can name; keep the null contract.
        return refPath === null ? { view: "project" } : { view: verb, refPath };
    }

    if ((verb === "commit" || verb === "commits") && more[0]) {
        return { view: "commit" };
    }

    return { view: "project" };
}

export function parseForgeUrl(raw: string, gitlabHosts: readonly string[] = []): ForgePage | null {
    if (!URL.canParse(raw)) {
        return null;
    }

    const url = new URL(raw);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return null;
    }

    const host = url.host.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    let kind: ForgeKind;
    let projectSegments: string[];
    let rest: string[];

    if (host === "github.com") {
        kind = "github";
        projectSegments = segments.slice(0, 2);
        rest = segments.slice(2);

        if (projectSegments.length < 2) {
            return null;
        }
    } else if (isGitlabHost(host, gitlabHosts)) {
        kind = "gitlab";
        const dash = segments.indexOf("-");
        projectSegments = dash === -1 ? segments : segments.slice(0, dash);
        rest = dash === -1 ? [] : segments.slice(dash + 1);

        if (projectSegments.length < 2) {
            return null;
        }
    } else {
        return null;
    }

    if (!projectSegments.every((segment) => SEGMENT.test(segment))) {
        return null;
    }

    const project = projectSegments.join("/");
    const page: ForgePage = {
        kind,
        host,
        project,
        webBase: `${url.protocol}//${host}/${project}`,
        ...tail(kind, rest),
    };
    const line = lineFromHash(url.hash);

    if (line !== undefined) {
        page.line = line;
    }

    return page;
}

/**
 * Split a blob `refPath` into ref and file path. A ref may contain slashes (`feat/login`), so the
 * longest known branch that prefixes the path wins; with no match the first segment is the ref.
 */
export function splitRefPath(refPath: string, branches: readonly string[]): { ref: string; path: string } {
    const known = [...branches]
        .filter((branch) => refPath.startsWith(`${branch}/`))
        .sort((a, b) => b.length - a.length)[0];

    if (known) {
        return { ref: known, path: refPath.slice(known.length + 1) };
    }

    const slash = refPath.indexOf("/");
    return slash === -1 ? { ref: refPath, path: "" } : { ref: refPath.slice(0, slash), path: refPath.slice(slash + 1) };
}
