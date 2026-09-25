import {
    type RouteDecision,
    RouteError,
    type RouterConfig,
    route,
    routeMintedUrl,
} from "@genesiscz/utils/browser-router/route";
import { takeToken, withTokenLock } from "@genesiscz/utils/browser-router/tokens";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import { confirmDialog, type OpenBundleDeps, openBundle } from "./tabs";

/** What a click on a minted link does. A bundle's use is not spent yet: see `spendBundleUse`. */
export type MintedLinkPlan =
    | { kind: "perform"; decision: RouteDecision }
    | { kind: "app"; url: string }
    | { kind: "bundle"; urls: string[] };

/**
 * Spends one use of a minted link (`https://genesis.tools/t/<id>`) and decides what to do with its URL.
 * A decision that asks first goes back to GenesisTools.app, because only the app shows the approval
 * card; this process has no prompt of its own. A bundle is only peeked: a click above the tab cap
 * asks first, and a cancel must leave the use for another click.
 */
export function redeemMintedLink(id: string, config: RouterConfig): Promise<MintedLinkPlan> {
    return withTokenLock(() => redeemLocked(id, config));
}

/** Spends the one use a bundle click costs, after its confirmation and before its first launch. */
export async function spendBundleUse(id: string): Promise<void> {
    await withTokenLock(() => {
        if (!takeToken(id, true)) {
            throw new RouteError("link used up");
        }
    });
}

function redeemLocked(id: string, config: RouterConfig): MintedLinkPlan {
    const peeked = takeToken(id, false);

    if (!peeked) {
        throw new RouteError("link used up");
    }

    // A bundle spends one use for all of its links; each link is routed when it opens.
    if (peeked.urls) {
        return { kind: "bundle", urls: peeked.urls };
    }

    // Routed before the use is spent, so a config error does not burn the link.
    const decision = routeMintedUrl(peeked.url, config);

    if (!takeToken(id, true)) {
        throw new RouteError("link used up");
    }

    if (asksFirst(decision)) {
        return { kind: "app", url: peeked.url };
    }

    return { kind: "perform", decision };
}

/** Only GenesisTools.app shows the approval card, so a decision that needs it cannot run from the CLI. */
function asksFirst(decision: RouteDecision): boolean {
    return decision.kind === "tool" || (decision.kind === "run" && decision.needsApproval);
}

/**
 * `tools browser-router open`: it acts, so a minted link spends a use. A decision that asks is refused
 * before the use is spent, because this process has no approval card.
 */
export async function openUrl(url: string, config: RouterConfig): Promise<void> {
    const decision = await withTokenLock(() => {
        if (asksFirst(route(url, config))) {
            throw new RouteError(`${url} asks before it runs; click it so GenesisTools.app can show the card`);
        }

        return route(url, config, true, true);
    });

    await perform(decision);
}

export async function openMintedLink(
    id: string,
    config: RouterConfig,
    deps: Pick<OpenBundleDeps, "open" | "confirm"> = { open: launchOpen, confirm: confirmDialog }
): Promise<void> {
    const plan = await redeemMintedLink(id, config);

    if (plan.kind === "app") {
        logger.debug(`browser-router: minted link asks first, handing ${plan.url} to GenesisTools.app`);
        await deps.open(["-b", GENESIS_APP_BUNDLE_ID, plan.url]);
        return;
    }

    if (plan.kind === "bundle") {
        await openBundle(plan.urls, config, { ...deps, beforeOpen: () => spendBundleUse(id) });
        return;
    }

    logger.debug(`browser-router: minted link runs ${plan.decision.kind} via ${plan.decision.via}`);
    await perform(plan.decision);
}

export async function perform(decision: RouteDecision): Promise<void> {
    if (decision.kind === "run") {
        if (decision.needsApproval) {
            throw new Error(`route ${decision.routeIndex} asks before running ${decision.argv.join(" ")}`);
        }

        await runChecked(decision.argv, "command");

        if (decision.browserArguments.length > 0) {
            await launchOpen(decision.browserArguments);
        }

        return;
    }

    if (decision.kind === "tool") {
        // A tool route always asks (`needsApproval: true` in its type), and only the app shows the card.
        throw new Error(
            `route ${decision.routeIndex} asks before running tools ${decision.tool} ${decision.args.join(" ")}`
        );
    }

    if (decision.openArguments.length === 0) {
        logger.info(`browser-router swallowed ${decision.original}`);
        return;
    }

    await launchOpen(decision.openArguments);
}

export async function launchOpen(args: string[]): Promise<void> {
    await runChecked(["/usr/bin/open", ...args], "open");
}

/**
 * Runs `argv` and throws its stderr when it fails. stdout is not read, so it is not piped; stderr is
 * read while the process runs, because a pipe nobody drains blocks the child once it fills (64 KB)
 * and `exited` then never resolves.
 */
export async function runChecked(argv: string[], label: string): Promise<void> {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    if (code !== 0) {
        throw new Error(stderr.trim() || `${label} exited ${code}`);
    }
}
