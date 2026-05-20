/**
 * Interactive menus for DashboardApp conflict / first-run prompts.
 *
 * All menus check `isInteractive()` first; non-TTY callers receive a sentinel
 * (`null` typically) and use `suggestCommand` to print the equivalent verb
 * invocation instead. Lifecycle wiring is in lifecycle.ts.
 */
import { isInteractive } from "@app/utils/cli";
import * as p from "@app/utils/prompts/p";
import type { PortConflict } from "./portConflict";

export type MineMenuChoice = "restart" | "down" | "attach" | "status" | "abort";

export async function promptMineMenu(port: number, pid: number): Promise<MineMenuChoice | null> {
    if (!isInteractive()) {
        return null;
    }

    const picked = await p.select({
        message: `Already running (pid ${pid} on :${port}). What now?`,
        options: [
            { value: "restart", label: "Restart (stop and start fresh)" },
            { value: "attach", label: "Attach to its background log" },
            { value: "status", label: "Show status" },
            { value: "down", label: "Stop it" },
            { value: "abort", label: "Abort" },
        ],
    });

    if (p.isCancel(picked)) {
        return "abort";
    }

    return picked as MineMenuChoice;
}

export type ForeignMenuChoice = "kill-and-up" | "abort";

export async function promptForeignMenu(
    port: number,
    ownerPid: number,
    ownerCommand: string,
    sameUser: boolean
): Promise<ForeignMenuChoice | null> {
    if (!isInteractive()) {
        return null;
    }

    const message = sameUser
        ? `Port ${port} is held by pid ${ownerPid} (${ownerCommand}). Kill it and start fresh?`
        : `Port ${port} is held by pid ${ownerPid} (${ownerCommand}) — owned by a different user; you may not have permission to kill it.`;

    const picked = await p.select({
        message,
        options: sameUser
            ? [
                  { value: "kill-and-up", label: "Kill the owner and start" },
                  { value: "abort", label: "Abort" },
              ]
            : [{ value: "abort", label: "Abort" }],
    });

    if (p.isCancel(picked)) {
        return "abort";
    }

    return picked as ForeignMenuChoice;
}

export async function promptLaunchdInstall(key: string): Promise<boolean | null> {
    if (!isInteractive()) {
        return null;
    }

    const picked = await p.confirm({
        message: `Install ${key} as a launchd agent so it survives reboots and restarts on crash?`,
        initialValue: false,
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return Boolean(picked);
}

export type DependencyMenuChoice = "start" | "skip";

export async function promptDependencyStart(depKey: string, parentKey: string): Promise<DependencyMenuChoice | null> {
    if (!isInteractive()) {
        return null;
    }

    const picked = await p.select({
        message: `${parentKey} depends on ${depKey}, which isn't running.`,
        options: [
            { value: "start", label: `Start ${depKey} first` },
            { value: "skip", label: `Skip — start ${parentKey} anyway` },
        ],
    });

    if (p.isCancel(picked)) {
        return "skip";
    }

    return picked as DependencyMenuChoice;
}

export function describeConflict(conflict: PortConflict): string {
    if (conflict.state === "free") {
        return "free";
    }
    if (conflict.state === "mine") {
        return `mine (pid ${conflict.pid})`;
    }
    if (conflict.owner) {
        return `foreign (pid ${conflict.owner.pid} ${conflict.owner.command})`;
    }
    return "foreign (unknown owner)";
}
