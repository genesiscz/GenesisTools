import { logger } from "@app/logger";
import type { AxiosInstance } from "axios";
import type { PipelineSnapshot, Stage } from "./pipeline";

/**
 * Blue Ocean pipeline node (subset). Used only for hierarchy — wfapi remains the
 * source of truth for status/duration.
 */
export interface BlueOceanNode {
    id: string;
    displayName: string;
    type?: string;
    firstParent?: string | null;
    result?: string | null;
    state?: string | null;
}

export interface StageContext {
    /** Full ancestor chain including self, consecutive duplicate names collapsed. */
    path: string[];
    /**
     * Parallel-branch / parent scope, e.g. "fee-web" or "Repo QA".
     * Undefined for top-level sequential stages (Clone, …).
     */
    context?: string;
    /** Notification-friendly name: "fee-web · Tests" or plain "Clone". */
    label: string;
}

/**
 * Convert a classic `job/A/job/B/job/branch` path into Blue Ocean REST candidates.
 * Multibranch jobs use `/branches/<last>`; plain folder jobs use nested `/pipelines/`.
 */
export function blueOceanNodesUrls(jobPath: string, build: string): string[] {
    const parts = jobPath
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .split("/")
        .filter((p) => p && p !== "job");

    if (parts.length === 0) {
        return [];
    }

    const enc = (s: string) => encodeURIComponent(s);
    const base = "/blue/rest/organizations/jenkins";
    const q = `?limit=10000`;

    if (parts.length === 1) {
        return [`${base}/pipelines/${enc(parts[0])}/runs/${enc(build)}/nodes/${q}`];
    }

    // Prefer multibranch: last segment is the branch name.
    const branch = parts[parts.length - 1];
    const pipelineParts = parts.slice(0, -1);
    const pipelinePath = pipelineParts.map((p) => `pipelines/${enc(p)}`).join("/");
    const multibranch = `${base}/${pipelinePath}/branches/${enc(branch)}/runs/${enc(build)}/nodes/${q}`;

    // Fallback: every segment is a folder/job (no branch).
    const fullPipeline = `${base}/${parts.map((p) => `pipelines/${enc(p)}`).join("/")}/runs/${enc(build)}/nodes/${q}`;

    return [multibranch, fullPipeline];
}

export async function fetchBlueOceanNodes(
    client: AxiosInstance,
    jobPath: string,
    build: string
): Promise<BlueOceanNode[] | null> {
    const urls = blueOceanNodesUrls(jobPath, build);

    for (const url of urls) {
        try {
            const res = await client.get(url);

            if (res.status === 404) {
                continue;
            }

            if (res.status !== 200) {
                logger.debug(`[blue-ocean] ${url} → ${res.status}`);
                continue;
            }

            if (!Array.isArray(res.data)) {
                logger.debug(`[blue-ocean] ${url} returned non-array`);
                continue;
            }

            return res.data as BlueOceanNode[];
        } catch (error) {
            logger.debug(`[blue-ocean] fetch failed for ${url}: ${error instanceof Error ? error.message : error}`);
        }
    }

    return null;
}

/** Collapse consecutive duplicate names: [apps, fee-web, fee-web, Tests] → [apps, fee-web, Tests]. */
export function dedupeConsecutive(names: string[]): string[] {
    const out: string[] = [];

    for (const name of names) {
        if (out[out.length - 1] !== name) {
            out.push(name);
        }
    }

    return out;
}

/**
 * Build path/context/label for one Blue Ocean node by walking `firstParent`.
 *
 * Context prefers the nearest PARALLEL ancestor (the matrix branch: fee-web,
 * col-web, …). If none, falls back to the immediate parent stage (Repo QA · Type check).
 */
export function contextFromBlueOcean(nodeId: string, byId: Map<string, BlueOceanNode>): StageContext | null {
    const self = byId.get(nodeId);

    if (!self) {
        return null;
    }

    const chain: BlueOceanNode[] = [];
    let cur: BlueOceanNode | undefined = self;
    const seen = new Set<string>();

    while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.unshift(cur);
        cur = cur.firstParent ? byId.get(cur.firstParent) : undefined;
    }

    const path = dedupeConsecutive(chain.map((n) => n.displayName));
    const ancestors = chain.slice(0, -1);

    let context: string | undefined;
    // Nearest PARALLEL ancestor (walk from self toward root).
    for (let i = ancestors.length - 1; i >= 0; i--) {
        if (ancestors[i].type === "PARALLEL") {
            context = ancestors[i].displayName;
            break;
        }
    }

    // No parallel scope (e.g. Type check is itself PARALLEL under Repo QA) —
    // use immediate parent display name.
    if (!context && ancestors.length > 0) {
        context = ancestors[ancestors.length - 1].displayName;
    }

    // Branch shell named the same as its PARALLEL wrapper ("fee-web") — keep label plain.
    if (context === self.displayName) {
        context = undefined;
    }

    const label = context && context !== self.displayName ? `${context} · ${self.displayName}` : self.displayName;

    return { path, context, label };
}

/** Map node id → StageContext from a Blue Ocean node list. */
export function buildContextMap(nodes: BlueOceanNode[]): Map<string, StageContext> {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const map = new Map<string, StageContext>();

    for (const node of nodes) {
        const ctx = contextFromBlueOcean(node.id, byId);

        if (ctx) {
            map.set(node.id, ctx);
        }
    }

    return map;
}

export function applyContextToStage(stage: Stage, ctx: StageContext | undefined): Stage {
    if (!ctx) {
        return {
            ...stage,
            label: stage.name,
        };
    }

    return {
        ...stage,
        path: ctx.path,
        context: ctx.context,
        label: ctx.label,
    };
}

/**
 * Attach `path` / `context` / `label` from Blue Ocean onto a wfapi snapshot.
 * Soft-fails (leaves stages unlabeled beyond `label = name`) if Blue Ocean is down.
 */
export async function attachStageContext(
    client: AxiosInstance,
    jobPath: string,
    build: string,
    snap: PipelineSnapshot
): Promise<PipelineSnapshot> {
    const nodes = await fetchBlueOceanNodes(client, jobPath, build);

    if (!nodes || nodes.length === 0) {
        return {
            ...snap,
            stages: snap.stages.map((s) => applyContextToStage(s, undefined)),
        };
    }

    const map = buildContextMap(nodes);

    return {
        ...snap,
        stages: snap.stages.map((s) => applyContextToStage(s, map.get(s.id))),
    };
}
