/**
 * How a project hands over its parts (`defineEvalProject`), loading `*.eval.ts` files, and the library entries behind
 * the commands: `runEval` (new run or `--resume`), `sayEval`, `checkEval`, `listEval`, `cleanupEval`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runConversation } from "./conversation";
import {
    canonicalJson,
    EvalConfigError,
    type Expectation,
    isScenarioLike,
    type MatrixDoc,
    parseExpectationList,
    parseScenarios,
    type Scenario,
    type ScenarioIssue,
    type ScenarioOrigin,
    sha256,
    toJson,
    type Vocabulary,
    withAlways,
} from "./document";
import { RubricVersion } from "./evaluate";
import { JudgePromptVersion, SimulatorPromptVersion } from "./harness-models";
import { DefaultMaxErrorRate, DefaultPassRate, planRun, type RunPlan, selectByIds, selectScenarios } from "./plan";
import { type RunStopped, type RunSummary, summarizeRun } from "./report";
import { type Clock, createLimiter, type ProgressEvent, runPlan, SystemClock, semaphore } from "./schedule";
import {
    createRun,
    type HarnessSettings,
    loadRun,
    makeEvalRunId,
    openRun,
    type RunManifest,
    type RunStore,
} from "./store";
import {
    asSystemError,
    type CleanupItem,
    type EvalSystem,
    EvalSystemError,
    type Json,
    type ModelRef,
    type SystemConnection,
    type SystemErrorKind,
    type SystemInfo,
} from "./system";

export interface EvalProject<
    TSetup = unknown,
    TSignals = unknown,
    TTool extends string = string,
    THandle = unknown,
    TResolved = TSetup,
> {
    system: EvalSystem<TSetup, TSignals, TTool, THandle, TResolved>;
    /** A folder of `*.eval.ts` files (every exported scenario is collected), or the scenarios themselves. */
    scenarios: { dir: URL | string } | Scenario[];
    matrices: MatrixDoc[];
    /** Expectations appended to every scenario's `always`, preset or ad hoc. Part of each scenario's hash. */
    always?: Expectation[];
    /** Model ids (from `SystemInfo.models`) for the harness's own calls. No judge: judge checks are inconclusive. */
    harness?: { judge?: string; simulator?: string };
    /** Where run folders go, relative to the working directory. Default ".evals/runs". */
    runsDir?: string;
    /** Open conversations at once, and the top of every adaptive limit. Default 4. The CLI's `--concurrency` wins. */
    concurrency?: number;
    /** Conversations opened per key before it is left without a result. Default 3. */
    maxAttempts?: number;
}

export function defineEvalProject<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: EvalProject<TSetup, TSignals, TTool, THandle, TResolved>
): EvalProject<TSetup, TSignals, TTool, THandle, TResolved> {
    return project;
}

const DefaultRunsDir = ".evals/runs";
const DefaultConcurrency = 4;
const DefaultMaxAttempts = 3;

type Project<TSetup, TSignals, TTool extends string, THandle, TResolved> = EvalProject<
    TSetup,
    TSignals,
    TTool,
    THandle,
    TResolved
>;

export function runsDirOf(project: { runsDir?: string }): string {
    return project.runsDir ?? DefaultRunsDir;
}

function projectAlways(project: { system: Vocabulary; always?: Expectation[] }): Expectation[] {
    return project.always?.length ? parseExpectationList(project.always, project.system, "always") : [];
}

const loaded = new WeakMap<object, Promise<Scenario[]>>();

/** The project's scenarios with its `always` list appended. Files are imported once per project object. */
export function loadScenarios<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: Project<TSetup, TSignals, TTool, THandle, TResolved>
): Promise<Scenario[]> {
    let promise = loaded.get(project);
    if (!promise) {
        promise = readScenarios(project);
        loaded.set(project, promise);
    }
    return promise;
}

