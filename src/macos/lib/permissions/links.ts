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
    if (first === "" || first.startsWith("-") || first.startsWith("genesis-tools://hub")) {
        return "face";
    }

    return first.includes("://") ? "router" : "launcher";
}

/**
 * The arguments after `MacOS/GenesisTools`, short enough to name the run: a program's own path becomes its name, and
 * Bun's `--preload <file>` pairs and the script path go, so a launcher reads `gt-cc run work --resume 86eb…`.
 */
export function holderArgs(command: string | null): string | null {
    if (command === null) {
        return null;
    }

    const words = (command.match(/MacOS\/GenesisTools(?:\s+(.*))?$/)?.[1]?.trim() ?? "").split(/\s+/).filter(Boolean);
    const kept: string[] = [];

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

        // A link's query and fragment can carry a token; the scheme, host and path name the run well enough.
        kept.push(word.includes("://") ? word.replace(/[?#].*$/, "?…") : word);
    }

    const args = kept.join(" ");
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

/**
 * Why links misbehave, or null. A launcher (or a process that could not be read) as the oldest instance drops every
 * link with "GenesisTools.app is not open anymore"; a window face raises its window on each one.
 */
export function linkRouteProblem(route: LinkRoute): string | null {
    const target = route.target;

    if (!route.known) {
        return "Launch Services could not be read (lsappinfo failed), so who takes a link is unknown.";
    }

    if (target === null || target.kind === "relay" || target.kind === "router") {
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
