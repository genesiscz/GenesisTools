// The plugin's one door to GenesisTools: whether its CLI runs here, and the links to its apps a click really opens.
// A link to the link host opens something only when GenesisTools.app is installed, macOS gives it https links, and
// the router has a route for that path; otherwise the click lands in the browser on a page that does not exist. The
// marketplace installs this plugin without the GenesisTools checkout, so `tools` itself may be missing.
//
// The answer comes from `tools genesis-tools probe --json` (GenesisTools `src/utils/genesis-tools/probe.ts`, which
// this file cannot import): the spawn proves that `tools` runs, and its JSON says which link kinds open. One run per
// 30 minutes per session, about 0.2 s, started by `session.start` and a timer (`primeGenesisProbe`), never by a
// render: the engine aborts a render hook's process when a newer render replaces it, and on 2026-10-23 that left
// every session believing no link kind opened. Every link this plugin writes is built here, from the probe's link
// host, and only for a kind that opens; any other file asks for one and gets undefined when it would be dead.
import type { Host } from "./shared";

export const LINK_KINDS = ["md", "finder", "hub", "claude-find"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface GenesisProbe {
    /** `tools` ran: the GenesisTools CLI is installed and on PATH. */
    tools: boolean;
    linkHost: string | null;
    opens: Record<LinkKind, boolean>;
}

const NO_LINKS: Record<LinkKind, boolean> = { md: false, finder: false, hub: false, "claude-find": false };
const NOTHING: GenesisProbe = { tools: false, linkHost: null, opens: NO_LINKS };
const MAX_AGE_MS = 30 * 60_000;

let held: { at: number; value: GenesisProbe } | undefined;
let pending: Promise<GenesisProbe> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The probe out of `tools genesis-tools probe --json`; undefined for anything else. */
export function probeOf(stdout: string): GenesisProbe | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }

    if (!isRecord(parsed) || !isRecord(parsed.links) || !isRecord(parsed.router)) {
        return undefined;
    }

    const links = parsed.links;
    const linkHost = typeof parsed.router.linkHost === "string" ? parsed.router.linkHost : null;
    const opens = (kind: LinkKind): boolean => {
        const state = links[kind];
        return linkHost !== null && isRecord(state) && state.opens === true;
    };

    return {
        tools: true,
        linkHost,
        opens: { md: opens("md"), finder: opens("finder"), hub: opens("hub"), "claude-find": opens("claude-find") },
    };
}

/** Undefined when the run was cut off (the hook that started it was replaced), which says nothing about this Mac. */
async function runProbe(host: Host): Promise<GenesisProbe | undefined> {
    try {
        // The probe answers in about 0.3 s and bounds each of its own lookups at 2 s; 5 s is the most it may take.
        const run = await host.run(["tools", "genesis-tools", "probe", "--json"], { timeoutMs: 5_000 });

        if (run.exitCode === 0) {
            // A GenesisTools from before the probe (2026-10-23) prints help: its CLI runs, its links stay unknown.
            return probeOf(run.stdout) ?? { ...NOTHING, tools: true };
        }

        // 127: the shell found no `tools`. Any other code: it runs, and the probe failed.
        return { ...NOTHING, tools: run.exitCode !== 127 };
    } catch (error) {
        // A render hook's `$` calls are aborted when a newer render replaces it (the live clock redraws each
        // second): that run never reached `tools`, so nothing is remembered and the next caller asks again.
        if (String(error).includes("aborted")) {
            return undefined;
        }

        // No `tools` on PATH: the spawn itself fails.
        if (/ENOENT|not found|cannot start/i.test(String(error))) {
            return NOTHING;
        }

        // A run past its deadline (a busy Mac) says nothing about this Mac either: the next caller asks again,
        // instead of every link and `tools` control staying off for 30 minutes.
        return undefined;
    }
}

function probeWith(host: Host): Promise<GenesisProbe> {
    pending ??= runProbe(host).then((value) => {
        pending = undefined;

        if (value === undefined) {
            return held?.value ?? NOTHING;
        }

        held = { at: Date.now(), value };
        return value;
    });

    return pending;
}

/**
 * Runs the probe from the session's start, outside any render, and again every 30 minutes on a timer, so a render
 * only ever reads the answer. `register.tsx` calls it from `session.start`.
 */
export function primeGenesisProbe(host: Host): void {
    void probeWith(host);
    host.every(MAX_AGE_MS, () => {
        void probeWith(host);
    });
}

/** What this Mac has: the last answer, or the run in flight; concurrent callers share one run. */
export async function genesisProbe(host: Host): Promise<GenesisProbe> {
    if (held && (Date.now() - held.at < MAX_AGE_MS || pending)) {
        return held.value;
    }

    return probeWith(host);
}

/** Drops the remembered probe: a test sets up another Mac. */
export function forgetGenesisProbe(): void {
    held = undefined;
    pending = undefined;
}

/** A path for a link: `encodeURI`, plus the parentheses a markdown link target cannot hold. */
export function encodePath(path: string): string {
    return encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function queryPath(value: string): string {
    return encodeURIComponent(value).replace(/%2F/g, "/").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function linkOn(probe: GenesisProbe, kind: LinkKind, path: string): string | undefined {
    return probe.linkHost && probe.opens[kind] ? `https://${probe.linkHost}/${path}` : undefined;
}

/** A note or data file in Genesis Markdown; `range` highlights `12` or `12-30`. */
export function mdLink(probe: GenesisProbe, path: string, range?: string): string | undefined {
    return linkOn(probe, "md", `md/open?path=${queryPath(path)}${range ? `&range=${encodeURIComponent(range)}` : ""}`);
}

/** A folder or file shown in Finder. */
export function finderLink(probe: GenesisProbe, target: string): string | undefined {
    return linkOn(probe, "finder", `finder/reveal?target=${queryPath(target)}`);
}

/** The GenesisTools hub on a PR (`owner/repo#42`), or a repository's commit. */
export function hubLink(
    probe: GenesisProbe,
    query: { pr: string; commit?: string } | { repo: string; commit: string }
): string | undefined {
    const pairs = Object.entries(query).filter((pair): pair is [string, string] => typeof pair[1] === "string");

    return linkOn(probe, "hub", `hub?${pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`);
}

/** Scrolls a live Claude session to where DECISION `n` was first asked. */
export function decisionLink(probe: GenesisProbe, session: string, n: number): string | undefined {
    return linkOn(probe, "claude-find", `claude/find/${encodeURIComponent(session)}/decision/${n}`);
}