async function readScenarios(project: {
    system: Vocabulary;
    scenarios: EvalProject["scenarios"];
    always?: Expectation[];
}): Promise<Scenario[]> {
    const always = projectAlways(project);
    const raw = Array.isArray(project.scenarios)
        ? project.scenarios.map((s) => ({ value: s, where: s.doc.id }))
        : await importScenarioFiles(project.scenarios.dir);
    const issues: ScenarioIssue[] = [];
    const scenarios: Scenario[] = [];
    const seen = new Map<string, string>();
    for (const { value, where } of raw) {
        const parsed = parseScenarios(value.doc, project.system, "file");
        if (!parsed.ok) {
            issues.push(
                ...parsed.issues.map((i) => ({ path: `${where}${i.path ? `.${i.path}` : ""}`, message: i.message }))
            );
            continue;
        }
        const scenario = withAlways(parsed.scenarios[0], always, project.system);
        const first = seen.get(scenario.doc.id);
        if (first) {
            issues.push({ path: where, message: `scenario id "${scenario.doc.id}" is also defined at ${first}` });
        }
        seen.set(scenario.doc.id, where);
        scenarios.push(scenario);
    }
    if (issues.length) {
        throw new EvalConfigError("invalid-scenario", "the project's scenarios are invalid", issues);
    }
    return scenarios;
}

const ScenarioFilePattern = /\.eval\.(ts|mts|js|mjs)$/;

/** Imports every `*.eval.ts` file of a folder (sorted) and collects the exported scenarios. Works under bun and tsx. */
async function importScenarioFiles(dir: URL | string): Promise<{ value: { doc: unknown }; where: string }[]> {
    const path = dir instanceof URL ? fileURLToPath(dir) : dir;
    const files = (await readdir(path)).filter((name) => ScenarioFilePattern.test(name)).sort();
    const found: { value: { doc: unknown }; where: string }[] = [];
    for (const file of files) {
        const exported: unknown = await import(pathToFileURL(join(path, file)).href);
        if (typeof exported !== "object" || exported === null) {
            continue;
        }
        for (const [name, value] of Object.entries(exported)) {
            const values: unknown[] = Array.isArray(value) ? value : [value];
            values.forEach((item, i) => {
                if (isScenarioLike(item)) {
                    found.push({ value: item, where: `${file}:${name}${Array.isArray(value) ? `[${i}]` : ""}` });
                }
            });
        }
    }
    return found;
}

/** Ad-hoc scenarios (stdin JSON or flags), with the project's `always` list appended. */
export function parseAdHocScenarios(
    project: { system: Vocabulary; always?: Expectation[] },
    input: unknown,
    origin: ScenarioOrigin
): Scenario[] {
    const parsed = parseScenarios(input, project.system, origin, { always: projectAlways(project) });
    if (!parsed.ok) {
        throw new EvalConfigError("invalid-scenario", "the scenario is invalid", parsed.issues);
    }
    return parsed.scenarios;
}

export function findMatrix(project: { matrices: MatrixDoc[] }, id: string): MatrixDoc {
    const matrix = project.matrices.find((m) => m.id === id);
    if (!matrix) {
        throw new EvalConfigError(
            "unknown-matrix",
            `unknown matrix "${id}"; known: ${project.matrices.map((m) => m.id).join(", ") || "none"}`
        );
    }
    return matrix;
}

/** The scenarios of a selection: ids, a matrix, or both (ids narrow the matrix). */
export async function selectProjectScenarios<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: Project<TSetup, TSignals, TTool, THandle, TResolved>,
    selection: { ids?: string[]; matrix?: MatrixDoc }
): Promise<Scenario[]> {
    const all = await loadScenarios(project);
    const pool = selection.matrix ? selectScenarios(selection.matrix.scenarios, all) : all;
    if (selection.ids?.length) {
        return selectByIds(selection.ids, pool);
    }
    if (!selection.matrix) {
        throw new EvalConfigError("bad-option", "name scenario ids, --matrix or --stdin");
    }
    if (!pool.length) {
        throw new EvalConfigError("unknown-scenario", `matrix "${selection.matrix.id}" selects no scenario`);
    }
    return pool;
}

