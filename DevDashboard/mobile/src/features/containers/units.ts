import type { ContainerInfo } from "@dd/contract";

/**
 * Pure formatters for the containers screen. Reimplemented locally (NOT imported from `@app/*`) so
 * the RN bundle never drags web/server code in. Pure logic only — runs under `bun:test`.
 */

export const DASH = "—";

export type ContainerRunState = "running" | "stopped";

/** Docker reports `state` as a lowercase string ("running", "exited", "created", "paused", …). */
export function runState(container: Pick<ContainerInfo, "state">): ContainerRunState {
    return container.state.toLowerCase() === "running" ? "running" : "stopped";
}

/** Partition containers into running / stopped (running first), preserving input order within each. */
export function partitionByState(containers: ContainerInfo[]): { running: ContainerInfo[]; stopped: ContainerInfo[] } {
    const running: ContainerInfo[] = [];
    const stopped: ContainerInfo[] = [];

    for (const container of containers) {
        if (runState(container) === "running") {
            running.push(container);
        } else {
            stopped.push(container);
        }
    }

    return { running, stopped };
}

/** A short image label, trimming the registry host and a trailing digest (`sha256:…`). */
export function shortImage(image: string): string {
    if (!image) {
        return DASH;
    }

    const withoutDigest = image.split("@")[0];
    const segments = withoutDigest.split("/");
    return segments[segments.length - 1] || withoutDigest;
}
