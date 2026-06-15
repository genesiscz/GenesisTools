import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { classifyAgentState } from "../classify";
import type { AgentSnapshot } from "../types";

export function defaultWorkflowRoot(): string {
    return join(homedir(), ".claude", "projects");
}

interface ReadWorkflowOptions {
    root?: string;
    now: number;
    stallTimeoutMs: number;
}

/**
 * Workflow transcripts live at projects/<proj>/<session>/subagents/workflows/**.
 * We treat each leaf workflow dir as one agent and classify by its mtime alone
 * (no per-event parse needed for v1 — a workflow dir untouched past the timeout
 * is STALLED; otherwise RUNNING). Exit detection for workflows is out of scope v1.
 */
export async function readWorkflowSnapshots(opts: ReadWorkflowOptions): Promise<AgentSnapshot[]> {
    const root = opts.root ?? defaultWorkflowRoot();

    if (!existsSync(root)) {
        logger.debug({ root }, "workflow source root missing; skipping");
        return [];
    }

    const snapshots: AgentSnapshot[] = [];
    let projectDirs: import("node:fs").Dirent[] = [];

    try {
        projectDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch (err) {
        logger.debug({ err, root }, "could not list workflow projects root");
        return [];
    }

    for (const projDir of projectDirs) {
        const sessionsRoot = join(root, projDir.name);
        let sessionDirs: string[] = [];

        try {
            sessionDirs = readdirSync(sessionsRoot, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch (err) {
            logger.debug({ err, sessionsRoot }, "could not list workflow sessions");
            continue;
        }

        for (const session of sessionDirs) {
            const wfRoot = join(sessionsRoot, session, "subagents", "workflows");

            if (!existsSync(wfRoot)) {
                continue;
            }

            let leaves: string[] = [];

            try {
                leaves = readdirSync(wfRoot, { withFileTypes: true })
                    .filter((d) => d.isDirectory())
                    .map((d) => d.name);
            } catch (err) {
                logger.debug({ err, wfRoot }, "could not list workflow leaves");
                continue;
            }

            for (const leaf of leaves) {
                const leafPath = join(wfRoot, leaf);

                try {
                    const lastModified = statSync(leafPath).mtimeMs;
                    const state = classifyAgentState({
                        events: [],
                        lastModified,
                        now: opts.now,
                        stallTimeoutMs: opts.stallTimeoutMs,
                        pidAlive: true,
                    });

                    snapshots.push({
                        id: `workflows:${projDir.name}/${session}/${leaf}`,
                        name: leaf,
                        source: "workflows",
                        state,
                        lastOutputAt: lastModified,
                        ageMs: opts.now - lastModified,
                    });
                } catch (err) {
                    logger.debug({ err, leafPath }, "failed to stat workflow leaf; skipping");
                }
            }
        }
    }

    return snapshots;
}