/** Resolves every scenario's setup once. Pure when the system's `resolveSetup` is. */
function resolveSetups<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    system: EvalSystem<TSetup, TSignals, TTool, THandle, TResolved>,
    scenarios: readonly Scenario[],
    now: Date
): Map<string, TResolved> {
    const setups = new Map<string, TResolved>();
    for (const scenario of scenarios) {
        const setup = system.setup.safeParse(scenario.doc.setup);
        if (!setup.success) {
            throw new EvalConfigError("invalid-scenario", `the setup of "${scenario.doc.id}" no longer validates`, [
                { path: `${scenario.doc.id}.setup`, message: setup.error.issues[0]?.message ?? "invalid" },
            ]);
        }
        setups.set(scenario.doc.id, system.resolveSetup(setup.data, { now }));
    }
    return setups;
}

function harnessModels(
    project: { harness?: { judge?: string; simulator?: string } },
    info: SystemInfo
): { judge: ModelRef | null; simulator: ModelRef | null } {
    const find = (id: string | undefined, role: string) => {
        if (id === undefined) {
            return null;
        }
        const model = info.models.find((m) => m.id === id);
        if (!model) {
            throw new EvalConfigError(
                "unknown-model",
                `the ${role} model "${id}" is not one of the system's models; known: ${info.models.map((m) => m.id).join(", ")}`
            );
        }
        return model;
    };
    return { judge: find(project.harness?.judge, "judge"), simulator: find(project.harness?.simulator, "simulator") };
}

function harnessSettings(project: { harness?: { judge?: string; simulator?: string } }): HarnessSettings {
    return {
        judge: project.harness?.judge ?? null,
        judgePromptVersion: JudgePromptVersion,
        simulator: project.harness?.simulator ?? null,
        simulatorPromptVersion: SimulatorPromptVersion,
    };
}

function checkNames(info: SystemInfo, models: readonly string[], variants: readonly string[]): void {
    const knownModels = info.models.map((m) => m.id);
    const unknownModels = models.filter((m) => !knownModels.includes(m));
    if (unknownModels.length) {
        throw new EvalConfigError(
            "unknown-model",
            `unknown model ${unknownModels.join(", ")}; known: ${knownModels.join(", ")}`
        );
    }
    const unknownVariants = variants.filter((v) => !info.variants.includes(v));
    if (unknownVariants.length) {
        throw new EvalConfigError(
            "unknown-variant",
            `unknown variant ${unknownVariants.join(", ")}; known: ${info.variants.join(", ")}`
        );
    }
}

function checkSimulated(
    scenarios: readonly Scenario[],
    harness: { simulator: ModelRef | null },
    canComplete: boolean
): void {
    const simulated = scenarios.filter((s) => s.doc.steps.some((step) => "simulate" in step)).map((s) => s.doc.id);
    if (simulated.length && (!harness.simulator || !canComplete)) {
        throw new EvalConfigError(
            "bad-option",
            `${simulated.join(", ")} ha${simulated.length === 1 ? "s" : "ve"} a simulated step, but the project names no simulator model or the system has no complete()`
        );
    }
}

/** What to run: a new run, or the conversations of an earlier run that have no result (`resume`). */
export interface RunEvalRequest {
    /** New run: the scenarios (already selected, with the project's `always`). */
    scenarios?: Scenario[];
    models?: string[];
    /** Default: the system's first variant. */
    variants?: string[];
    repeats?: number;
    passRate?: number;
    maxErrorRate?: number;
    /** null: no cap. On `resume`, undefined keeps the manifest's cap. */
    maxCostUsd?: number | null;
    /** The label in the run id. */
    label?: string;
    target?: string;
    /** A run id or folder: continue it with its stored plan, scenarios and resolved setups. */
    resume?: string;
}

