import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { z } from "zod";

const { log } = logger.scoped("control-simulator");

/**
 * `idb` reports a simulator element in DEVICE points, with the app's own accessibility
 * identifier in `AXUniqueId` and its accessibility label in `AXLabel`. The host macOS
 * Accessibility API cannot reach these: see `docs/benchmarks-simulator.md` for the measurement.
 */
export const idbElementSchema = z
    .object({
        AXFrame: z.string().optional(),
        AXUniqueId: z.string().nullable().optional(),
        AXLabel: z.string().nullable().optional(),
        AXValue: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
        frame: z.object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
        }),
        role: z.string().nullable().optional(),
        role_description: z.string().nullable().optional(),
        subrole: z.string().nullable().optional(),
        type: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        help: z.string().nullable().optional(),
        enabled: z.boolean().nullable().optional(),
        content_required: z.boolean().nullable().optional(),
        custom_actions: z.array(z.string()).nullable().optional(),
    })
    .passthrough();
export type IdbElement = z.infer<typeof idbElementSchema>;

export interface IdbCall {
    udid: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** Everything this module can ask idb to do. Anything not listed here is not supported. */
export type IdbVerb =
    | { kind: "describe-all" }
    | { kind: "describe-point"; x: number; y: number }
    | { kind: "tap"; x: number; y: number; durationSeconds?: number }
    | { kind: "text"; text: string }
    | { kind: "key"; keycode: number }
    | { kind: "key-sequence"; keycodes: number[] }
    | { kind: "swipe"; fromX: number; fromY: number; toX: number; toY: number; deltaPoints?: number }
    | { kind: "button"; button: "APPLE_PAY" | "HOME" | "LOCK" | "SIDE_BUTTON" | "SIRI" };

export function idbArguments(verb: IdbVerb, udid: string): string[] {
    const base = ["idb", "ui", verb.kind, "--udid", udid];
    switch (verb.kind) {
        case "describe-all":
            return base;
        case "describe-point":
            return [...base, String(Math.round(verb.x)), String(Math.round(verb.y))];
        case "tap":
            return [
                ...base,
                String(Math.round(verb.x)),
                String(Math.round(verb.y)),
                ...(verb.durationSeconds === undefined ? [] : ["--duration", String(verb.durationSeconds)]),
            ];
        case "text":
            return [...base, verb.text];
        case "key":
            return [...base, String(verb.keycode)];
        case "key-sequence":
            return [...base, ...verb.keycodes.map(String)];
        case "swipe":
            return [
                ...base,
                String(Math.round(verb.fromX)),
                String(Math.round(verb.fromY)),
                String(Math.round(verb.toX)),
                String(Math.round(verb.toY)),
                ...(verb.deltaPoints === undefined ? [] : ["--delta", String(Math.round(verb.deltaPoints))]),
            ];
        case "button":
            return [...base, verb.button];
    }
}

export interface IdbOutcome {
    ok: boolean;
    stdout: string;
    stderr: string;
    error?: string;
}

/** Runs one idb verb under a deadline. A non-zero exit is reported, never thrown away. */
export async function runIdb(verb: IdbVerb, call: IdbCall): Promise<IdbOutcome> {
    call.signal?.throwIfAborted();
    const command = idbArguments(verb, call.udid);
    const result = await boundedCommand({
        command,
        timeoutMs: Math.max(1, Math.floor(call.timeoutMs ?? 15_000)),
        signal: call.signal,
    });
    const ok = result.status === 0 && result.error === undefined;
    if (!ok) {
        log.warn(
            { verb: verb.kind, udid: call.udid, status: result.status, stderr: result.stderr.slice(0, 400) },
            "idb verb failed"
        );
    }
    return {
        ok,
        stdout: result.stdout,
        stderr: result.stderr,
        error: ok
            ? undefined
            : (result.error?.message ??
              (result.stderr.trim().slice(0, 400) || `idb ${verb.kind} exited ${result.status}`)),
    };
}

/**
 * idb prints one JSON object per line for a point and a JSON array for the whole screen.
 * Parses either shape and drops rows idb could not describe rather than failing the read.
 */
export function parseIdbElements(stdout: string): IdbElement[] {
    const text = stdout.trim();
    if (!text) {
        return [];
    }
    const candidates: unknown[] = [];
    try {
        const parsed = SafeJSON.parse(text, { strict: true }) as unknown;
        candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                candidates.push(SafeJSON.parse(trimmed, { strict: true }) as unknown);
            } catch {
                log.debug({ line: trimmed.slice(0, 200) }, "idb line is not JSON");
            }
        }
    }
    const elements: IdbElement[] = [];
    for (const candidate of candidates) {
        const parsed = idbElementSchema.safeParse(candidate);
        if (parsed.success) {
            elements.push(parsed.data);
        } else {
            log.debug({ issue: parsed.error.issues[0]?.message }, "idb element did not parse");
        }
    }
    return elements;
}

export async function describeAll(call: IdbCall): Promise<IdbElement[]> {
    const outcome = await runIdb({ kind: "describe-all" }, call);
    if (!outcome.ok) {
        throw new Error(`Simulator screen read failed: ${outcome.error}`);
    }
    return parseIdbElements(outcome.stdout);
}

export async function describePoint(call: IdbCall & { x: number; y: number }): Promise<IdbElement | undefined> {
    const outcome = await runIdb({ kind: "describe-point", x: call.x, y: call.y }, call);
    if (!outcome.ok) {
        return undefined;
    }
    return parseIdbElements(outcome.stdout)[0];
}

/** `idb` must be installed for any of this to work; say so once, with the fix. */
export async function idbAvailable(signal?: AbortSignal): Promise<boolean> {
    const result = await boundedCommand({ command: ["idb", "--help"], timeoutMs: 10_000, signal });
    return result.status === 0;
}

export const IDB_INSTALL_HINT = "idb is required for simulator control: brew install facebook/fb/idb-companion";
