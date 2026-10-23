import { genesisMdHandlerPath } from "@genesiscz/utils/app-links/open-file";
import { APP_LINKS } from "@genesiscz/utils/app-links/targets";
import { cmuxBinary, hasCapability, httpsHandler } from "@genesiscz/utils/browser-router/capabilities";
import { readRouterConfig } from "@genesiscz/utils/browser-router/config";
import { type RouteDecision, type RouterConfig, route } from "@genesiscz/utils/browser-router/route";
import { detectGenesisTools } from "@genesiscz/utils/cli/genesis-tools";
import { GENESIS_APP_BUNDLE_ID, genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";

/**
 * What of GenesisTools this Mac has, and which of its links a click opens. A link to genesis.tools opens something
 * only when GenesisTools.app is installed, macOS hands https links to it, the router config has a route for that
 * path, and the app or command the route names is there; otherwise the click goes to the browser and lands on a
 * page that does not exist. Every link kind is judged by the real config through `route()`, so a hand-made route
 * counts as much as a preset's.
 *
 * Reads only: no file is written, the router gate included. `tools genesis-tools probe` prints it, and the mods
 * plugin, which cannot import this file, runs that command.
 */

/** The link kinds code and agents write: a note, a folder, the hub, a decision in a live Claude chat. */
export const GENESIS_LINK_KINDS = ["md", "finder", "hub", "claude-find"] as const;
export type GenesisLinkKind = (typeof GENESIS_LINK_KINDS)[number];

/** Why a link opens nothing on this Mac. */
export type LinkProblem =
    | "not-darwin"
    | "app-missing"
    | "not-https-handler"
    | "no-link-host"
    | "no-route"
    | "target-missing";

export interface LinkState {
    opens: boolean;
    problem: LinkProblem | null;
    /** The problem in a sentence, or null when the link opens. */
    reason: string | null;
    /** What a click does: `open genesis-md://…`, `run /usr/bin/open -R /`, or `forward …` to the browser. */
    action: string | null;
}

export interface GenesisToolsProbe {
    version: 1;
    at: number;
    platform: string;
    /** The `tools` this process would run (`detectGenesisTools`), or null when none is found. */
    tools: { path: string | null };
    /** GenesisTools.app, which routes the links and opens `genesis-tools://`. */
    app: { installed: boolean; path: string };
    router: { httpsHandler: string | null; defaultHandler: boolean; configured: boolean; linkHost: string | null };
    /** The app that opens `genesis-md://` links (Genesis Markdown), found by Launch Services. */
    markdown: { path: string | null };
    cmux: { path: string | null };
    links: Record<GenesisLinkKind, LinkState>;
}

/** The facts the probe reads; a test passes its own. */
export interface ProbeFacts {
    platform: string;
    toolsPath: string | null;
    appInstalled: boolean;
    httpsHandler: string | null;
    config: RouterConfig | null;
    markdownPath: string | null;
    cmuxPath: string | null;
}

export function readProbeFacts(): ProbeFacts {
    return {
        platform: process.platform,
        toolsPath: detectGenesisTools()?.binPath ?? null,
        appInstalled: hasCapability("browser-router:installed"),
        httpsHandler: httpsHandler(),
        config: readRouterConfig(),
        markdownPath: genesisMdHandlerPath(),
        cmuxPath: cmuxBinary() ?? null,
    };
}

/** A sample link of each kind: what the route must match. */
const SAMPLE_PATHS: Record<GenesisLinkKind, string> = {
    md: APP_LINKS["genesis-md"].open.path({ path: "/probe.md" }),
    finder: APP_LINKS.finder.reveal.path({ target: "/" }),
    hub: APP_LINKS["genesis-hub"].open.path({ pr: "acme/app#1" }),
    "claude-find": APP_LINKS["claude-find"].decision.path({
        session: "00000000-0000-4000-8000-000000000000",
        decision: 1,
    }),
};

function problem(code: LinkProblem, reason: string, action: string | null = null): LinkState {
    return { opens: false, problem: code, reason, action };
}

function actionOf(decision: RouteDecision): string {
    if (decision.kind === "run") {
        return `run ${decision.argv.join(" ")}`;
    }

    if (decision.kind === "tool") {
        return `tool ${decision.tool} ${decision.args.join(" ")}`;
    }

    return `${decision.via === "route" ? "open" : "forward"} ${decision.url}`;
}

/** The program a route needs that this Mac lacks, or null when it has everything. */
function missingTarget(decision: RouteDecision, facts: ProbeFacts): string | null {
    if (decision.kind === "open" && decision.url.startsWith("genesis-md:") && !facts.markdownPath) {
        return "Genesis Markdown, the app the route opens, is not installed";
    }

    if (decision.kind === "open" && decision.url.startsWith("genesis-tools:") && !facts.appInstalled) {
        return "GenesisTools.app, the app the route opens, is not installed";
    }

    const argv = decision.kind === "run" ? decision.argv : decision.kind === "tool" ? ["tools", decision.tool] : [];

    if (argv[0] === "tools" && !facts.toolsPath) {
        return "the route runs the GenesisTools CLI, and no checkout of it is found";
    }

    if (argv.some((word) => word === "cmux" || word.endsWith("/cmux")) && !facts.cmuxPath) {
        return "the route needs cmux, which is not installed";
    }

    return null;
}

/** Whether a click on `url` opens what it names on this Mac, and why not. */
export function linkState(url: string, facts: ProbeFacts): LinkState {
    if (facts.platform !== "darwin") {
        return problem("not-darwin", "GenesisTools links open only on macOS");
    }

    if (!facts.appInstalled) {
        return problem("app-missing", "GenesisTools.app is not installed, so nothing routes the link");
    }

    if (facts.httpsHandler !== GENESIS_APP_BUNDLE_ID) {
        return problem(
            "not-https-handler",
            `macOS opens https links with ${facts.httpsHandler ?? "no app"}, so a click never reaches the router`
        );
    }

    if (!facts.config) {
        return problem("no-link-host", "there is no browser-router config");
    }

    let decision: RouteDecision;

    try {
        decision = route(url, facts.config);
    } catch (error) {
        return problem(
            "no-route",
            `the router refuses the link: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    const action = actionOf(decision);

    if (decision.via !== "route") {
        return problem("no-route", "no route on this Mac matches it, so the browser gets it", action);
    }

    const missing = missingTarget(decision, facts);

    return missing ? problem("target-missing", missing, action) : { opens: true, problem: null, reason: null, action };
}

/** The probe of every part and link kind, from `facts` (read from this Mac when omitted). */
export function probeGenesisTools({
    facts = readProbeFacts(),
    now = Date.now(),
}: {
    facts?: ProbeFacts;
    now?: number;
} = {}): GenesisToolsProbe {
    const linkHost = facts.config?.linkHost ?? null;
    const stateOf = (kind: GenesisLinkKind): LinkState =>
        linkHost
            ? linkState(`https://${linkHost}/${SAMPLE_PATHS[kind]}`, facts)
            : problem("no-link-host", "the router has no link host to build the link on");
    const links: Record<GenesisLinkKind, LinkState> = {
        md: stateOf("md"),
        finder: stateOf("finder"),
        hub: stateOf("hub"),
        "claude-find": stateOf("claude-find"),
    };

    return {
        version: 1,
        at: now,
        platform: facts.platform,
        tools: { path: facts.toolsPath },
        app: { installed: facts.appInstalled, path: genesisAppBundlePath() },
        router: {
            httpsHandler: facts.httpsHandler,
            defaultHandler: facts.httpsHandler === GENESIS_APP_BUNDLE_ID,
            configured: facts.config !== null,
            linkHost,
        },
        markdown: { path: facts.markdownPath },
        cmux: { path: facts.cmuxPath },
        links,
    };
}