export interface RunEvalOptions {
    concurrency?: number;
    keepGoing?: boolean;
    allCells?: boolean;
    maxFailures?: number;
    signal?: AbortSignal;
    clock?: Clock;
    onProgress?: (event: ProgressEvent) => void;
    /** The command line, stored in the manifest for a person. */
    argv?: string[];
}

/**
 * The library entry behind `run`: checks the request against the live system, creates or resumes the run folder,
 * plays it, and returns the summary (also written to `summary.json`). Throws `EvalConfigError` for a wrong call and
 * `EvalSystemError` when the system cannot be reached.
 */
export async function runEval<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: Project<TSetup, TSignals, TTool, THandle, TResolved>,
    request: RunEvalRequest,
    options: RunEvalOptions = {}
): Promise<RunSummary> {
    const clock = options.clock ?? SystemClock;
    const signal = options.signal ?? new AbortController().signal;
    const started = clock.now();
    const { system } = project;
    const runsDir = runsDirOf(project);

    let store: RunStore;
    let scenarios: Scenario[];
    let setups: Map<string, TResolved>;
    let maxCostUsd: number | null;
    let connection: SystemConnection<TResolved, TSignals, THandle>;
    let info: SystemInfo;
    let harness: { judge: ModelRef | null; simulator: ModelRef | null };

    if (request.resume) {
        store = await openRun(request.resume, runsDir);
        const manifest = store.manifest;
        scenarios = scenariosFromManifest(manifest, system);
        checkResumable(manifest, scenarios, project);
        setups = resolveSetups(system, scenarios, new Date(manifest.plannedAt));
        for (const scenario of scenarios) {
            if (
                canonicalJson(toJson(setups.get(scenario.doc.id))) !== canonicalJson(manifest.setups[scenario.doc.id])
            ) {
                throw new EvalConfigError(
                    "plan-changed",
                    `the resolved setup of "${scenario.doc.id}" differs from the stored one; resolveSetup must depend only on the setup and the planned time`
                );
            }
        }
        maxCostUsd = request.maxCostUsd === undefined ? manifest.maxCostUsd : request.maxCostUsd;
        connection = system.connect(manifest.target ?? undefined);
        info = await connection.describe({ signal });
        checkNames(
            info,
            [...new Set(manifest.plan.cells.map((c) => c.model))],
            [...new Set(manifest.plan.cells.map((c) => c.variant))]
        );
        harness = harnessModels(project, info);
    } else {
        scenarios = request.scenarios ?? [];
        connection = system.connect(request.target);
        info = await connection.describe({ signal });
        const variants = request.variants?.length ? request.variants : info.variants.slice(0, 1);
        const models = request.models ?? [];
        checkNames(info, models, variants);
        harness = harnessModels(project, info);
        checkSimulated(scenarios, harness, Boolean(connection.complete));
        const plannedAt = new Date(clock.now());
        setups = resolveSetups(system, scenarios, plannedAt);
        const plan = planRun({
            scenarios,
            models,
            variants,
            repeats: request.repeats ?? 1,
            passRate: request.passRate ?? DefaultPassRate,
            maxErrorRate: request.maxErrorRate ?? DefaultMaxErrorRate,
        });
        maxCostUsd = request.maxCostUsd ?? null;
        const label = request.label ?? (scenarios.length === 1 ? scenarios[0].doc.id : "adhoc");
        const storedSetups: Record<string, Json> = {};
        for (const [id, setup] of setups) {
            storedSetups[id] = toJson(setup);
        }
        const cap = maxCostUsd;
        store = await createRun(
            runsDir,
            { now: plannedAt, label },
            (run): RunManifest => ({
                schema: "eval-manifest/1",
                run,
                label,
                createdAt: new Date(clock.now()).toISOString(),
                plannedAt: plannedAt.toISOString(),
                project: system.name,
                target: request.target ?? null,
                rubricVersion: RubricVersion,
                signalsVersion: system.signalsVersion,
                plan,
                scenarios: Object.fromEntries(
                    scenarios.map((s) => [s.doc.id, { hash: s.hash, origin: s.origin, doc: toJson(s.doc) }])
                ),
                setups: storedSetups,
                system: info,
                harness: harnessSettings(project),
                maxCostUsd: cap,
                argv: options.argv ?? [],
            })
        );
    }

    const result = await runPlan(
        {
            runId: store.manifest.run,
            plan: store.manifest.plan,
            scenarios: new Map(scenarios.map((s) => [s.doc.id, s])),
            setups,
            signals: system.signals,
            connection,
            info,
            store,
            harness,
        },
        {
            concurrency: options.concurrency ?? project.concurrency ?? DefaultConcurrency,
            maxAttempts: project.maxAttempts ?? DefaultMaxAttempts,
            keepGoing: options.keepGoing ?? false,
            maxCostUsd,
            signal,
            clock,
            onProgress: options.onProgress,
        }
    );
    const stopped: RunStopped | null =
        result.stopped?.reason === "cost-limit"
            ? {
                  reason: "cost-limit",
                  detail: `finished conversations cost $${result.stopped.spentUsd.toFixed(4)}, more than maxCostUsd $${result.stopped.maxCostUsd}; the conversations without a result were not started. Raise --max-cost-usd and run again with --resume ${store.manifest.run}`,
              }
            : result.stopped?.reason === "aborted"
              ? { reason: "aborted", detail: `the run was interrupted; run again with --resume ${store.manifest.run}` }
              : null;
    // Kept on purpose: the summary is built from what is on disk, the same fold `report` uses, so it checks that every record was written and reads back.
    const view = await loadRun(store.dir, runsDir);
    const summary = summarizeRun(view, {
        allCells: options.allCells,
        maxFailures: options.maxFailures,
        durationMs: clock.now() - started,
        stopped,
    });
    await store.writeSummary(summary);
    return summary;
}

