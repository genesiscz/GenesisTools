import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { OperationBudget } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { chooseCandidate } from "../decision/chooser";
import { judgeOutcome } from "../decision/decisions";
import { elementLabel, type Observation, observationSchema } from "../decision/observation";
import { ControlSession } from "../decision/session";
import { type AxResult, runAxAsync } from "../runner";
import { diffSnapshots, type SnapshotDiff } from "../snapshot-diff";
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
    value?: string | number | boolean;
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
    app: string;
    revision: string;
    pid: number;
    window: Snapshot["window"];
    scope: string;
    text: string;
    elements: ComputerElement[];
    changes?: SnapshotDiff;
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
export class ComputerUse {
    readonly target = "mac";
    private readonly native: NativeBridge;
    private readonly records = new Map<string, AppRecord>();
    private readonly session = randomUUID().slice(0, 8);
    private sequence = 0;
    private busy = false;
    constructor(
        options: {
            native?: NativeBridge;
            timeoutMs?: number;
        } = {}
    ) {
        this.native = options.native ?? { run: runAxAsync };
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
    private store({
        app,
        snapshot,
        implicitActionAllowed,
        image,
    }: {
        app: string;
        snapshot: Snapshot;
        implicitActionAllowed: boolean;
        image?: boolean;
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
        };
        this.records.set(app, record);
        return record;
    }
    private state({ app, record, previous }: { app: string; record: AppRecord; previous?: AppRecord }): ComputerState {
        const snapshot = record.snapshot;
        const elements = safeRows(snapshot.elements).map(
            (row): ComputerElement => ({
                ref: `${record.revision}:${row.index}`,
                index: row.index,
                depth: row.depth,
                role: row.role,
                label: elementLabel(row),
                identifier: row.AXIdentifier,
                value: row.AXValue,
                enabled: ![false, 0, "0", "false"].includes(row.AXEnabled ?? ""),
                focused: trueValue(row.AXFocused),
                actions: (row.actions ?? []).map((raw) => ({ raw, name: normalizeAction(raw) })),
                bounds: [row.x, row.y, row.width, row.height].every((value) => typeof value === "number")
                    ? { x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) }
                    : undefined,
            })
        );
        const comparable =
            previous &&
            previous.snapshot.pid === snapshot.pid &&
            previous.snapshot.processLaunch === snapshot.processLaunch &&
            previous.snapshot.window.id === snapshot.window.id &&
            previous.snapshot.scope === snapshot.scope;
        const changes = comparable
            ? diffSnapshots(safeRows(previous.snapshot.elements), safeRows(snapshot.elements))
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
                ? `Changes: +${changes.added.length} -${changes.removed.length} ~${changes.changed.length}; ${changes.unchanged} unchanged. Use current indexes or explicit refs; old refs are invalid.`
                : `${elements.length} observed elements.`,
            ...lines,
        ].join("\n");
        const screenshot = snapshot.screenshot;
        return {
            app,
            revision: record.revision,
            pid: snapshot.pid,
            window: snapshot.window,
            scope: snapshot.scope,
            text,
            elements,
            changes,
            observedAt: new Date().toISOString(),
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
            const result = await this.native.run({ args, timeoutMs: options.timeout_ms ?? this.timeoutMs, signal });
            if (!result.ok) {
                throw new ComputerUseError("OBSERVATION_FAILED", result.error ?? "Native observation failed.", result);
            }
            const snapshot = snapshotSchema.parse(result);
            if (
                prior &&
                options.window_id === undefined &&
                options.window_index === undefined &&
                (snapshot.pid !== prior.snapshot.pid || snapshot.processLaunch !== prior.snapshot.processLaunch)
            ) {
                this.records.delete(options.app);
                throw new ComputerUseError("APP_REPLACED", "The app process changed. Start a fresh session.");
            }
            const record = this.store({
                app: options.app,
                snapshot,
                implicitActionAllowed: true,
                image: options.image,
            });
            return this.state({
                app: options.app,
                record,
                previous: options.disableDiff ? undefined : prior,
            });
        });
    }
    async list_apps(input: ComputerCall<"list_apps"> = {}) {
        const { options, signal } = parseCall("list_apps", input);
        const result = await this.native.run({
            args: ["apps", ...(options.include_background ? ["--all"] : [])],
            timeoutMs: this.timeoutMs,
            signal,
        });
        if (!result.ok) {
            throw new ComputerUseError("APP_LIST_FAILED", result.error ?? "Could not inspect running apps.");
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
                this.records.delete(input.app);
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
                    return ["--action", "press", "--element", String(row.index)];
                }
                return [
                    "--action",
                    "click",
                    "--element",
                    String(row.index),
                    "--button",
                    button,
                    ...(options.click_count === 2 ? ["--double"] : []),
                    ...(options.background ? ["--background"] : []),
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
        };
        action: string;
        flags: string[];
        signal?: AbortSignal;
        fallback?: "none" | "focused" | "window";
    }) {
        return this.perform({
            input,
            build: (record) => [
                "--action",
                action,
                "--element",
                String(
                    this.select({
                        record,
                        input,
                        fallback,
                    }).index
                ),
                ...flags,
            ],
            signal,
        });
    }
    async set_value(input: ComputerCall<"set_value">) {
        const { options, signal } = parseCall("set_value", input);
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
            flags: ["--text", options.text, "--format", options.format],
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
    find(input: ComputerCall<"find">) {
        const { options } = parseCall("find", input);
        const record = this.record({
            app: options.app,
        });
        const state = this.state({
            app: options.app,
            record,
        });
        const query = options.query.toLocaleLowerCase();
        const matched = state.elements.filter(
            (element) =>
                (!options.role || element.role === options.role) &&
                [element.label, element.identifier, String(element.value ?? "")].some((value) =>
                    value?.toLocaleLowerCase().includes(query)
                )
        );
        return {
            revision: state.revision,
            elements: matched.slice(0, options.limit),
            total: matched.length,
            truncated: matched.length > options.limit,
        };
    }
    async resolve_target(input: ComputerCall<"resolve_target">) {
        const { options, signal } = parseCall("resolve_target", input);
        return this.exclusive(async () => {
            const record = this.record({ app: options.app, revision: options.revision });
            let observation: Observation = record.snapshot;
            if (options.within_ref) {
                const root = this.select({ record, input: { element_ref: options.within_ref } });
                const start = observation.elements.findIndex((row) => row.index === root.index);
                let end = start + 1;
                while (end < observation.elements.length && observation.elements[end].depth > root.depth) {
                    end++;
                }
                observation = { ...observation, elements: observation.elements.slice(start, end) };
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
                    (await import("@genesiscz/utils/ai/evaluation/service")).evaluateRequest({
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
                    return (await import("@genesiscz/utils/ai/evaluation/service")).evaluateRequest({
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
        if (options.app) {
            this.records.delete(options.app);
        } else {
            this.records.clear();
        }
        return { ok: true };
    }
}
