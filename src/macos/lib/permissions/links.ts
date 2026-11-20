import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import { type RunningApplication, runningApplications } from "@genesiscz/utils/macos/launch-services";
import { childPids, readProcessRows, signalProcessTree } from "@genesiscz/utils/process/processes";

/**
 * What a GenesisTools.app process is, read from its command line: the link relay (`--link-relay`), a face (no argument
 * or a flag), a link router (`GenesisTools https://…`), or a launcher (`GenesisTools <program> …`, every `tools` run).
 * Only the relay, a face and a router take a link; a launcher has no event loop, so a link sent to it fails with -600.
 */
export type LinkHolderKind = "relay" | "face" | "router" | "launcher" | "unknown";

export interface LinkHolder {
    pid: number;
    kind: LinkHolderKind;
    /** The arguments after `MacOS/GenesisTools`, cut to 100 characters; null when the process could not be read. */
    args: string | null;
    startMs: number | null;
}

/**
 * Where macOS sends a link. Launch Services hands every link, banner click and Dock reopen to the bundle's OLDEST
 * running instance (LinkRelay.swift), and to a launcher too: on 2026-11-17 a probe app's older background-only
 * instance took the link, failed with -600 and turned into a UIElement, as a Claude session's launcher did that day.
 */
export interface LinkRoute {
    /** False when Launch Services could not be read (`lsappinfo` failed): then nothing below is known. */
    known: boolean;
    /** The oldest instance; null when none runs and macOS starts a router for each link. */
    target: LinkHolder | null;
    relay: LinkHolder | null;
    /** The instances that checked in before the relay, oldest first. Each takes every link until it exits. */
    olderThanRelay: LinkHolder[];
}

export function linkHolderKind(command: string | null): LinkHolderKind {
    if (command === null) {
        return "unknown";
    }

    const args = command.match(/MacOS\/GenesisTools(?:\s+(.*))?$/)?.[1]?.trim() ?? "";
    const first = args.split(/\s+/)[0] ?? "";

    if (first === "--link-relay") {
        return "relay";
    }

    // A hub link starts the hub window in the process it reached (HostMain.swift), so that process is a face.
    // lint-rules-ignore: reads a process's argument, builds no link
    if (first === "" || first.startsWith("-") || first.startsWith("genesis-tools://hub")) {
        return "face";
    }

    return first.includes("://") ? "router" : "launcher";
}

/** A word that names a subcommand (`run`, `work`, `hub-link`), not data. */
const COMMAND_WORD = /^[a-z][a-z0-9-]{0,23}$/;
/** A bare flag name; a flag with `=` or any value after it can carry a token, a prompt or a path. */
const BARE_FLAG = /^--?[A-Za-z][A-Za-z0-9-]*$/;
const SUBCOMMANDS_SHOWN = 2;

/**
 * A safe label for the run after `MacOS/GenesisTools`, for status output and logs: the program's name, up to two
 * subcommand words, and bare flag names. Every value, prompt, path and other word goes, shown once as `…`, so a
 * launcher reads `gt-cc run work --resume …`; a link keeps its scheme, host and path. Bun's `--preload <file>` pairs
 * and the script path go without a mark.
 */
