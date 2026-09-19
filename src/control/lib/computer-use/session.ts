import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { abortableSleep } from "@genesiscz/utils/async";
import { TemporaryArtifacts } from "@genesiscz/utils/fs/temporary-artifacts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { OperationBudget } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { assistTask } from "../decision/assist";
import { awaitCondition } from "../decision/await";
import { chooseCandidate } from "../decision/chooser";
import { judgeOutcome } from "../decision/decisions";
import { fillForm } from "../decision/fill";
import { type ControlDriver, NativeControlDriver } from "../decision/native";
import {
    candidatesFor,
    elementLabel,
    hasAncestorRole,
    type Observation,
    observationSchema,
    primaryWebArea,
    sameScope,
} from "../decision/observation";
import { NativeObservationSource } from "../decision/observation-source";
import { runNativeSequence } from "../decision/sequence";
import { ControlSession } from "../decision/session";
import { resolveVisualTarget, type VisualObservation, visualObservationSchema } from "../decision/visual";
import { replayWorkflow } from "../decision/workflow";
import { type AxResult, runAxAsync } from "../runner";
import { diffSnapshots, type SnapshotDiff } from "../snapshot-diff";
import { NativeMenuSession } from "./menu";
import { type ComputerArgs, type ComputerCall, type ComputerMethod, computerSchemas } from "./schemas";