function scenariosFromManifest(manifest: RunManifest, vocabulary: Vocabulary): Scenario[] {
    return Object.entries(manifest.scenarios).map(([id, stored]) => {
        const parsed = parseScenarios(stored.doc, vocabulary, stored.origin);
        if (!parsed.ok) {
            throw new EvalConfigError(
                "plan-changed",
                `scenario "${id}" of run ${manifest.run} no longer validates against the system`,
                parsed.issues
            );
        }
        const scenario = parsed.scenarios[0];
        if (scenario.hash !== stored.hash) {
            throw new EvalConfigError(
                "plan-changed",
                `scenario "${id}" of run ${manifest.run} hashes differently now (${stored.hash} → ${scenario.hash})`
            );
        }
        return scenario;
    });
}

function checkResumable(
    manifest: RunManifest,
    scenarios: readonly Scenario[],
    project: { system: { name: string; signalsVersion: number }; harness?: { judge?: string; simulator?: string } }
): void {
    const problems: string[] = [];
    if (manifest.project !== project.system.name) {
        problems.push(`project ${manifest.project} → ${project.system.name}`);
    }
    if (manifest.rubricVersion !== RubricVersion) {
        problems.push(`rubric version ${manifest.rubricVersion} → ${RubricVersion}`);
    }
    if (manifest.signalsVersion !== project.system.signalsVersion) {
        problems.push(`signals version ${manifest.signalsVersion} → ${project.system.signalsVersion}`);
    }
    const harness = harnessSettings(project);
    if (canonicalJson(harness) !== canonicalJson(manifest.harness)) {
        problems.push(`judge or simulator ${canonicalJson(manifest.harness)} → ${canonicalJson(harness)}`);
    }
    const hashes = new Map(scenarios.map((s) => [s.doc.id, s.hash]));
    if (manifest.plan.cells.some((cell) => hashes.get(cell.scenario) !== cell.scenarioHash)) {
        problems.push("a scenario of the plan changed");
    }
    if (problems.length) {
        throw new EvalConfigError("plan-changed", `run ${manifest.run} cannot be resumed: ${problems.join("; ")}`);
    }
}

