/**
 * SeedOperation — Shared orchestration component for all seed commands
 *
 * Orchestrates the full seed lifecycle:
 * 1. Render Header + TargetInfo
 * 2. Connect to database
 * 3. Run SeedAnalyzer (optional)
 * 4. Show preview Table + Warnings + SummaryLine
 * 5. Show Confirm (tier based on risk + production detection)
 * 6. Execute seed method with ProgressSteps
 * 7. Show results or ErrorPanel
 */

import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DataSource } from "typeorm";
import type { AnalysisResult, ExecutionResult, SeedType } from "#api/database/seeds/cli/types.js";
import { createDataSource } from "../lib/database.js";
import { detectEnvironment, getDatabaseUrl } from "../lib/env.js";
import { formatDuration } from "../lib/format.js";
import { addHistoryEntry } from "../lib/history.js";
import { PREVIEW_COLUMNS } from "../lib/table-columns.js";
import { Confirm } from "./confirm.js";
import { ErrorPanel } from "./error-panel.js";
import { Header } from "./header.js";
import { ProgressSteps, type StepProps } from "./progress-steps.js";
import { SummaryLine } from "./summary-line.js";
import { Table } from "./table.js";
import { TargetInfo } from "./target-info.js";
import { Warnings } from "./warnings.js";

// ── Types ───────────────────────────────────────────────────────────────────

type Phase = "connecting" | "analyzing" | "preview" | "confirming" | "executing" | "done" | "cancelled" | "error";

interface SeedOperationState {
    phase: Phase;
    dataSource: DataSource | null;
    analysisResults: AnalysisResult[];
    executionResults: ExecutionResult[];
    error: Error | null;
    steps: StepProps[];
    startTime: number | null;
    duration: number | null;
}

type SeedAction =
    | { type: "CONNECTED"; dataSource: DataSource }
    | { type: "ANALYZED"; results: AnalysisResult[] }
    | { type: "CONFIRMED" }
    | { type: "CANCELLED" }
    | { type: "EXECUTING"; steps: StepProps[] }
    | { type: "STEP_UPDATE"; index: number; step: Partial<StepProps> }
    | { type: "DONE"; results: ExecutionResult[]; duration: number }
    | { type: "ERROR"; error: Error }
    | { type: "SKIP_ANALYSIS" };

function reducer(state: SeedOperationState, action: SeedAction): SeedOperationState {
    switch (action.type) {
        case "CONNECTED":
            return { ...state, phase: "analyzing", dataSource: action.dataSource };
        case "ANALYZED":
            return { ...state, phase: "preview", analysisResults: action.results };
        case "SKIP_ANALYSIS":
            return { ...state, phase: "confirming" };
        case "CONFIRMED":
            return { ...state, phase: "executing", startTime: Date.now() };
        case "CANCELLED":
            return { ...state, phase: "cancelled" };
        case "EXECUTING":
            return { ...state, steps: action.steps };
        case "STEP_UPDATE": {
            const steps = [...state.steps];
            steps[action.index] = { ...steps[action.index]!, ...action.step };
            return { ...state, steps };
        }
        case "DONE":
            return {
                ...state,
                phase: "done",
                executionResults: action.results,
                duration: action.duration,
            };
        case "ERROR":
            return { ...state, phase: "error", error: action.error };
        default:
            return state;
    }
}

const initialState: SeedOperationState = {
    phase: "connecting",
    dataSource: null,
    analysisResults: [],
    executionResults: [],
    error: null,
    steps: [],
    startTime: null,
    duration: null,
};

// ── Props ───────────────────────────────────────────────────────────────────

export interface SeedOperationProps {
    /** Display name for the operation (e.g. "Categories", "Demo Data") */
    name: string;
    /** Seed type for the analyzer */
    seedType?: SeedType;
    /** The seed method to execute. Receives the DataSource. */
    seedMethod: (dataSource: DataSource) => Promise<void>;
    /** Optional custom analyze method. If omitted, uses SeedAnalyzer. */
    analyzeMethod?: (dataSource: DataSource) => Promise<AnalysisResult[]>;
    /** Override confirmation tier. Defaults to risk-based. */
    confirmTier?: "safe" | "moderate" | "destructive";
    /** Emoji for the header */
    emoji?: string;
    /** Subtitle for the header */
    subtitle?: string;
    /** Auto-confirm (from --yes flag) */
    autoConfirm?: boolean;
    /** Dry-run mode (from --dry-run flag) */
    dryRun?: boolean;
    /** Called when operation completes (success or error) */
    onComplete?: (success: boolean) => void;
}

// ── Component ───────────────────────────────────────────────────────────────

