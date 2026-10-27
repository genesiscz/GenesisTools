// Commit links for the link fixer (`links.tsx`): which forge project a checkout belongs to, which tokens of a reply are
// commits, the hub link for one (inside the PR that holds it, asked from `tools hub link`), and the checks a hub link the
// model wrote by hand gets. Standalone, as every runtime plugin file: it imports its siblings only.
import { type GenesisProbe, hubLink } from "./genesis";
import { type Host, isRecord } from "./shared";

/** A forge project: `owner/repo` on GitHub, `group/sub/app` on GitLab. */
export interface ForgeProject {
    kind: "github" | "gitlab";
    host: string;
    path: string;
}

/**
 * The project of an origin URL, as the GenesisTools CLI reads one (`classifyOriginUrl`): GitHub on github.com, GitLab on
 * any host with `gitlab` in its name. https, `ssh://` with a port, and scp-style `git@host:path` all work; a dotted
 * repository name keeps its dots.
 */
export function forgeProject(origin: string): ForgeProject | undefined {
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/]([^\s]+?)(?:\.git)?\/?$/i.exec(
        origin.trim()
    );

    const [, rawHost, rawPath] = match ?? [];

    if (!rawHost || !rawPath) {
        return undefined;
    }

    const host = rawHost.toLowerCase();
    const path = rawPath.replace(/^\/+/, "");
    const kind =
        host === "github.com" || host.endsWith(".github.com")
            ? "github"
            : host.includes("gitlab")
              ? "gitlab"
              : undefined;

    return kind && path.includes("/") ? { kind, host, path } : undefined;
}

/** One end of a commit: 7 to 40 hex characters with at least one digit and one letter. */
const END = "(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}";
/** A commit as a reply writes it, or a range of two (`efb5951c5a..efe2e40b4b`) as one token. */
export const COMMIT = new RegExp(`\\b${END}(?:\\.\\.${END})?\\b`, "g");

/** What `tools hub link --json` answered for one commit in one checkout; null for no answer worth keeping. */
const answers = new Map<string, { pr: string } | { repo: string }>();
/** A miss (a timeout, no `tools`) is asked again after this long; an answer is kept for the session. */
const RETRY_MS = 5 * 60_000;
const LINK_TIMEOUT_MS = 4_000;
const failedAt = new Map<string, number>();

/** Drops the remembered answers: a test sets up another machine. */
export function forgetCommitLinks(): void {
    answers.clear();
    failedAt.clear();
}

/**
 * The hub link for `spec` (one commit or `a..b`) of the checkout at `root`: inside the PR that holds it when
 * `tools hub link` names one, else `repo=<project>`. Undefined when this Mac opens no hub link.
 */
export async function commitLink({
    host,
    probe,
    root,
    project,
    spec,
}: {
    host: Host;
    probe: GenesisProbe;
    root: string;
    project: ForgeProject | undefined;
    spec: string;
}): Promise<string | undefined> {
    const fallback = hubLink(probe, { repo: project?.path ?? root, commit: spec });

    if (!fallback || !probe.tools) {
        return fallback;
    }

    const key = `${root}|${spec}`;
    const held = answers.get(key);

    if (held) {
        return hubLink(probe, { ...held, commit: spec }) ?? fallback;
    }

    if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) {
        return fallback;
    }

    const run = await host
        .run(["tools", "hub", "link", spec, "--repo", root, "--json"], { timeoutMs: LINK_TIMEOUT_MS })
        .catch(() => undefined);
    const query = run?.exitCode === 0 ? linkQuery(run.stdout) : undefined;

    if (!query) {
        failedAt.set(key, Date.now());
        return fallback;
    }

    answers.set(key, query);
    return hubLink(probe, { ...query, commit: spec }) ?? fallback;
}

/** The place `tools hub link --json` chose: `{ pr }` or `{ repo }`; undefined for anything else. */
function linkQuery(stdout: string): { pr: string } | { repo: string } | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }

    const query = isRecord(parsed) && isRecord(parsed.query) ? parsed.query : undefined;

    if (typeof query?.pr === "string" && query.pr) {
        return { pr: query.pr };
    }

    return typeof query?.repo === "string" && query.repo ? { repo: query.repo } : undefined;
}

/** A hub link: `https://<link host>/hub?…` or `genesis-tools://hub?…`. */
const HUB_LINK = /^(?:https?:\/\/[^/\s]+\/hub\/?|genesis-tools:\/\/hub)\?/;

/**
 * A hub link the reply wrote by hand, made right where it can be and judged where it cannot: `&amp;` (copied out of a
 * subagent's task notification, whose XML escapes `&`) becomes `&`, so the app no longer drops `amp;commit`; a `pr=`
 * or `commit=` the hub cannot open is named. Undefined for a URL that is no hub link.
 */
export function checkHubLink(url: string): { url: string; problems: string[] } | undefined {
    if (!HUB_LINK.test(url)) {
        return undefined;
    }

    const fixed = url.replace(/&amp;/g, "&");
    const problems: string[] = fixed === url ? [] : ["&amp; in the query: the app dropped the key after it"];
    let query: URLSearchParams;

    try {
        query = new URL(fixed).searchParams;
    } catch {
        return { url: fixed, problems: [...problems, "not a URL"] };
    }

    const pr = query.get("pr");

    if (pr !== null && !/^https?:\/\//.test(pr)) {
        const number = /^(?:.*[#!])?(\d+)$/.exec(pr)?.[1];

        if (!number) {
            problems.push(`pr=${pr} names no PR (<project>#<n>, <project>!<n> or a page URL)`);
        } else if (number.length > 6) {
            problems.push(`pr=${pr}: ${number} is no PR number (a mangled %21 or %23?)`);
        }
    }

    const commit = query.get("commit");

    if (commit !== null && !/^[0-9a-f]{7,40}(?:\.\.[0-9a-f]{7,40})?$/i.test(commit)) {
        problems.push(`commit=${commit} is not 7 to 40 hex characters or <from>..<to>`);
    }

    if (commit !== null && pr === null && query.get("repo") === null) {
        problems.push("commit= without pr= or repo=: the hub cannot place it");
    }

    return { url: fixed, problems };
}
