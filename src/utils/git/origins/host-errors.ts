import { lookup } from "node:dns/promises";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "origins/host-errors" });

/** How long the name check may take before the query runs anyway. */
const RESOLVE_TIMEOUT_MS = 1_500;
/** One answer serves every project on the host for this long, so a list of ten repos checks once. */
const RESOLVE_TTL_MS = 10_000;

type Resolution = "resolves" | "unresolved" | "unknown";

const recent = new Map<string, { at: number; answer: Promise<Resolution> }>();

/**
 * Whether the system resolver knows `host`. glab and gh resolve with Go's own resolver, which asks a
 * scoped DNS server (the VPN's server for `corp`) directly and waits about 7 s for it when the VPN is
 * off; the system resolver answers "not found" in milliseconds (2026-10-18). A proxy resolves names
 * itself, so with one set nothing is decided here.
 */
async function resolution(host: string): Promise<Resolution> {
    if (env.getFirstValue(["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])) {
        return "unknown";
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Resolution>((resolve) => {
        timer = setTimeout(() => resolve("unknown"), RESOLVE_TIMEOUT_MS);
    });
    const answer = lookup(host).then(
        (): Resolution => "resolves",
        (err: NodeJS.ErrnoException): Resolution => {
            log.debug({ host, code: err.code }, "host does not resolve");
            return err.code === "ENOTFOUND" ? "unresolved" : "unknown";
        }
    );

    try {
        return await Promise.race([answer, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The error to report instead of running a host query when `host` has no address, or null when the
 * query should run. Answers are kept for a few seconds per host.
 */
export async function unresolvedHostError(host: string): Promise<string | null> {
    const now = Date.now();
    let entry = recent.get(host);

    if (!entry || now - entry.at > RESOLVE_TTL_MS) {
        entry = { at: now, answer: resolution(host) };
        recent.set(host, entry);
    }

    return (await entry.answer) === "unresolved" ? `lookup ${host}: no such host (the query was not sent)` : null;
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

    if (/no such host|lookup [\w.-]+.*(i\/o timeout|server misbehaving)|could not resolve host/i.test(text)) {
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