export function SeedOperation({
    name,
    seedType,
    seedMethod,
    analyzeMethod,
    confirmTier,
    emoji = "\uD83C\uDF31",
    subtitle,
    autoConfirm = false,
    dryRun = false,
    onComplete,
}: SeedOperationProps) {
    const { exit } = useApp();
    const [state, dispatch] = useReducer(reducer, initialState);
    const dataSourceRef = useRef<DataSource | null>(null);
    const env = detectEnvironment();
    const databaseUrl = getDatabaseUrl();

    // ── Phase 1: Connect ────────────────────────────────────────────────────
    useEffect(() => {
        if (state.phase !== "connecting") {
            return;
        }

        let cancelled = false;
        const ds = createDataSource();
        dataSourceRef.current = ds;

        ds.initialize()
            .then(() => {
                if (!cancelled) {
                    dispatch({ type: "CONNECTED", dataSource: ds });
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    dispatch({
                        type: "ERROR",
                        error: err instanceof Error ? err : new Error(String(err)),
                    });
                }
            });

        return () => {
            cancelled = true;
            // If cancelled during connecting, destroy the DataSource
            if (ds.isInitialized) {
                ds.destroy().catch(() => {});
            }
        };
    }, [state.phase]);

    // ── Phase 2: Analyze ───────────────────────────────────────────────────
    useEffect(() => {
        if (state.phase !== "analyzing" || !state.dataSource) {
            return;
        }

        let cancelled = false;

        async function analyze() {
            try {
                let results: AnalysisResult[];

                if (analyzeMethod) {
                    results = await analyzeMethod(state.dataSource!);
                } else if (seedType) {
                    // Dynamic import to avoid loading analyzer unless needed
                    const { SeedAnalyzer } = await import("#api/database/seeds/cli/analyzer.js");
                    const analyzer = new SeedAnalyzer(state.dataSource!);
                    results = await analyzer.analyze(seedType);
                } else {
                    // No analysis needed — skip to confirm
                    if (!cancelled) {
                        dispatch({ type: "SKIP_ANALYSIS" });
                    }
                    return;
                }

                if (!cancelled) {
                    dispatch({ type: "ANALYZED", results });
                }
            } catch (err: unknown) {
                if (!cancelled) {
                    dispatch({
                        type: "ERROR",
                        error: err instanceof Error ? err : new Error(String(err)),
                    });
                }
            }
        }

        analyze();

        return () => {
            cancelled = true;
        };
    }, [state.phase, state.dataSource, seedType, analyzeMethod]);

    // ── Confirm handler ─────────────────────────────────────────────────────
    const handleConfirm = useCallback(() => {
        dispatch({ type: "CONFIRMED" });
    }, []);

    const handleCancel = useCallback(() => {
        dispatch({ type: "CANCELLED" });
    }, []);

    // ── Phase 3: Execute ──────────────────────────────────────────────────
    useEffect(() => {
        if (state.phase !== "executing" || !state.dataSource) {
            return;
        }

        let cancelled = false;

        async function execute() {
            const startTime = Date.now();

            // Build steps from analysis results
            const entitySteps: StepProps[] =
                state.analysisResults.length > 0
                    ? state.analysisResults.map((r) => ({ label: `Seed ${r.entity}`, status: "pending" as const }))
                    : [{ label: `Execute ${name}`, status: "running" as const }];

            dispatch({ type: "EXECUTING", steps: entitySteps });

            try {
                await seedMethod(state.dataSource!);

                const durationMs = Date.now() - startTime;

                // Build execution results from analysis
                const results: ExecutionResult[] = state.analysisResults.map((r) => ({
                    entity: r.entity,
                    created: r.toCreate,
                    updated: r.toUpdate,
                    skipped: r.toSkip,
                    errors: [],
                }));

                if (!cancelled) {
                    // Mark all steps as completed
                    entitySteps.forEach((_, i) => {
                        dispatch({
                            type: "STEP_UPDATE",
                            index: i,
                            step: { status: "completed", duration: durationMs },
                        });
                    });

                    dispatch({ type: "DONE", results, duration: durationMs });
                }
            } catch (err: unknown) {
                if (!cancelled) {
                    dispatch({
                        type: "ERROR",
                        error: err instanceof Error ? err : new Error(String(err)),
                    });
                }
            }
        }

        execute();

        return () => {
            cancelled = true;
        };
    }, [state.phase, state.dataSource, state.analysisResults, name, seedMethod]);

    // ── Cleanup on unmount ──────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            const ds = dataSourceRef.current;
            if (ds?.isInitialized) {
                ds.destroy().catch(() => {});
                dataSourceRef.current = null;
            }
        };
    }, []);

    // ── Record history + notify completion ──────────────────────────────────
    useEffect(() => {
        if (state.phase === "done" || state.phase === "error" || state.phase === "cancelled") {
            addHistoryEntry({
                command: `fixit seed ${seedType ?? name.toLowerCase()}`,
                timestamp: new Date().toISOString(),
                duration: state.duration ?? undefined,
                success: state.phase === "done",
            });
            onComplete?.(state.phase === "done");
            const timer = setTimeout(() => exit(), 100);
            return () => clearTimeout(timer);
        }
    }, [state.phase, exit, onComplete, seedType, name, state.duration]);

    // ── Determine confirmation tier ─────────────────────────────────────────
    function getConfirmTier(): "safe" | "moderate" | "destructive" {
        if (confirmTier) {
            return confirmTier;
        }

        // Determine from analysis results risk
        const maxRisk = state.analysisResults.reduce<string>((max, r) => {
            if (r.risk === "destructive") {
                return "destructive";
            }
            if (r.risk === "new" && max !== "destructive") {
                return "new";
            }
            return max;
        }, "safe");

        if (maxRisk === "destructive") {
            return "destructive";
        }
        if (maxRisk === "new") {
            return "moderate";
        }
        return "safe";
    }

    const previewData = state.analysisResults.map((r) => ({
        entity: r.entity,
        create: String(r.toCreate),
        update: String(r.toUpdate),
        skip: String(r.toSkip),
        risk: r.risk.toUpperCase(),
    }));

    // ── Result table columns ──────────────────────────────────────────────
    const resultColumns = [
        { key: "entity", label: "Entity", minWidth: 12 },
        { key: "created", label: "Created", minWidth: 8, align: "right" as const, color: "green" },
        { key: "updated", label: "Updated", minWidth: 8, align: "right" as const, color: "yellow" },
        { key: "skipped", label: "Skipped", minWidth: 8, align: "right" as const, color: "gray" },
    ];

    const resultData = state.executionResults.map((r) => ({
        entity: r.entity,
        created: String(r.created),
        updated: String(r.updated),
        skipped: String(r.skipped),
    }));

    // ── Render ─────────────────────────────────────────────────────────────

    return (
        <Box flexDirection="column" gap={1}>
            <Header title={`FixIt Seeder - ${name}`} emoji={emoji} subtitle={subtitle} />
            <TargetInfo databaseUrl={databaseUrl} envName={env.envName} isProduction={env.isProduction} />

            {/* Connecting phase */}
            {state.phase === "connecting" && (
                <ProgressSteps steps={[{ label: "Connecting to database", status: "running" }]} />
            )}

            {/* Analyzing phase */}
            {state.phase === "analyzing" && (
                <ProgressSteps
                    steps={[
                        { label: "Connected to database", status: "completed" },
                        { label: "Analyzing seed data", status: "running" },
                    ]}
                />
            )}

            {/* Preview phase */}
            {state.phase === "preview" && (
                <>
                    <ProgressSteps
                        steps={[
                            { label: "Connected to database", status: "completed" },
                            { label: "Analysis complete", status: "completed" },
                        ]}
                    />

                    {state.analysisResults.length > 0 && (
                        <>
                            <Table columns={PREVIEW_COLUMNS} data={previewData} />
                            <Warnings warnings={state.analysisResults.flatMap((r) => r.warnings)} />
                            <SummaryLine results={state.analysisResults} />
                        </>
                    )}

                    {dryRun ? (
                        <Box>
                            <Text color="yellow">{"\u26A0"} Dry run — no changes made</Text>
                        </Box>
                    ) : (
                        <Confirm
                            tier={getConfirmTier()}
                            message={`This will modify the ${env.envName} database.`}
                            confirmText={env.isProduction ? env.envName : "CONFIRM"}
                            onConfirm={handleConfirm}
                            onCancel={handleCancel}
                            autoConfirm={autoConfirm}
                            isProduction={env.isProduction}
                        />
                    )}
                </>
            )}

            {/* Confirming phase (no analysis) */}
            {state.phase === "confirming" &&
                (dryRun ? (
                    <Box>
                        <Text color="yellow">{"\u26A0"} Dry run — no changes made</Text>
                    </Box>
                ) : (
                    <Confirm
                        tier={confirmTier ?? "moderate"}
                        message={`This will modify the ${env.envName} database.`}
                        confirmText={env.isProduction ? env.envName : "CONFIRM"}
                        onConfirm={handleConfirm}
                        onCancel={handleCancel}
                        autoConfirm={autoConfirm}
                        isProduction={env.isProduction}
                    />
                ))}

            {/* Executing phase */}
            {state.phase === "executing" && state.steps.length > 0 && <ProgressSteps steps={state.steps} />}

            {/* Done phase */}
            {state.phase === "done" && (
                <>
                    {resultData.length > 0 && <Table columns={resultColumns} data={resultData} />}
                    <Box>
                        <Text color="green">
                            {"\u2713"} {name} completed successfully
                            {state.duration !== null && ` in ${formatDuration(state.duration)}`}
                        </Text>
                    </Box>
                </>
            )}

            {/* Cancelled */}
            {state.phase === "cancelled" && (
                <Box>
                    <Text color="yellow">{"\u26A0"} Operation cancelled</Text>
                </Box>
            )}

            {/* Error phase */}
            {state.phase === "error" && state.error && (
                <ErrorPanel
                    title={`${name} Failed`}
                    error={state.error}
                    suggestion="Check if Docker containers are running and DATABASE_URL is set"
                    retryCommand={`fixit seed ${seedType ?? name.toLowerCase()}`}
                />
            )}
        </Box>
    );
}