// ── say ──────────────────────────────────────────────────────────────────────

export interface SayResult {
    schema: "eval-say/1";
    model: string;
    variant: string;
    conversations: {
        repeat: number;
        error: { kind: SystemErrorKind; message: string } | null;
        turns: { user: string; reply: string; tools: string[]; signals: Json; promptHash: string | null }[];
    }[];
    exitCode: 0 | 4;
}

/** One or more user turns with no expectations, `repeats` times. Nothing is written to the run folder. */
export async function sayEval<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: Project<TSetup, TSignals, TTool, THandle, TResolved>,
    request: { texts: string[]; model: string; variant?: string; repeats?: number; setup?: unknown; target?: string },
    options: { concurrency?: number; signal?: AbortSignal; clock?: Clock } = {}
): Promise<SayResult> {
    const clock = options.clock ?? SystemClock;
    const signal = options.signal ?? new AbortController().signal;
    const { system } = project;
    const [scenario] = parseAdHocScenarios(
        { system },
        { id: "say", steps: request.texts.map((user) => ({ user })), setup: request.setup ?? {} },
        "flags"
    );
    const connection = system.connect(request.target);
    const info = await connection.describe({ signal });
    const variant = request.variant ?? info.variants[0] ?? "";
    checkNames(info, [request.model], [variant]);
    const model = info.models.find((m) => m.id === request.model);
    if (!model) {
        throw new EvalConfigError("unknown-model", `unknown model ${request.model}`);
    }
    const setup = resolveSetups(system, [scenario], new Date(clock.now())).get(scenario.doc.id);
    if (setup === undefined) {
        throw new EvalConfigError("invalid-scenario", "the setup did not resolve");
    }
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? project.concurrency ?? DefaultConcurrency));
    const limiter = createLimiter({ max: concurrency, clock, signal });
    const open = semaphore(concurrency);
    const runId = `say-${makeEvalRunId(new Date(clock.now()), "say")}`;
    const repeats = Array.from({ length: Math.max(1, request.repeats ?? 1) }, (_, i) => i + 1);
    const conversations = await Promise.all(
        repeats.map(async (repeat): Promise<SayResult["conversations"][number]> => {
            if (!(await open.acquire(signal))) {
                return { repeat, error: { kind: "blocked", message: "run aborted" }, turns: [] };
            }
            try {
                if (signal.aborted) {
                    throw new EvalSystemError("blocked", "run aborted");
                }
                const record = await runConversation(
                    {
                        key: `say~r${repeat}`,
                        repeat,
                        attempt: 1,
                        scenario,
                        cell: { scenario: "say", scenarioHash: scenario.hash, model: model.id, variant },
                        setup,
                    },
                    {
                        connection,
                        signals: system.signals,
                        model,
                        runId,
                        limited: (key, task) => limiter.run(key, task),
                        harness: { judge: null, simulator: null },
                        putPrompt: async (text) => sha256(text, 8),
                        keepGoing: true,
                        signal,
                        now: () => new Date(clock.now()),
                    }
                );
                return {
                    repeat,
                    error: record.brokenBy,
                    turns: record.turns.map((t) => ({
                        user: t.user.text,
                        reply: t.reply,
                        tools: t.toolCalls.map((c) => c.name),
                        signals: t.signals,
                        promptHash: t.promptHash,
                    })),
                };
            } catch (thrown) {
                const error = asSystemError(thrown);
                return { repeat, error: { kind: error.kind, message: error.message }, turns: [] };
            } finally {
                open.release();
            }
        })
    );
    return {
        schema: "eval-say/1",
        model: model.id,
        variant,
        conversations,
        exitCode: conversations.some((c) => c.turns.length) ? 0 : 4,
    };
}

