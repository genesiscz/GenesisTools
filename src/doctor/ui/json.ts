import type { Analyzer } from "@app/doctor/lib/analyzer";
import { Engine } from "@app/doctor/lib/engine";
import { isActable, metadataPaths, pathsHash } from "@app/doctor/lib/remove-action";
import { lastScanGate, type ScanGateState } from "@app/doctor/lib/scan-gate";
import type { Action, ConfirmMode, Finding, RemoveMethod, Severity } from "@app/doctor/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

export interface JsonRunOpts {
    analyzers: Analyzer[];
    runId: string;
    only?: string[];
    thorough: boolean;
    fresh: boolean;
    dryRun: boolean;
}

export const DOCTOR_JSON_SCHEMA_VERSION = 1;

export interface JsonAction {
    id: string;
    label: string;
    confirm: ConfirmMode;
    confirmPhrase?: string;
    staged: boolean;
    /** "remove-path" and "command" actions run through `doctor act`; "other" ones (reveal, kill, install) never do. */
    kind: "remove-path" | "command" | "other";
    method?: RemoveMethod;
    actable: boolean;
}

export interface JsonFinding {
    id: string;
    analyzerId: string;
    title: string;
    detail?: string;
    severity: Severity;
    reclaimableBytes?: number;
    blacklistReason?: string;
    fromCache: boolean;
    /** `sha256:` of the sorted `metadata.paths`; pass it back as `doctor act --expect-paths <id>=<hash>`. Null when the
     *  finding names no paths. */
    pathsHash: string | null;
    availableActionIds: string[];
    actions: JsonAction[];
    metadata?: Record<string, unknown>;
}

export interface DoctorJsonDocument {
    schemaVersion: typeof DOCTOR_JSON_SCHEMA_VERSION;
    runId: string;
    startedAt: string;
    endedAt: string;
    analyzers: string[];
    /** Null when no analyzer of this run read the gate. */
    scanGate: ScanGateState | null;
    findings: JsonFinding[];
    errors: Array<{ analyzerId: string; error: string }>;
}

export function toJsonAction(action: Action): JsonAction {
    return {
        id: action.id,
        label: action.label,
        confirm: action.confirm,
        ...(action.confirmPhrase !== undefined ? { confirmPhrase: action.confirmPhrase } : {}),
        staged: Boolean(action.staged),
        kind: action.kind ?? "other",
        ...(action.method !== undefined ? { method: action.method } : {}),
        actable: isActable(action),
    };
}

export function toJsonFinding(finding: Finding, fromCache: boolean): JsonFinding {
    return {
        id: finding.id,
        analyzerId: finding.analyzerId,
        title: finding.title,
        detail: finding.detail,
        severity: finding.severity,
        reclaimableBytes: finding.reclaimableBytes,
        blacklistReason: finding.blacklistReason,
        fromCache,
        pathsHash: metadataPaths(finding).length > 0 ? pathsHash(metadataPaths(finding)) : null,
        availableActionIds: finding.actions.map((a) => a.id),
        actions: finding.actions.map(toJsonAction),
        metadata: finding.metadata,
    };
}

/** The `--json` document: runs the selected analyzers and collects their findings and errors. */
export async function buildJsonDocument(opts: JsonRunOpts): Promise<DoctorJsonDocument> {
    const selected =
        opts.only && opts.only.length > 0 ? opts.analyzers.filter((a) => opts.only!.includes(a.id)) : opts.analyzers;
    const engine = new Engine();
    const findings: Finding[] = [];
    const cachedIds = new Set<string>();
    const errors: Array<{ analyzerId: string; error: string }> = [];

    engine.on("event", (event) => {
        if (event.type === "finding") {
            findings.push(event.finding);

            if (event.fromCache) {
                cachedIds.add(event.finding.id);
            }
        }

        if (event.type === "analyzer-done" && event.error) {
            errors.push({ analyzerId: event.analyzerId, error: String(event.error) });
        }
    });

    const startedAt = new Date();
    await engine.run(selected, {
        concurrency: 4,
        thorough: opts.thorough,
        fresh: opts.fresh,
        runId: opts.runId,
        dryRun: opts.dryRun,
    });

    return {
        schemaVersion: DOCTOR_JSON_SCHEMA_VERSION,
        runId: opts.runId,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        analyzers: selected.map((a) => a.id),
        scanGate: lastScanGate(),
        findings: findings.map((f) => toJsonFinding(f, cachedIds.has(f.id))),
        errors,
    };
}

export async function runJson(opts: JsonRunOpts): Promise<void> {
    out.println(SafeJSON.stringify(await buildJsonDocument(opts), null, 2));
}