function parseCall<M extends ComputerMethod>(
    method: M,
    input: ComputerCall<M>
): {
    options: ComputerArgs<M>;
    signal?: AbortSignal;
} {
    const { signal, ...args } = input;
    signal?.throwIfAborted();
    return { options: computerSchemas[method].parse(args) as ComputerArgs<M>, signal };
}
const snapshotSchema = observationSchema.and(
    z.object({
        window: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
        screenshot: z.object({
            path: z.string().optional(),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
        }),
        perception: z
            .object({ capture: z.object({ pngHash: z.string(), id: z.string() }).passthrough().optional() })
            .passthrough()
            .optional(),
    })
);
type Snapshot = z.infer<typeof snapshotSchema>;
export interface ComputerElement {
    ref: string;
    index: number;
    depth: number;
    role: string;
    label: string;
    identifier?: string;
    url?: string;
    value?: string | number | boolean;
    truncated?: Array<"label" | "value">;
    enabled: boolean;
    focused: boolean;
    actions: Array<{
        raw: string;
        name: string;
    }>;
    bounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
export interface ComputerState {
    observationRecovery?: { retries: number };
    app: string;
    revision: string;
    pid: number;
    window: Snapshot["window"];
    scope: string;
    document: { url: string; title: string; ref: string } | null;
    text: string;
    elements: ComputerElement[];
    page: { offset: number; limit: number; total: number; nextOffset: number | null };
    changeCounts?: { added: number; removed: number; changed: number };
    changesTruncated?: boolean;
    changes?: SnapshotDiff;
    visual?: {
        method: "vision-ocr";
        expiresAt: number;
        regions: Array<VisualObservation["perception"]["regions"][number] & { ref: string }>;
    };
    screenshot: {
        url: string;
        width: number;
        height: number;
        coordinateSpace: "image";
        scaleX: number;
        scaleY: number;
    } | null;
    observedAt: string;
}
export class ComputerUseError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly details?: unknown
    ) {
        super(message);
        this.name = "ComputerUseError";
    }
}
interface AppRecord {
    revision: string;
    snapshot: Snapshot;
    implicitActionAllowed: boolean;
    image: boolean;
    lastAccess: number;
    elementLimit: number;
    observedAt: string;
}
export interface NativeBridge {
    run(options: { args: string[]; timeoutMs?: number; signal?: AbortSignal }): Promise<AxResult>;
}
function normalizeAction(name: string): string {
    return name
        .replace(/^AX/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
}
function trueValue(value: unknown): boolean {
    return value === true || value === 1 || value === "1" || value === "true";
}
function safeRows(rows: Observation["elements"]): Observation["elements"] {
    return rows.map((row) =>
        row.AXSubrole === "AXSecureTextField" ? { ...row, AXValue: "[secure]", AXSelectedText: "[secure]" } : row
    );
}

function webActivationKey(rows: Observation["elements"], target: Observation["elements"][number]) {
    if (!hasAncestorRole(rows, target, "AXWebArea")) {
        return undefined;
    }
    if (target.role === "AXLink") {
        return "return";
    }
    if (["AXButton", "AXCheckBox", "AXRadioButton", "AXSwitch"].includes(target.role)) {
        return "space";
    }
    return undefined;
}
export class ComputerUse {
    readonly target = "mac";
    private readonly native: NativeBridge;
    private readonly menus: NativeMenuSession;
    private readonly records = new Map<string, AppRecord>();
    private readonly artifacts: TemporaryArtifacts;
    private readonly evaluate: Evaluator;
    private readonly session = randomUUID().slice(0, 8);
    private sequence = 0;
    private busy = false;
    constructor(
        options: {
            native?: NativeBridge;
            timeoutMs?: number;
            artifactDirectory?: string;
            evaluate?: Evaluator;
        } = {}
    ) {
        this.native = options.native ?? { run: runAxAsync };
        this.evaluate =
            options.evaluate ??
            (async (call) => (await import("@genesiscz/utils/ai/evaluation/service")).evaluateRequest(call));
        this.menus = new NativeMenuSession(this.native);
        this.artifacts = new TemporaryArtifacts({
            prefix: "computer-use",
            maxFiles: 10,
            parentDirectory: options.artifactDirectory,
        });
        this.timeoutMs = options.timeoutMs ?? 10000;
    }
    readonly timeoutMs: number;
    private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.busy) {
            throw new ComputerUseError(
                "BUSY",
                "Another native operation is running in this session. Await it before acting."
            );
        }
        this.busy = true;
        try {
            return await operation();
        } finally {
            this.busy = false;
        }
    }
    private record({ app, revision }: { app: string; revision?: string }): AppRecord {
        const record = this.records.get(app);
        if (!record) {
            throw new ComputerUseError("OBSERVE_FIRST", "Call get_app_state for this app before acting.");
        }
        if (revision !== undefined && revision !== record.revision) {
            throw new ComputerUseError(
                "STALE_REFERENCE",
                "The referenced state was replaced. Use the latest observed revision."
            );
        }
        record.lastAccess = Date.now();
        return record;
    }
    private forget(app: string): boolean {
        const image = this.records.get(app)?.snapshot.screenshot.path;
        if (image) {
            this.artifacts.release(image);
        }
        return this.records.delete(app);
    }
    private store({
        app,
        snapshot,
        implicitActionAllowed,
        image,
        elementLimit,
    }: {
        app: string;
        snapshot: Snapshot;
        implicitActionAllowed: boolean;
        image?: boolean;
        elementLimit?: number;
    }): AppRecord {
        if (!this.records.has(app) && this.records.size >= 8) {
            throw new ComputerUseError(
                "SESSION_LIMIT",
                "Eight apps are already retained. Close an unused session first."
            );
        }
        const record = {
            revision: `${this.session}:${++this.sequence}`,
            snapshot,
            implicitActionAllowed,
            image: image ?? this.records.get(app)?.image ?? true,
            lastAccess: Date.now(),
            elementLimit: elementLimit ?? this.records.get(app)?.elementLimit ?? 100,
            observedAt: new Date().toISOString(),
        };
        const previousImage = this.records.get(app)?.snapshot.screenshot.path;
        if (previousImage && previousImage !== snapshot.screenshot.path) {
            this.artifacts.release(previousImage);
        }
        this.records.set(app, record);
        return record;
    }
    private state({
        app,
        record,
        previous,
        offset = 0,
        limit = record.elementLimit,
        textLimit = 500,
    }: {
        app: string;
        record: AppRecord;
        previous?: AppRecord;
        offset?: number;
        limit?: number;
        textLimit?: number;
    }): ComputerState {
        const snapshot = record.snapshot;
        const allElements = safeRows(snapshot.elements).map(
            (row): ComputerElement => ({
                ref: `${record.revision}:${row.index}`,
                index: row.index,
                depth: row.depth,
                role: row.role,
                label: elementLabel(row).slice(0, textLimit),
                truncated: [
                    ...(elementLabel(row).length > textLimit ? ["label" as const] : []),
                    ...(typeof row.AXValue === "string" && row.AXValue.length > textLimit ? ["value" as const] : []),
                ],
                identifier: row.AXIdentifier,
                url: row.AXURL,
                value: typeof row.AXValue === "string" ? row.AXValue.slice(0, textLimit) : row.AXValue,
                enabled: ![false, 0, "0", "false"].includes(row.AXEnabled ?? ""),
                focused: trueValue(row.AXFocused),
                actions: (row.actions ?? []).map((raw) => ({ raw, name: normalizeAction(raw) })),
                bounds: [row.x, row.y, row.width, row.height].every((value) => typeof value === "number")
                    ? { x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) }
                    : undefined,
            })
        );
        const documentRow = primaryWebArea(safeRows(snapshot.elements));
        const documentElement = documentRow
            ? allElements.find((element) => element.index === documentRow.index)
            : undefined;
        const document = documentElement?.url
            ? { url: documentElement.url, title: documentElement.label.slice(0, 500), ref: documentElement.ref }
            : null;
        const elements = allElements.slice(offset, offset + limit);
        const comparable =
            previous &&
            previous.snapshot.pid === snapshot.pid &&
            previous.snapshot.processLaunch === snapshot.processLaunch &&
            previous.snapshot.window.id === snapshot.window.id &&
            previous.snapshot.scope === snapshot.scope;
        const fullChanges = comparable
            ? diffSnapshots(safeRows(previous.snapshot.elements), safeRows(snapshot.elements))
            : undefined;
        const changes = fullChanges
            ? {
                  ...fullChanges,
                  added: fullChanges.added.slice(0, limit).map((row) => ({
                      ...row,
                      ...Object.fromEntries(
                          Object.entries(row).map(([key, value]) => [
                              key,
                              typeof value === "string" ? value.slice(0, textLimit) : value,
                          ])
                      ),
                  })),
                  removed: fullChanges.removed.slice(0, limit),
                  changed: fullChanges.changed.slice(0, limit).map((row) => ({
                      ...row,
                      fields: Object.fromEntries(
                          Object.entries(row.fields).map(([key, value]) => [
                              key,
                              {
                                  from: typeof value.from === "string" ? value.from.slice(0, textLimit) : value.from,
                                  to: typeof value.to === "string" ? value.to.slice(0, textLimit) : value.to,
                              },
                          ])
                      ),
                  })),
              }
            : undefined;
        const changedIds = changes
            ? new Set([...changes.added.map((row) => row.index), ...changes.changed.map((row) => row.index)])
            : undefined;
        const lines = elements
            .filter((row) => !changedIds || changedIds.has(row.index))
            .map(
                (row) =>
                    `${"  ".repeat(Math.min(row.depth, 20))}[${row.index}] ${row.role} ${row.label}${row.value === undefined ? "" : ` value=${SafeJSON.stringify(row.value)}`}${row.focused ? " focused" : ""}${row.enabled ? "" : " disabled"}${row.actions.length ? ` actions=[${row.actions.map((action) => action.raw).join(",")}]` : ""} ref=${row.ref}`
            );
        const text = [
            `${app} · window ${snapshot.window.id} · revision ${record.revision}`,
            changes
                ? `Changes: +${fullChanges?.added.length} -${fullChanges?.removed.length} ~${fullChanges?.changed.length}; ${changes.unchanged} unchanged. Use current indexes or explicit refs; old refs are invalid.`
                : `${allElements.length} observed elements.`,
            `Rows ${offset}–${offset + elements.length}; text values limited to ${textLimit} characters. Use get_elements or find for more.`,
            ...lines,
        ].join("\n");
        const screenshot = snapshot.screenshot;
        const visual = visualObservationSchema.safeParse(snapshot);
        return {
            app,
            revision: record.revision,
            observationRecovery: snapshot.observationRecovery,
            pid: snapshot.pid,
            window: snapshot.window,
            scope: snapshot.scope,
            document,
            text,
            elements,
            page: {
                offset,
                limit,
                total: allElements.length,
                nextOffset: offset + limit < allElements.length ? offset + limit : null,
            },
            changeCounts: fullChanges
                ? {
                      added: fullChanges.added.length,
                      removed: fullChanges.removed.length,
                      changed: fullChanges.changed.length,
                  }
                : undefined,
            changesTruncated: fullChanges
                ? fullChanges.added.length > limit ||
                  fullChanges.removed.length > limit ||
                  fullChanges.changed.length > limit
                : undefined,
            changes,
            observedAt: record.observedAt,
            visual:
                visual.success && visual.data.perception.method === "vision-ocr"
                    ? {
                          method: "vision-ocr",
                          expiresAt: visual.data.perception.capture.created * 1000 + 30000,
                          regions: visual.data.perception.regions.map((region) => ({
                              ...region,
                              ref: `${record.revision}:visual:${region.id}`,
                          })),
                      }
                    : undefined,
            screenshot:
                screenshot.path && screenshot.width && screenshot.height
                    ? {
                          url: pathToFileURL(screenshot.path).href,
                          width: screenshot.width,
                          height: screenshot.height,
                          coordinateSpace: "image",
                          scaleX: screenshot.width / snapshot.window.width,
                          scaleY: screenshot.height / snapshot.window.height,
                      }
                    : null,
        };
    }
    async get_app_state(input: ComputerCall<"get_app_state">): Promise<ComputerState> {
        const { options, signal } = parseCall("get_app_state", input);
        return this.exclusive(async () => {
            const prior = this.records.get(options.app);
            if (!prior && this.records.size >= 8) {
                throw new ComputerUseError(
                    "SESSION_LIMIT",
                    "Eight apps are already retained. Close an unused session first."
                );
            }
            const args = [
                "see",
                "--app",
                options.app,
                "--scope",
                options.scope ?? prior?.snapshot.scope ?? "window",
                "--depth",
                "50",
            ];
            if (!options.image) {
                args.push("--no-image");
            }
            if (options.perception) {
                args.push("--perception", options.perception);
            }
            if (options.window_id !== undefined) {
                args.push("--window-id", String(options.window_id));
            } else if (options.window_index !== undefined) {
                args.push("--window-index", String(options.window_index));
            } else if (prior) {
                args.push("--window-id", String(prior.snapshot.window.id));
            }
            const capturePath = options.image ? this.artifacts.allocate("png") : undefined;
            if (capturePath) {
                args.push("--path", capturePath);
            }
            try {
                const budget = new OperationBudget({
                    timeoutMs: options.timeout_ms ?? this.timeoutMs,
                    signal,
                    maxActions: 0,
                    maxRequests: 0,
                });
                let result: AxResult = { ok: false, error: "Observation did not settle." };
                for (let attempt = 0; attempt < 4; attempt++) {
                    result = await this.native.run({ args, timeoutMs: budget.remaining(), signal: budget.signal });
                    if (result.ok || !result.error?.includes("UI changed during observation") || attempt === 3) {
                        break;
                    }
                    logger.debug({ app: options.app, attempt }, "Waiting for a stable read-only observation");
                    await abortableSleep(Math.min(100, budget.remaining()), budget.signal);
                }
                if (!result.ok) {
                    throw new ComputerUseError(
                        "OBSERVATION_FAILED",
                        result.error ?? "Native observation failed.",
                        result
                    );
                }
                const snapshot = snapshotSchema.parse(result);
                if (
                    prior &&
                    options.window_id === undefined &&
                    options.window_index === undefined &&
                    (snapshot.pid !== prior.snapshot.pid || snapshot.processLaunch !== prior.snapshot.processLaunch)
                ) {
                    this.forget(options.app);
                    throw new ComputerUseError("APP_REPLACED", "The app process changed. Start a fresh session.");
                }
                const record = this.store({
                    app: options.app,
                    snapshot,
                    implicitActionAllowed: true,
                    image: options.image,
                    elementLimit: options.element_limit,
                });
                return this.state({
                    app: options.app,
                    record,
                    previous: options.disableDiff ? undefined : prior,
                });
            } finally {
                if (capturePath && this.records.get(options.app)?.snapshot.screenshot.path !== capturePath) {
                    this.artifacts.release(capturePath);
                }
            }
        });
    }
    async get_menu(input: ComputerCall<"get_menu">) {
        const { options, signal } = parseCall("get_menu", input);
        return this.exclusive(() => this.menus.observe({ ...options, signal }));
    }
    async perform_menu_action(input: ComputerCall<"perform_menu_action">) {
        const { options, signal } = parseCall("perform_menu_action", input);
        return this.exclusive(async () => {
            this.forget(options.app);
            return this.menus.act({ ...options, signal });
        });
    }
    async list_windows(input: ComputerCall<"list_windows">) {
        const { options, signal } = parseCall("list_windows", input);
        const result = await this.native.run({
            args: ["window", "--app", options.app],
            timeoutMs: this.timeoutMs,
            signal,
        });
        if (!result.ok) {
            throw new ComputerUseError("WINDOW_LIST_FAILED", result.error ?? "Could not inspect windows.");
        }
        const windows = z
            .array(
                z.object({
                    title: z.string(),
                    window_id: z.number().int().positive().optional(),
                    x: z.number(),
                    y: z.number(),
                    width: z.number(),
                    height: z.number(),
                    minimized: z.boolean().optional(),
                    transient: z.boolean().optional(),
                })
            )
            .parse(result.windows);
        return { app: options.app, windows: windows.map((window, index) => ({ ...window, window_index: index })) };
    }
    async list_apps(input: ComputerCall<"list_apps"> = {}) {
        const { options, signal } = parseCall("list_apps", input);
        const result = await this.native.run({
            args: [
                "apps",
                ...(options.include_background ? ["--all"] : []),
                ...(options.installed ? ["--installed"] : []),
            ],
            timeoutMs: this.timeoutMs,
            signal,
        });
        if (!result.ok) {
            throw new ComputerUseError("APP_LIST_FAILED", result.error ?? "Could not inspect running apps.");
        }
        if (options.installed) {
            return z
                .object({
                    apps: z.array(
                        z.object({
                            id: z.string(),
                            displayName: z.string(),
                            path: z.string(),
                            isRunning: z.boolean(),
                            pids: z.array(z.number().int()),
                        })
                    ),
                    truncated: z.boolean(),
                    roots: z.array(z.string()),
                })
                .parse(result);
        }
        return z
            .array(
                z.object({
                    pid: z.number().int(),
                    name: z.string().optional(),
                    bundleId: z.string().optional(),
                    frontmost: z.boolean().optional(),
                    hidden: z.boolean().optional(),
                })
            )
            .parse(result.apps)
            .map((app) => ({
                id: app.bundleId ?? String(app.pid),
                displayName: app.name,
                pid: app.pid,
                isRunning: true,
                frontmost: app.frontmost === true,
                hidden: app.hidden === true,
            }));
    }
    async press_sequence(input: ComputerCall<"press_sequence">) {
        const { options, signal } = parseCall("press_sequence", input);
        return this.exclusive(async () => {
            this.menus.close(options.app);
            this.forget(options.app);
            return runNativeSequence({ input: options, signal });
        });
    }
    async launch_app(input: ComputerCall<"launch_app">) {
        const { options, signal } = parseCall("launch_app", input);
        return this.exclusive(async () => {
            const result = await this.native.run({
                args: [
                    "launch-app",
                    ...(options.bundle_id ? ["--bundle-id", options.bundle_id] : ["--path", options.path!]),
                    ...(!options.activate ? ["--background"] : []),
                ],
                timeoutMs: options.timeout_ms ?? 12000,
                signal,
            });
            if (!result.ok) {
                throw new ComputerUseError(
                    "LAUNCH_FAILED",
                    result.error ?? "Launch result is unknown; inspect before retrying.",
                    result
                );
            }
            return result;
        });
    }
    async quit_app(input: ComputerCall<"quit_app">) {
        const { options, signal } = parseCall("quit_app", input);
        return this.exclusive(async () => {
            const record = this.record(options);
            this.menus.close(options.app);
            this.forget(options.app);
            return this.native.run({
                args: [
                    "quit-app",
                    "--pid",
                    String(record.snapshot.pid),
                    "--launch",
                    String(record.snapshot.processLaunch),
                ],
                timeoutMs: options.timeout_ms ?? this.timeoutMs,
                signal,
            });
        });
    }
    private select({
        record,
        input,
        fallback = "none",
    }: {
        record: AppRecord;
        input: {
            element_index?: number;
            element_ref?: string;
            revision?: string;
        };
        fallback?: "none" | "focused" | "window";
    }) {
        if (input.element_index !== undefined && input.element_ref !== undefined) {
            throw new ComputerUseError("INVALID_TARGET", "Choose element_index or element_ref, not both.");
        }
        let index = input.element_index;
        if (input.element_ref) {
            const prefix = `${record.revision}:`;
            if (!input.element_ref.startsWith(prefix) || !/^\d+$/.test(input.element_ref.slice(prefix.length))) {
                throw new ComputerUseError("STALE_REFERENCE", "Element reference belongs to a different observation.");
            }
            index = Number(input.element_ref.slice(prefix.length));
        } else if (!input.revision && !record.implicitActionAllowed) {
            throw new ComputerUseError(
                "OBSERVE_FIRST",
                "After an action, observe again or explicitly use a ref/revision from its returned state."
            );
        }
        if (index === undefined && fallback === "focused") {
            const focused = record.snapshot.elements.filter(
                (row) => trueValue(row.AXFocused) && ["AXTextField", "AXTextArea", "AXComboBox"].includes(row.role)
            );
            if (focused.length === 1) {
                index = focused[0].index;
            }
        }
        if (index === undefined && fallback === "window") {
            index = 0;
        }
        const row = record.snapshot.elements.find((element) => element.index === index);
        if (!row) {
            throw new ComputerUseError("INVALID_TARGET", "Choose one currently observed element.");
        }
        return row;
    }
    private point({
        record,
        x,
        y,
        coordinateSpace,
    }: {
        record: AppRecord;
        x: number;
        y: number;
        coordinateSpace: "image" | "screen";
    }) {
        const { window, screenshot } = record.snapshot;
        if (coordinateSpace === "image") {
            if (!screenshot.width || !screenshot.height) {
                throw new ComputerUseError(
                    "IMAGE_REQUIRED",
                    "Get an image-backed state before using screenshot coordinates."
                );
            }
            if (x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) {
                throw new ComputerUseError("INVALID_POINT", "Point is outside the source screenshot.");
            }
            x = window.x + (x * window.width) / screenshot.width;
            y = window.y + (y * window.height) / screenshot.height;
        }
        if (x < window.x || y < window.y || x >= window.x + window.width || y >= window.y + window.height) {
            throw new ComputerUseError("INVALID_POINT", "Point is outside the observed window.");
        }
        return `${x},${y}`;
    }
    private async perform({
        input,
        build,
        signal,
    }: {
        input: {
            app: string;
            revision?: string;
            timeout_ms?: number;
        };
        build: (record: AppRecord) => string[];
        signal?: AbortSignal;
    }) {
        return this.exclusive(async () => {
            const record = this.record({
                app: input.app,
                revision: input.revision,
            });
            const argv = build(record);
            this.menus.close(input.app);
            const args = [
                "act",
                "--app",
                input.app,
                "--snapshot",
                record.snapshot.snapshot,
                ...argv,
                "--refresh",
                ...(!record.image ? ["--no-image"] : []),
            ];
            const capturePath = record.image ? this.artifacts.allocate("png") : undefined;
            if (capturePath) {
                args.push("--path", capturePath);
            }
            record.implicitActionAllowed = false;
            let result: AxResult;
            try {
                result = await this.native.run({ args, timeoutMs: input.timeout_ms ?? this.timeoutMs, signal });
            } catch (error) {
                logger.warn({ error, app: input.app }, "Native action transport failed; no retry");
                result = {
                    ok: false,
                    dispatchState: "uncertain",
                    error: "Native action delivery is unknown. Observe before doing anything else; no retry was attempted.",
                };
            }
            let state: ComputerState | undefined;
            const after = snapshotSchema.safeParse(result.after);
            if (
                after.success &&
                after.data.pid === record.snapshot.pid &&
                after.data.processLaunch === record.snapshot.processLaunch &&
                after.data.window.id === record.snapshot.window.id &&
                after.data.scope === record.snapshot.scope
            ) {
                const next = this.store({
                    app: input.app,
                    snapshot: after.data,
                    implicitActionAllowed: false,
                });
                state = this.state({
                    app: input.app,
                    record: next,
                    previous: record,
                });
            } else {
                this.forget(input.app);
            }
            if (capturePath && this.records.get(input.app)?.snapshot.screenshot.path !== capturePath) {
                this.artifacts.release(capturePath);
            }
            logger.debug(
                { app: input.app, ok: result.ok, action: argv[1], refreshed: Boolean(state) },
                "Computer Use action completed"
            );
            return {
                ok: result.ok,
                action: {
                    native: argv[1],
                    effect:
                        result.ok || result.dispatchState === "dispatched"
                            ? ("dispatched" as const)
                            : result.dispatchState === "not_started"
                              ? ("not_started" as const)
                              : ("unknown" as const),
                },
                verification: { status: "unverified" as const },
                error: result.error,
                state,
                clipboardRestore: result.clipboardRestore,
                recovery: result.recovery,
            };
        });
    }
    async click(input: ComputerCall<"click">) {
        const { options, signal } = parseCall("click", input);
        return this.perform({
            input: options,
            build: (record) => {
                const button =
                    ({ l: "left", r: "right", m: "middle" } as Record<string, string>)[options.mouse_button] ??
                    options.mouse_button;
                if (
                    options.prepare &&
                    (options.region_ref !== undefined || options.x !== undefined || options.y !== undefined)
                ) {
                    throw new ComputerUseError(
                        "INVALID_TARGET",
                        "prepare requires an observed element; coordinates cannot survive focus or scroll."
                    );
                }
                if (options.region_ref !== undefined) {
                    if (
                        options.x !== undefined ||
                        options.y !== undefined ||
                        options.element_ref !== undefined ||
                        options.element_index !== undefined
                    ) {
                        throw new ComputerUseError(
                            "INVALID_TARGET",
                            "Choose one visual region, element or coordinate pair."
                        );
                    }
                    const visual = visualObservationSchema.parse(record.snapshot);
                    const prefix = `${record.revision}:visual:`;
                    const id = options.region_ref.startsWith(prefix) ? options.region_ref.slice(prefix.length) : "";
                    if (!visual.perception.regions.some((region) => region.id === id)) {
                        throw new ComputerUseError(
                            "STALE_REFERENCE",
                            "Choose an OCR region from the current observed revision."
                        );
                    }
                    return [
                        "--action",
                        "click",
                        "--region",
                        id,
                        "--button",
                        button,
                        ...(options.click_count === 2 ? ["--double"] : []),
                        ...(options.background ? ["--background"] : []),
                    ];
                }
                if (options.x !== undefined || options.y !== undefined) {
                    if (
                        options.x === undefined ||
                        options.y === undefined ||
                        options.element_index !== undefined ||
                        options.element_ref !== undefined
                    ) {
                        throw new ComputerUseError(
                            "INVALID_TARGET",
                            "Choose an element or a complete coordinate pair."
                        );
                    }
                    if (!options.revision && !record.implicitActionAllowed) {
                        throw new ComputerUseError("OBSERVE_FIRST", "Observe before another coordinate action.");
                    }
                    return [
                        "--action",
                        "click",
                        "--coords",
                        this.point({
                            record,
                            x: options.x,
                            y: options.y,
                            coordinateSpace: options.coordinate_space,
                        }),
                        "--button",
                        button,
                        ...(options.click_count === 2 ? ["--double"] : []),
                        ...(options.background ? ["--background"] : []),
                    ];
                }
                const row = this.select({
                    record,
                    input: options,
                });
                if (
                    !options.physical &&
                    button === "left" &&
                    options.click_count === 1 &&
                    row.actions?.includes("AXPress")
                ) {
                    const activationKey = options.prepare
                        ? webActivationKey(safeRows(record.snapshot.elements), row)
                        : undefined;
                    return [
                        "--action",
                        activationKey ? "key" : "press",
                        "--element",
                        String(row.index),
                        ...(activationKey ? ["--keys", activationKey] : []),
                        ...(options.prepare
                            ? ["--prepare", ...(row.targetKey ? ["--target-key", row.targetKey] : [])]
                            : []),
                    ];
                }
                return [
                    "--action",
                    "click",
                    "--element",
                    String(row.index),
                    "--button",
                    button,
                    ...(options.click_count === 2 ? ["--double"] : []),
                    ...(options.prepare
                        ? ["--prepare", ...(row.targetKey ? ["--target-key", row.targetKey] : [])]
                        : options.background
                          ? ["--background"]
                          : []),
                ];
            },
            signal,
        });
    }
    async drag(input: ComputerCall<"drag">) {
        const { options, signal } = parseCall("drag", input);
        return this.perform({
            input: options,
            build: (record) => {
                if (!options.revision && !record.implicitActionAllowed) {
                    throw new ComputerUseError("OBSERVE_FIRST", "Observe before another coordinate action.");
                }
                return [
                    "--action",
                    "drag",
                    "--coords",
                    this.point({
                        record,
                        x: options.from_x,
                        y: options.from_y,
                        coordinateSpace: options.coordinate_space,
                    }),
                    "--to",
                    this.point({
                        record,
                        x: options.to_x,
                        y: options.to_y,
                        coordinateSpace: options.coordinate_space,
                    }),
                    "--duration",
                    String(options.duration),
                    ...(options.background ? ["--background"] : []),
                ];
            },
            signal,
        });
    }
    async scroll(input: ComputerCall<"scroll">) {
        const { options, signal } = parseCall("scroll", input);
        return this.perform({
            input: options,
            build: (record) => {
                if (options.pages !== undefined && options.pixels !== undefined) {
                    throw new ComputerUseError("INVALID_SCROLL", "Choose pages or pixels.");
                }
                let target: string[];
                if (options.x !== undefined || options.y !== undefined) {
                    if (
                        options.x === undefined ||
                        options.y === undefined ||
                        options.element_index !== undefined ||
                        options.element_ref !== undefined
                    ) {
                        throw new ComputerUseError(
                            "INVALID_TARGET",
                            "Choose an element or a complete coordinate pair."
                        );
                    }
                    if (!options.revision && !record.implicitActionAllowed) {
                        throw new ComputerUseError("OBSERVE_FIRST", "Observe before another coordinate action.");
                    }
                    target = [
                        "--coords",
                        this.point({
                            record,
                            x: options.x,
                            y: options.y,
                            coordinateSpace: options.coordinate_space,
                        }),
                    ];
                } else {
                    target = [
                        "--element",
                        String(
                            this.select({
                                record,
                                input: options,
                            }).index
                        ),
                    ];
                }
                const direction =
                    ({ u: "up", d: "down", l: "left", r: "right" } as Record<string, string>)[options.direction] ??
                    options.direction;
                return [
                    "--action",
                    "scroll",
                    ...target,
                    "--direction",
                    direction,
                    ...(options.pixels === undefined
                        ? ["--pages", String(options.pages ?? 1)]
                        : ["--pixels", String(options.pixels)]),
                    ...(options.background ? ["--background"] : []),
                ];
            },
            signal,
        });
    }
    private elementAction({
        input,
        action,
        flags,
        signal,
        fallback = "none",
    }: {
        input: {
            app: string;
            element_index?: number;
            element_ref?: string;
            revision?: string;
            timeout_ms?: number;
            prepare?: boolean;
        };
        action: string;
        flags: string[];
        signal?: AbortSignal;
        fallback?: "none" | "focused" | "window";
    }) {
        return this.perform({
            input,
            build: (record) => {
                const row = this.select({ record, input, fallback });
                return [
                    "--action",
                    action,
                    "--element",
                    String(row.index),
                    ...flags,
                    ...(input.prepare ? ["--prepare", ...(row.targetKey ? ["--target-key", row.targetKey] : [])] : []),
                ];
            },
            signal,
        });
    }
    async set_value(input: ComputerCall<"set_value">) {
        const { options, signal } = parseCall("set_value", input);
        if (options.prepare) {
            return this.perform({
                input: options,
                build: (record) => {
                    const row = this.select({ record, input: options });
                    if (
                        hasAncestorRole(safeRows(record.snapshot.elements), row, "AXWebArea") &&
                        ["AXTextField", "AXTextArea", "AXComboBox"].includes(row.role)
                    ) {
                        return [
                            "--action",
                            "paste",
                            "--element",
                            String(row.index),
                            "--text",
                            options.value,
                            "--format",
                            "text",
                            "--replace",
                            "--prepare",
                            ...(row.targetKey ? ["--target-key", row.targetKey] : []),
                        ];
                    }
                    return [
                        "--action",
                        "set",
                        "--element",
                        String(row.index),
                        "--value",
                        options.value,
                        "--prepare",
                        ...(row.targetKey ? ["--target-key", row.targetKey] : []),
                    ];
                },
                signal,
            });
        }
        return this.elementAction({
            input: options,
            action: "set",
            flags: ["--value", options.value],
            signal,
        });
    }
    async select_text(input: ComputerCall<"select_text">) {
        const { options, signal } = parseCall("select_text", input);
        return this.elementAction({
            input: options,
            action: "select",
            flags: [
                "--text",
                options.text,
                "--selection",
                options.selection_type,
                ...(options.prefix === undefined ? [] : ["--prefix", options.prefix]),
                ...(options.suffix === undefined ? [] : ["--suffix", options.suffix]),
            ],
            signal,
        });
    }
    async paste(input: ComputerCall<"paste">) {
        const { options, signal } = parseCall("paste", input);
        return this.elementAction({
            input: options,
            action: "paste",
            flags: ["--text", options.text, "--format", options.format, ...(options.replace ? ["--replace"] : [])],
            signal,
            fallback: "focused",
        });
    }
    async type_text(input: ComputerCall<"type_text">) {
        const { options, signal } = parseCall("type_text", input);
        return this.elementAction({
            input: options,
            action: "type",
            flags: ["--text", options.text],
            signal,
            fallback: "focused",
        });
    }
    async press_key(input: ComputerCall<"press_key">) {
        const { options, signal } = parseCall("press_key", input);
        const aliases: Record<string, string> = {
            super: "cmd",
            meta: "cmd",
            command: "cmd",
            control: "ctrl",
            option: "alt",
            enter: "return",
            esc: "escape",
            delete: "backspace",
        };
        const key = options.key
            .split(/[+,]/)
            .map((part) => {
                const value = part.trim().toLowerCase();
                return aliases[value] ?? value;
            })
            .join(",");
        return this.elementAction({
            input: options,
            action: "key",
            flags: ["--keys", key],
            signal,
            fallback: "window",
        });
    }
    async focus(input: ComputerCall<"focus">) {
        const { options, signal } = parseCall("focus", input);
        return this.elementAction({
            input: options,
            action: "focus",
            flags: [],
            signal,
            fallback: "window",
        });
    }
    async perform_secondary_action(input: ComputerCall<"perform_secondary_action">) {
        const { options, signal } = parseCall("perform_secondary_action", input);
        return this.perform({
            input: options,
            build: (record) => {
                const row = this.select({
                    record,
                    input: options,
                });
                const matches = (row.actions ?? []).filter(
                    (action) => action === options.action || normalizeAction(action) === normalizeAction(options.action)
                );
                if (matches.length !== 1) {
                    throw new ComputerUseError(
                        "UNEXPOSED_ACTION",
                        "Action must uniquely match one currently exposed AX action."
                    );
                }
                return ["--action", "perform", "--element", String(row.index), "--ax-action", matches[0]];
            },
            signal,
        });
    }
    get_elements(input: ComputerCall<"get_elements">) {
        const { options } = parseCall("get_elements", input);
        const record = this.record(options);
        const state = this.state({
            app: options.app,
            record,
            offset: options.offset,
            limit: options.limit,
            textLimit: options.text_limit,
        });
        return {
            app: state.app,
            revision: state.revision,
            observedAt: state.observedAt,
            elements: state.elements,
            page: state.page,
            text: state.text,
        };
    }
    find(input: ComputerCall<"find">) {
        const { options } = parseCall("find", input);
        const record = this.record({
            app: options.app,
        });
        const state = this.state({
            app: options.app,
            record,
            limit: record.snapshot.elements.length,
        });
        const query = options.query.toLocaleLowerCase();
        const matchedIndexes = new Set(
            safeRows(record.snapshot.elements)
                .filter(
                    (row) =>
                        (!options.role || row.role === options.role) &&
                        [elementLabel(row), row.AXIdentifier, String(row.AXValue ?? "")].some((value) =>
                            value?.toLocaleLowerCase().includes(query)
                        )
                )
                .map((row) => row.index)
        );
        const matched = state.elements.filter((element) => matchedIndexes.has(element.index));
        return {
            revision: state.revision,
            elements: matched.slice(0, options.limit),
            total: matched.length,
            truncated: matched.length > options.limit,
        };
    }
    async assist_task(input: ComputerCall<"assist_task">) {
        const { options, signal } = parseCall("assist_task", input);
        return this.exclusive(async () => {
            this.forget(options.app);
            this.menus.close(options.app);
            try {
                return await assistTask({
                    goal: options.goal,
                    hostDecision: options.host_decision,
                    expect: options.expect,
                    exact: options.exact,
                    chooser: options.chooser,
                    recovery: options.recovery,
                    driver: new NativeControlDriver({
                        app: options.app,
                        windowId: options.window_id,
                        scope: options.scope,
                        image: false,
                        prepare: "auto",
                        expectedURL: options.expected_url,
                        run: (call) => this.native.run(call),
                    }),
                    signal,
                    limits: {
                        timeoutMs: options.timeout_ms,
                        maxActions: options.max_steps,
                        maxRequests: options.max_requests,
                    },
                    evaluate: (call) => {
                        if (!options.jev) {
                            throw new Error("Semantic assist requires jev:true.");
                        }
                        return this.evaluate({ ...call, provider: options.provider });
                    },
                });
            } finally {
                this.forget(options.app);
                this.menus.close(options.app);
            }
        });
    }
    async run_workflow(input: ComputerCall<"run_workflow">) {
        const { options, signal } = parseCall("run_workflow", input);
        const app = options.plan.app;
        return this.exclusive(async () => {
            this.forget(app);
            this.menus.close(app);
            try {
                return await replayWorkflow({
                    plan: options.plan,
                    values: options.values,
                    rebind: options.rebind,
                    jev: options.jev,
                    driver: new NativeControlDriver({
                        app,
                        windowId: options.window_id,
                        scope: options.plan.scope,
                        image: false,
                        prepare: "auto",
                        expectedURL: options.expected_url,
                        run: (call) => this.native.run(call),
                    }),
                    signal,
                    limits: {
                        timeoutMs: options.timeout_ms,
                        maxActions: options.max_steps,
                        maxRequests: options.max_requests,
                    },
                    evaluate: (call) => this.evaluate({ ...call, provider: options.provider }),
                });
            } finally {
                this.forget(app);
                this.menus.close(app);
            }
        });
    }
    async fill_form(input: ComputerCall<"fill_form">) {
        const { options, signal } = parseCall("fill_form", input);
        return this.exclusive(async () => {
            this.forget(options.app);
            this.menus.close(options.app);
            try {
                return await fillForm({
                    data: options.data,
                    driver: new NativeControlDriver({
                        app: options.app,
                        windowId: options.window_id,
                        scope: options.scope,
                        image: false,
                        prepare: "auto",
                        expectedURL: options.expected_url,
                        run: (call) => this.native.run(call),
                    }),
                    signal,
                    limits: {
                        timeoutMs: options.timeout_ms,
                        maxRequests: options.max_requests,
                        maxActions: options.max_fields,
                    },
                    evaluate: (call) => this.evaluate({ ...call, provider: options.provider }),
                });
            } finally {
                this.forget(options.app);
                this.menus.close(options.app);
            }
        });
    }
    async resolve_visual_target(input: ComputerCall<"resolve_visual_target">) {
        const { options, signal } = parseCall("resolve_visual_target", input);
        return this.exclusive(async () => {
            const record = this.record(options);
            const parsed = visualObservationSchema.safeParse(record.snapshot);
            if (!parsed.success || parsed.data.perception.method !== "vision-ocr") {
                throw new ComputerUseError(
                    "OCR_REQUIRED",
                    "Observe this app with perception:ocr and image:true first."
                );
            }
            if (Date.now() > parsed.data.perception.capture.created * 1000 + 30000) {
                throw new ComputerUseError(
                    "OBSERVATION_EXPIRED",
                    "Visual evidence expired; capture again before choosing."
                );
            }
            const budget = new OperationBudget({
                timeoutMs: options.timeout_ms ?? 15000,
                maxActions: 0,
                maxRequests: 1,
                signal,
            });
            const result = await resolveVisualTarget({
                observation: parsed.data,
                intent: options.intent,
                chooser: options.chooser,
                signal: budget.signal,
                evaluate:
                    options.chooser === "exact"
                        ? undefined
                        : async (call) => {
                              budget.take("request");
                              return this.evaluate({
                                  ...call,
                                  provider: options.provider,
                                  signal: budget.signal,
                                  timeoutMs: budget.remaining(),
                              });
                          },
            });
            return {
                ...result,
                region_ref: result.selected ? `${record.revision}:visual:${result.selected.id}` : null,
                revision: record.revision,
                metrics: budget.snapshot(),
            };
        });
    }
    async resolve_target(input: ComputerCall<"resolve_target">) {
        const { options, signal } = parseCall("resolve_target", input);
        return this.exclusive(async () => {
            let record = this.record({ app: options.app, revision: options.revision });
            if (options.host_decision) {
                const rootKey = options.within_ref
                    ? this.select({ record, input: { element_ref: options.within_ref } }).targetKey
                    : undefined;
                if (options.within_ref && !rootKey) {
                    throw new ComputerUseError(
                        "INVALID_TARGET",
                        "Host handoff scope requires a native target fingerprint."
                    );
                }
                this.forget(options.app);
                const result = await this.native.run({
                    args: [
                        "see",
                        "--app",
                        options.app,
                        "--window-id",
                        String(record.snapshot.window.id),
                        "--scope",
                        record.snapshot.scope,
                        "--depth",
                        "50",
                        "--no-image",
                    ],
                    timeoutMs: options.timeout_ms ?? this.timeoutMs,
                    signal,
                });
                if (!result.ok) {
                    throw new ComputerUseError(
                        "OBSERVATION_FAILED",
                        result.error ?? "Host handoff observation failed.",
                        result
                    );
                }
                const fresh = snapshotSchema.parse(result);
                if (!sameScope(record.snapshot, fresh)) {
                    throw new ComputerUseError("SCOPE_CHANGED", "Host handoff app/window changed.");
                }
                record = this.store({ app: options.app, snapshot: fresh, implicitActionAllowed: true, image: false });
                if (rootKey) {
                    const roots = fresh.elements.filter((row) => row.targetKey === rootKey);
                    if (roots.length !== 1) {
                        throw new ComputerUseError("INVALID_TARGET", "Host handoff scope changed or became ambiguous.");
                    }
                    options.within_ref = `${record.revision}:${roots[0].index}`;
                }
            }
            let observation: Observation = record.snapshot;
            const admittedElements = new Set(
                candidatesFor({ observation, action: options.action }).map((candidate) => candidate.element)
            );
            observation = {
                ...observation,
                elements: observation.elements.map((row) =>
                    admittedElements.has(row.index) ? row : { ...row, actions: [], valueSettable: false }
                ),
            };
            if (options.within_ref) {
                const root = this.select({ record, input: { element_ref: options.within_ref } });
                const start = observation.elements.findIndex((row) => row.index === root.index);
                let end = start + 1;
                while (end < observation.elements.length && observation.elements[end].depth > root.depth) {
                    end++;
                }
                observation = { ...observation, elements: observation.elements.slice(start, end) };
            }
            if (options.query || options.role) {
                const query = options.query?.toLocaleLowerCase();
                observation = {
                    ...observation,
                    elements: observation.elements.filter(
                        (row) =>
                            (!options.role || row.role === options.role) &&
                            (!query ||
                                elementLabel(row).toLocaleLowerCase().includes(query) ||
                                row.AXIdentifier?.toLocaleLowerCase().includes(query))
                    ),
                };
            }
            const session = new ControlSession({
                driver: {
                    observe: async () => observation,
                    act: async () => {
                        throw new Error("Resolution is read-only.");
                    },
                },
                signal,
                limits: { maxActions: 0, maxRequests: 1, timeoutMs: options.timeout_ms ?? 15000 },
                evaluate: async (call) =>
                    this.evaluate({
                        ...call,
                        provider: options.provider,
                    }),
            });
            const result = await chooseCandidate({
                observation,
                intent: options.intent,
                mode: options.chooser,
                action: options.action,
                binding: options.binding,
                hostDecision: options.host_decision,
                session,
            });
            return {
                ...result,
                ref: result.selected ? `${record.revision}:${result.selected.element}` : null,
                revision: record.revision,
                metrics: session.report(),
            };
        });
    }
    async await_condition(input: ComputerCall<"await_condition">) {
        const { options, signal } = parseCall("await_condition", input);
        return this.exclusive(async () => {
            const previous = this.record(options).snapshot;
            this.forget(options.app);
            this.menus.close(options.app);
            const nativeDriver = new NativeControlDriver({
                app: options.app,
                windowId: previous.window.id,
                scope: previous.scope,
                image: false,
                expectedURL: options.expected_url,
                run: (call) => this.native.run(call),
            });
            const driver: ControlDriver = {
                observe: async (call) => {
                    const observation = await nativeDriver.observe(call);
                    if (!sameScope(previous, observation)) {
                        throw new ComputerUseError("SCOPE_CHANGED", "The observed app instance or window changed.");
                    }
                    return observation;
                },
                act: async () => {
                    throw new Error("Semantic waits cannot dispatch actions.");
                },
            };
            const result = await awaitCondition({
                condition: options.condition,
                evidenceScope: options.evidence_scope,
                exact: options.exact,
                driver,
                signal,
                source: new NativeObservationSource({ driver, run: (call) => this.native.run(call) }),
                limits: { timeoutMs: options.timeout_ms ?? 30000, maxRequests: options.max_requests },
                evaluate: async (call) =>
                    this.evaluate({
                        ...call,
                        provider: options.provider,
                    }),
            });
            return { ...result, refreshRequired: true };
        });
    }
    async verify_state(input: ComputerCall<"verify_state">) {
        const { options, signal } = parseCall("verify_state", input);
        if (!options.exact && !options.jev) {
            throw new ComputerUseError(
                "JEV_NOT_ENABLED",
                "Provide exact readback or explicitly enable Jev with jev:true."
            );
        }
        this.record({ app: options.app, revision: options.revision });
        const budget = new OperationBudget({
            timeoutMs: options.timeout_ms ?? 15000,
            maxActions: 0,
            maxRequests: 1,
            signal,
        });
        const state = await this.get_app_state({
            app: options.app,
            image: false,
            timeout_ms: Math.max(1, Math.floor(budget.remaining())),
            signal: budget.signal,
        });
        return this.exclusive(async () => {
            const record = this.record({ app: options.app, revision: state.revision });
            const result = await judgeOutcome({
                observation: record.snapshot,
                expect: options.expect,
                exact: options.exact,
                signal: budget.signal,
                evaluate: async (call) => {
                    budget.take("request");
                    return this.evaluate({
                        ...call,
                        provider: options.provider,
                        timeoutMs: budget.remaining(),
                        signal: budget.signal,
                    });
                },
            });
            return { ...result, revision: record.revision, metrics: budget.snapshot() };
        });
    }
    async read_image(app: string): Promise<Uint8Array> {
        const record = this.record({
            app,
        });
        const screenshot = record.snapshot.screenshot;
        const expected = record.snapshot.perception?.capture?.pngHash;
        if (!screenshot.path || !expected) {
            throw new ComputerUseError("IMAGE_REQUIRED", "Get a fresh image-backed state first.");
        }
        const file = Bun.file(screenshot.path);
        if (file.size > 32 * 1024 * 1024) {
            throw new ComputerUseError("IMAGE_TOO_LARGE", "Screenshot exceeds the image budget.");
        }
        const data = await readFile(screenshot.path);
        if (createHash("sha256").update(data).digest("hex") !== expected) {
            throw new ComputerUseError("IMAGE_CHANGED", "Screenshot file changed after capture.");
        }
        return data;
    }
    close_session(input: ComputerCall<"close_session"> = {}) {
        const { options } = parseCall("close_session", input);
        if (this.busy) {
            throw new ComputerUseError("BUSY", "Wait for the current operation before closing its session.");
        }
        this.menus.close(options.app);
        if (options.app) {
            this.forget(options.app);
        } else {
            for (const app of this.records.keys()) {
                this.forget(app);
            }
        }
        if (this.records.size === 0) {
            this.artifacts.dispose();
        }
        return { ok: true };
    }
}