export function holderArgs(command: string | null): string | null {
    if (command === null) {
        return null;
    }

    const words = (command.match(/MacOS\/GenesisTools(?:\s+(.*))?$/)?.[1]?.trim() ?? "").split(/\s+/).filter(Boolean);
    const kept: string[] = [];
    let subcommands = 0;
    let sawFlag = false;
    let dropped = false;

    for (let index = 0; index < words.length; index++) {
        const word = words[index];

        if (word === "--preload") {
            index++;
            continue;
        }

        if (kept.length === 0 && word.startsWith("/")) {
            kept.push(word.slice(word.lastIndexOf("/") + 1));
            continue;
        }

        if (kept.length === 1 && /\.(ts|tsx|js|mjs)$/.test(word) && !word.startsWith("-")) {
            continue;
        }

        if (kept.length === 0 && word.includes("://")) {
            // A link's query and fragment can carry a token; the scheme, host and path name the run well enough.
            kept.push(word.replace(/[?#].*$/, "?…"));
            continue;
        }

        if (BARE_FLAG.test(word)) {
            kept.push(word);
            sawFlag = true;
            continue;
        }

        if (kept.length === 0 && COMMAND_WORD.test(word)) {
            kept.push(word);
            continue;
        }

        if (!sawFlag && subcommands < SUBCOMMANDS_SHOWN && COMMAND_WORD.test(word)) {
            kept.push(word);
            subcommands++;
            continue;
        }

        dropped = true;
    }

    const args = [...kept, ...(dropped ? ["…"] : [])].join(" ");
    return args.length > 100 ? `${args.slice(0, 99)}…` : args;
}

export function linkRoute(
    instances: Pick<RunningApplication, "pid" | "order">[],
    processes: Map<number, { command: string | null; startMs: number | null }>
): LinkRoute {
    const holders = [...instances]
        .sort((left, right) => left.order - right.order)
        .map((app): LinkHolder => {
            const row = processes.get(app.pid);
            const command = row?.command ?? null;
            return {
                pid: app.pid,
                kind: linkHolderKind(command),
                args: holderArgs(command),
                startMs: row?.startMs ?? null,
            };
        });
    const relayIndex = holders.findIndex((holder) => holder.kind === "relay");

    return {
        known: true,
        target: holders[0] ?? null,
        relay: relayIndex >= 0 ? holders[relayIndex] : null,
        olderThanRelay: relayIndex > 0 ? holders.slice(0, relayIndex) : [],
    };
}

/** The route on this Mac now: one `lsappinfo list` and the command lines of the bundle's instances. */
export function currentLinkRoute(bundleId = GENESIS_APP_BUNDLE_ID): LinkRoute {
    const instances = runningApplications(bundleId);

    if (instances === null) {
        return { known: false, target: null, relay: null, olderThanRelay: [] };
    }

    const rows = readProcessRows(instances.map((app) => app.pid));
    const processes = new Map(
        [...rows].map(([pid, row]) => [pid, { command: row.command, startMs: row.startTime?.getTime() ?? null }])
    );
    const route = linkRoute(instances, processes);
    logger.debug(
        {
            target: route.target && { pid: route.target.pid, kind: route.target.kind },
            relay: route.relay?.pid,
            olderThanRelay: route.olderThanRelay.length,
        },
        "links: route read"
    );
    return route;
}

function when(startMs: number | null): string {
    return startMs === null
        ? "start unknown"
        : `started ${new Date(startMs).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}`;
}

/** One line for `app:status` and the build: who takes a link now. */
export function describeLinkRoute(route: LinkRoute): string {
    const target = route.target;

    if (!route.known) {
        return "unknown: Launch Services could not be read (lsappinfo failed)";
    }

    if (target === null) {
        return "no GenesisTools process runs: macOS starts a router for each link";
    }

    if (target.kind === "relay") {
        return `the link relay takes them (pid ${target.pid})`;
    }

    return `pid ${target.pid} takes them (${target.kind}: ${target.args ?? "?"}, ${when(target.startMs)})`;
}

/** A router hands its link on and exits within seconds; one older than this is stuck (`.claude/rules/macos.md`). */
const STUCK_ROUTER_MS = 60_000;

/**
 * Why links misbehave, or null. A launcher (or a process that could not be read) as the oldest instance drops every
 * link with "GenesisTools.app is not open anymore"; a window face raises its window on each one; a router that lived
 * past a minute has no handler for the links it takes, so each one vanishes.
 */
export function linkRouteProblem(route: LinkRoute, now = Date.now()): string | null {
    const target = route.target;

    if (!route.known) {
        return "Launch Services could not be read (lsappinfo failed), so who takes a link is unknown.";
    }

    if (target?.kind === "router") {
        if (target.startMs === null || now - target.startMs < STUCK_ROUTER_MS) {
            return null;
        }

        return `macOS hands every link to pid ${target.pid}, a STUCK LINK ROUTER (${target.args ?? "?"}, ${when(target.startMs)}). A router quits within seconds; this one has no handler for the links it takes, so each click vanishes. Stop it with: kill ${target.pid}`;
    }

    if (target === null || target.kind === "relay") {
        return null;
    }

    if (target.kind === "face") {
        return `macOS hands every link to the window face pid ${target.pid} (${target.args}), which is older than the link relay, so each link raises that window. Reopen that face (close and open it again) to put the relay in front.`;
    }

    const dropping = route.olderThanRelay.filter((holder) => holder.kind === "launcher" || holder.kind === "unknown");
    const all = dropping.length > 0 ? dropping : [target];
    const list = all.map((holder) => `${holder.pid} (${holder.args ?? "?"}, ${when(holder.startMs)})`).join("; ");
    return `macOS hands every link and banner click to pid ${target.pid}, a launcher that checked in with Launch Services before the link relay. A launcher has no event loop, so each click ends in "GenesisTools.app is not open anymore". Links reach the relay again when these ${all.length} launcher(s) exit: ${list}. Launchers of a build made after 2026-11-17 never check in.`;
}

/**
 * Runs `<launcher> /bin/sleep 30` and asks Launch Services whether that launcher run checked in. One that does becomes
 * the oldest instance as soon as a rebuild restarts the link relay, and from then on it takes every link. True when it
 * checked in, false when not, null when the run did not reach its program within the deadline, the inventory could not
 * be read, or the run ended before the inventory was read (then its absence proves nothing). The run is stopped once
 * the answer is in, so the sleep only has to outlast `lsappinfo` (5 s at most).
 */
export async function launcherChecksIn(
    launcherPath: string,
    { bundleId = GENESIS_APP_BUNDLE_ID, deadlineMs = 10_000 }: { bundleId?: string; deadlineMs?: number } = {}
): Promise<boolean | null> {
    const child = Bun.spawn([launcherPath, "/bin/sleep", "30"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
    const deadline = Date.now() + deadlineMs;

    try {
        // The launcher marks itself (or not) before it starts its program, so a running `sleep` means the answer is in.
        while (childPids(child.pid).length === 0) {
            if (Date.now() >= deadline || child.exitCode !== null) {
                logger.warn(
                    { pid: child.pid, exitCode: child.exitCode },
                    "links: the launcher check never reached its program"
                );
                return null;
            }

            await Bun.sleep(100);
        }

        const instances = runningApplications(bundleId);

        if (instances === null || child.exitCode !== null) {
            logger.warn(
                { pid: child.pid, exitCode: child.exitCode, inventoryRead: instances !== null },
                "links: the launcher check could not read Launch Services while the launcher ran"
            );
            return null;
        }

        return instances.some((app) => app.pid === child.pid);
    } finally {
        signalProcessTree(child.pid, { includeSelf: true });
        const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);

        if (!exited) {
            child.kill("SIGKILL");
        }
    }
}

/** What every app build reports about links (`buildApp`), for the caller to show. */
export interface BuildLinkCheck {
    /** Whether a launcher run of the new bundle checked in with Launch Services (`launcherChecksIn`). */
    launcherChecksIn: boolean | null;
    /** `describeLinkRoute` after the build. */
    route: string;
    /** `linkRouteProblem` after the build, or null. */
    problem: string | null;
}

/** The launcher check and the link route after a build. A launcher run that checks in is logged as an error. */
export async function checkBuildLinks(bundlePath: string): Promise<BuildLinkCheck> {
    const checksIn = await launcherChecksIn(join(bundlePath, "Contents/MacOS/GenesisTools"));

    if (checksIn === true) {
        logger.error({ bundlePath }, "links: a launcher run of the new build checks in with Launch Services");
    }

    const route = currentLinkRoute();
    return { launcherChecksIn: checksIn, route: describeLinkRoute(route), problem: linkRouteProblem(route) };
}
