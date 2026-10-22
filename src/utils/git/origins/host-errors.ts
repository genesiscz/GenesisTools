import { lookup } from "node:dns/promises";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "origins/host-errors" });

/** How long the name check may take before the query runs anyway. */
const RESOLVE_TIMEOUT_MS = 1_500;
/** One answer serves every project on the host for this long, so a list of ten repos checks once. */
const RESOLVE_TTL_MS = 10_000;

type Resolution = "resolves" | "unresolved" | "unknown";

/** What the check depends on; a test passes its own resolver, clock and proxy answer. */
export interface HostCheckDeps {
    lookup: (name: string) => Promise<unknown>;
    now: () => number;
    proxied: () => boolean;
    timeoutMs: number;
    ttlMs: number;
}

const systemDeps: HostCheckDeps = {
    lookup: (name) => lookup(name),
    now: () => Date.now(),
    proxied: () => env.getFirstValue(["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) !== undefined,
    timeoutMs: RESOLVE_TIMEOUT_MS,
    ttlMs: RESOLVE_TTL_MS,
};

/**
 * Whether the system resolver knows `name`. glab and gh resolve with Go's own resolver, which asks a
 * scoped DNS server (the VPN's server for `corp`) directly and waits about 7 s for it when the VPN is
 * off; the system resolver answers "not found" in milliseconds (2026-10-18). A proxy resolves names
 * itself, so with one set nothing is decided here.
 */
async function resolution(name: string, deps: HostCheckDeps): Promise<Resolution> {
    if (deps.proxied()) {
        return "unknown";
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Resolution>((resolve) => {
        timer = setTimeout(() => resolve("unknown"), deps.timeoutMs);
    });
    const answer = deps.lookup(name).then(
        (): Resolution => "resolves",
        (err: unknown): Resolution => {
            const code = err instanceof Error && "code" in err ? err.code : undefined;
            log.debug({ name, code }, "host does not resolve");
            return code === "ENOTFOUND" ? "unresolved" : "unknown";
        }
    );

    try {
        return await Promise.race([answer, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A host check with its own cache: the error to report instead of running a host query when the host has no
 * address, or null when the query should run. One answer per host serves every caller for `ttlMs`.
 */
export function createHostCheck(overrides: Partial<HostCheckDeps> = {}): (host: string) => Promise<string | null> {
    const deps = { ...systemDeps, ...overrides };
    const recent = new Map<string, { at: number; answer: Promise<Resolution> }>();

    return async (host) => {
        // A proxy resolves names itself: an answer cached before it was set must not skip the query.
        if (deps.proxied()) {
            return null;
        }

        const now = deps.now();
        let entry = recent.get(host);

        if (!entry || now - entry.at > deps.ttlMs) {
            entry = { at: now, answer: resolution(dnsName(host), deps) };
            recent.set(host, entry);
        }

        return (await entry.answer) === "unresolved" ? `lookup ${host}: no such host (the query was not sent)` : null;
    };
}

/** The process's host check, on the system resolver (`createHostCheck`). */
export const unresolvedHostError = createHostCheck();

/**
 * The name to resolve in a project host, which is a URL authority and may carry a port: `git.example.org:8443` is
 * `git.example.org`, `[::1]:8443` is `::1`. Looked up with its port, a reachable host read as unresolved.
 */
export function dnsName(authority: string): string {
    const bracketed = authority.match(/^\[([^\]]+)\](?::\d+)?$/);

    if (bracketed) {
        return bracketed[1];
    }

    const port = authority.match(/^([^:]+):\d+$/);
    return port ? port[1] : authority;
}

/**
 * The CLI's message as one paragraph: glab prints `ERROR` on a line of its own and wraps the rest to
 * the terminal width with padding, which split a URL in the middle ("col-   \n  fe/merge_requests").
 */
export function cleanHostError(raw: string): string {
    const lines = raw
        .replace(/^\s*ERROR\b:?/, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    let text = "";

    for (const line of lines) {
        text += text === "" || text.endsWith("-") || text.endsWith("/") ? line : ` ${line}`;
    }

    return text;
}

/** One short line for a failed host query; the full text belongs in a detail view. */
export function summarizeHostError(raw: string, host: string | null): string {
    const text = cleanHostError(raw);
    const lookupHost = text.match(/lookup ([\w.-]+?)(?::| on |$)/)?.[1] ?? host;

    // Go's resolver: "lookup <host>: i/o timeout" or "lookup <host> on <server>: server misbehaving".
    if (
        /no such host|lookup [\w.-]+(?: on [\w.:[\]-]+)?: (?:i\/o timeout|server misbehaving)|could not resolve host/i.test(
            text
        )
    ) {
        return `Cannot resolve ${lookupHost ?? "the host"}. Is the VPN on?`;
    }

    if (/connection refused|network is unreachable|no route to host|i\/o timeout|timed out/i.test(text)) {
        return `Cannot connect to ${host ?? "the host"}. Check the VPN or the network.`;
    }

    if (/\b401\b|unauthorized|not logged in|authentication|gh auth login|glab auth login/i.test(text)) {
        return `Not signed in to ${host ?? "the host"}.`;
    }

    if (/\b403\b|forbidden/i.test(text)) {
        return `${host ?? "The host"} refused access to this project.`;
    }

    if (/\b404\b|not found/i.test(text)) {
        return `${host ?? "The host"} does not know this project.`;
    }

    return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}