// ── check, list, cleanup ─────────────────────────────────────────────────────

export interface CheckResult {
    schema: "eval-check/1";
    scenarios: {
        id: string;
        title: string;
        tags: string[];
        hash: string;
        origin: ScenarioOrigin;
        resolvedSetup: Json;
        doc?: Json;
    }[];
    /** With a matrix: the plan it gives. */
    plan: { cells: number; conversations: number; hash: string } | null;
}

/** Validates scenarios and prints them; contacts nothing. */
export function checkEval<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: Project<TSetup, TSignals, TTool, THandle, TResolved>,
    scenarios: Scenario[],
    options: { print?: boolean; matrix?: MatrixDoc; now?: Date } = {}
): CheckResult {
    const setups = resolveSetups(project.system, scenarios, options.now ?? new Date());
    let plan: RunPlan | null = null;
    if (options.matrix) {
        if (!options.matrix.variants) {
            throw new EvalConfigError(
                "bad-option",
                "offline matrix check requires explicit variants; the default first variant is known only after the system is described"
            );
        }
        plan = planRun({
            scenarios,
            models: options.matrix.models,
            variants: options.matrix.variants,
            repeats: options.matrix.repeats,
            passRate: options.matrix.passRate ?? DefaultPassRate,
            maxErrorRate: options.matrix.maxErrorRate ?? DefaultMaxErrorRate,
        });
    }
    return {
        schema: "eval-check/1",
        scenarios: scenarios.map((s) => ({
            id: s.doc.id,
            title: s.doc.title,
            tags: s.doc.tags,
            hash: s.hash,
            origin: s.origin,
            resolvedSetup: toJson(setups.get(s.doc.id)),
            ...(options.print ? { doc: toJson(s.doc) } : {}),
        })),
        plan: plan ? { cells: plan.cells.length, conversations: plan.conversations.length, hash: plan.hash } : null,
    };
}

export interface ListResult {
    schema: "eval-list/1";
    project: string;
    scenarios: { id: string; title: string; tags: string[]; hash: string; steps: number }[];
    matrices: MatrixDoc[];
    /** With `--live`: what the running system says about itself. */
    system: SystemInfo | null;
}

export async function listEval<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: Project<TSetup, TSignals, TTool, THandle, TResolved>,
    options: { live?: boolean; target?: string; signal?: AbortSignal } = {}
): Promise<ListResult> {
    const scenarios = await loadScenarios(project);
    const system = options.live
        ? await project.system
              .connect(options.target)
              .describe({ signal: options.signal ?? new AbortController().signal })
        : null;
    return {
        schema: "eval-list/1",
        project: project.system.name,
        scenarios: scenarios.map((s) => ({
            id: s.doc.id,
            title: s.doc.title,
            tags: s.doc.tags,
            hash: s.hash,
            steps: s.doc.steps.length,
        })),
        matrices: project.matrices,
        system,
    };
}

export interface CleanupResult {
    schema: "eval-cleanup/1";
    runId: string | null;
    removed: CleanupItem[];
}

/** Asks the system to remove what runs left behind (all, or one run's). */
export async function cleanupEval<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: Project<TSetup, TSignals, TTool, THandle, TResolved>,
    options: { runId?: string; target?: string; signal?: AbortSignal } = {}
): Promise<CleanupResult> {
    const connection = project.system.connect(options.target);
    if (!connection.cleanup) {
        throw new EvalConfigError("unsupported", `the system "${project.system.name}" has no cleanup`);
    }
    const result = await connection.cleanup({
        runId: options.runId,
        signal: options.signal ?? new AbortController().signal,
    });
    return { schema: "eval-cleanup/1", runId: options.runId ?? null, removed: result.removed };
}
