/** Pure helpers behind `perf`, `emulate` and `intercept`: flag parsers, the A/B spec schema, metric extraction. */
import type { CdpLike } from "@genesiscz/utils/chrome-devtools/cdp-like";
import { NETWORK_PRESET_NAMES, type NetworkConditions } from "@genesiscz/utils/chrome-devtools/emulate";
import { globToRegExp } from "@genesiscz/utils/chrome-devtools/intercept";
import type { PerfMark, PerfSnapshot } from "@genesiscz/utils/chrome-devtools/perf";
import { cumulativeLayoutShift, frameTotals, visibleMaxLagMs } from "@genesiscz/utils/chrome-devtools/summaries";
import { z } from "zod";

/** Commander collector for a repeatable option: `--mark a --mark b` → `["a", "b"]`. Commas stay inside a value. */
export function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

/**
 * `name=selector[@text]` → a PerfMark. The name ends at the first `=`, the text starts at the first `@` after it,
 * so a selector keeps its own `=` (`cases=[data-testid=cases]`) and the text may hold `@` (`me=.user@a@b.c`).
 * An empty selector (`ready=@Requests ready`) looks at the whole body.
 */
export function parseMarkSpec(spec: string): PerfMark {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
        throw new Error(`--mark '${spec}' needs the form name=selector[@text], e.g. cases=[data-testid=cases]`);
    }

    const name = spec.slice(0, eq).trim();
    if (!/^[\w.:-]+$/.test(name)) {
        throw new Error(
            `--mark name '${name}' may only hold letters, digits, '_', '-', '.' and ':' (the form is name=selector[@text])`
        );
    }

    const rest = spec.slice(eq + 1);
    const at = rest.indexOf("@");
    const selector = (at === -1 ? rest : rest.slice(0, at)).trim();
    const text = at === -1 ? undefined : rest.slice(at + 1);
    if (!selector && !text) {
        throw new Error(`--mark '${spec}' names no selector and no text, so it would hold at once`);
    }

    const mark: PerfMark = { name };
    if (selector) {
        mark.selector = selector;
    }

    if (text) {
        mark.text = text;
    }

    return mark;
}

/** A replace rule after its regex compiled. `from` keeps the source for printing. */
export interface ReplaceRule {
    from: string;
    to: string;
    pattern: RegExp;
}

function regexError(source: string): string | null {
    try {
        new RegExp(source, "g");
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

export function compileReplace(from: string, to: string): ReplaceRule {
    const problem = regexError(from);
    if (problem !== null) {
        throw new Error(`'${from}' is not a valid regular expression: ${problem}`);
    }

    return { from, to, pattern: new RegExp(from, "g") };
}

/** `from=>to` → a rule. `from` is a regex (global), `to` may use `$1`; everything after the first `=>` is `to`. */
export function parseReplaceSpec(spec: string): ReplaceRule {
    const arrow = spec.indexOf("=>");
    if (arrow <= 0) {
        throw new Error(
            `--replace '${spec}' needs the form from=>to, e.g. 'rows=>ROWS' or '"debug":false=>"debug":true'`
        );
    }

    return compileReplace(spec.slice(0, arrow), spec.slice(arrow + 2));
}

/** Applies every rule in order; `replaced` counts the matches, so a rule that never fires is visible. */
export function applyReplacements(body: string, rules: ReplaceRule[]): { body: string; replaced: number } {
    let replaced = 0;
    let current = body;
    for (const rule of rules) {
        replaced += current.match(rule.pattern)?.length ?? 0;
        current = current.replace(rule.pattern, rule.to);
    }

    return { body: current, replaced };
}

const presetSchema = z.enum(NETWORK_PRESET_NAMES);

const regexSchema = z.string().superRefine((value, ctx) => {
    const problem = regexError(value);
    if (problem !== null) {
        ctx.addIssue({ code: "custom", message: `not a valid regular expression: ${problem}` });
    }
});

const markSchema = z
    .object({
        name: z.string().min(1),
        selector: z.string().min(1).optional(),
        text: z.string().optional(),
        minHeight: z.number().nonnegative().optional(),
        path: z.string().optional(),
    })
    .strict();

const variantSchema = z
    .object({
        name: z.string().min(1),
        url: z.string().url().optional(),
        cpu: z.number().min(1).optional(),
        network: presetSchema.optional(),
        rewrite: z
            .array(
                z
                    .object({
                        url: z.string().min(1),
                        replace: z.array(z.object({ from: regexSchema, to: z.string() }).strict()).min(1),
                    })
                    .strict()
            )
            .optional(),
    })
    .strict();

export const abSpecSchema = z
    .object({
        url: z.string().url(),
        rounds: z.number().int().min(1).default(3),
        order: z.enum(["abba", "same"]).default("abba"),
        cpu: z.number().min(1).optional(),
        network: presetSchema.optional(),
        waitMs: z.number().int().positive().default(10_000),
        until: z
            .object({ selector: z.string().min(1), text: z.string().optional(), minHeight: z.number().optional() })
            .strict()
            .optional(),
        marks: z.array(markSchema).default([]),
        clearStorage: z
            .object({ localStorage: z.array(z.string()).optional(), sessionStorage: z.array(z.string()).optional() })
            .strict()
            .optional(),
        clearCookies: z.array(z.string().min(1)).optional(),
        /** A page function run after every load, e.g. `() => window.appConfig.replay`; its value is saved per sample. */
        probe: z.string().min(1).optional(),
        variants: z.array(variantSchema).min(1),
    })
    .strict()
    .superRefine((spec, ctx) => {
        const seen = new Set<string>();
        spec.variants.forEach((variant, index) => {
            if (seen.has(variant.name)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["variants", index, "name"],
                    message: `duplicate variant name '${variant.name}'`,
                });
            }

            seen.add(variant.name);
        });
    });

export type AbSpec = z.infer<typeof abSpecSchema>;
export type AbSpecVariant = AbSpec["variants"][number];

/** `variants[1].rewrite[0].replace[0].from` for a zod issue path. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
    let out = "";
    for (const key of path) {
        if (typeof key === "number") {
            out += `[${key}]`;
        } else {
            out += out ? `.${String(key)}` : String(key);
        }
    }

    return out || "spec";
}

/** Validates a parsed spec file; every error names the field it is about. */
export function parseAbSpec(raw: unknown): { ok: true; spec: AbSpec } | { ok: false; errors: string[] } {
    const result = abSpecSchema.safeParse(raw);
    if (result.success) {
        return { ok: true, spec: result.data };
    }

    return {
        ok: false,
        errors: result.error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`),
    };
}

/** One variant's rewrite rules, compiled: a url matcher plus its replace rules. */
export interface CompiledRewrite {
    url: string;
    matches: RegExp;
    rules: ReplaceRule[];
}

export function compileVariantRewrites(variant: AbSpecVariant): CompiledRewrite[] {
    return (variant.rewrite ?? []).map((rewrite) => ({
        url: rewrite.url,
        matches: globToRegExp(rewrite.url),
        rules: rewrite.replace.map((rule) => compileReplace(rule.from, rule.to)),
    }));
}

/** Applies every rewrite of the variant whose glob matches `url` (all of them, not only the first). */
export function applyVariantRewrites(
    rewrites: CompiledRewrite[],
    url: string,
    body: string
): { body: string; replaced: number } {
    let current = body;
    let replaced = 0;
    for (const rewrite of rewrites) {
        if (rewrite.matches.test(url)) {
            const result = applyReplacements(current, rewrite.rules);
            current = result.body;
            replaced += result.replaced;
        }
    }

    return { body: current, replaced };
}

/** Every distinct url glob any variant rewrites: one Fetch pattern each, shared by all variants. */
export function rewriteGlobs(spec: AbSpec): string[] {
    return [...new Set(spec.variants.flatMap((variant) => (variant.rewrite ?? []).map((rewrite) => rewrite.url)))];
}

export const BASE_METRICS = ["blockingMs", "totalFrameMs", "worstFrameMs", "framesOver200", "maxLagMs", "cls"] as const;

/** The numbers compared across runs: frame totals, lag, CLS, and one `mark:<name>` per mark that was reached. */
export function perfMetrics(snapshot: PerfSnapshot): Record<string, number> {
    const totals = frameTotals(snapshot.frames);
    const metrics: Record<string, number> = {
        blockingMs: totals.blockingMs,
        totalFrameMs: totals.totalMs,
        worstFrameMs: totals.worstMs,
        framesOver200: totals.over200,
        maxLagMs: visibleMaxLagMs(snapshot),
        cls: cumulativeLayoutShift(snapshot.shifts),
    };
    for (const [name, ms] of Object.entries(snapshot.marks)) {
        metrics[`mark:${name}`] = Math.round(ms);
    }

    return metrics;
}

/** Fixed metrics in their declared order first, then the rest (marks) alphabetically. */
export function orderMetricKeys(keys: Iterable<string>): string[] {
    const all = new Set(keys);
    const fixed = ["loadEventMs", ...BASE_METRICS].filter((key) => all.has(key));
    const rest = [...all].filter((key) => !fixed.includes(key)).sort();
    return [...fixed, ...rest];
}

export function formatMetric(key: string, value: number): string {
    return key === "cls" ? value.toFixed(3) : String(Math.round(value * 10) / 10);
}

/** Custom `--latency/--down/--up/--offline` → conditions; null when none of them was given. */
export function customNetwork(input: {
    latency?: string;
    down?: string;
    up?: string;
    offline?: boolean;
}): { conditions: NetworkConditions | null } | { error: string } {
    const given = input.latency !== undefined || input.down !== undefined || input.up !== undefined;
    if (!given && !input.offline) {
        return { conditions: null };
    }

    const parse = (raw: string | undefined, flag: string, fallback: number): number | string => {
        if (raw === undefined) {
            return fallback;
        }

        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
            return `${flag} must be a number of 0 or more, got '${raw}'`;
        }

        return value;
    };
    const latencyMs = parse(input.latency, "--latency", 0);
    const downloadKbps = parse(input.down, "--down", -1);
    const uploadKbps = parse(input.up, "--up", -1);
    for (const value of [latencyMs, downloadKbps, uploadKbps]) {
        if (typeof value === "string") {
            return { error: value };
        }
    }

    return {
        conditions: {
            offline: input.offline === true,
            latencyMs: Number(latencyMs),
            downloadKbps: Number(downloadKbps),
            uploadKbps: Number(uploadKbps),
        },
    };
}

export function describeNetwork(conditions: NetworkConditions): string {
    if (conditions.offline) {
        return "offline";
    }

    const rate = (kbps: number): string => (kbps < 0 ? "unlimited" : `${kbps} kbps`);
    if (conditions.latencyMs === 0 && conditions.downloadKbps < 0 && conditions.uploadKbps < 0) {
        return "no shaping";
    }

    return `${conditions.latencyMs} ms latency, down ${rate(conditions.downloadKbps)}, up ${rate(conditions.uploadKbps)}`;
}

export type InterceptMode =
    | { kind: "replace"; rules: ReplaceRule[] }
    | { kind: "body-file"; path: string }
    | { kind: "block" }
    | { kind: "map-dir"; dir: string };

export type InterceptStage = "request" | "response";
export const INTERCEPT_STAGES: readonly InterceptStage[] = ["request", "response"];

export function isInterceptStage(value: string): value is InterceptStage {
    return value === "request" || value === "response";
}

/** Exactly one of --replace / --body-file / --block; replace parses its rules here. */
export function interceptMode(input: {
    replace: string[];
    bodyFile?: string;
    block?: boolean;
    mapDir?: string;
}): { mode: InterceptMode } | { error: string } {
    const chosen = [
        input.replace.length > 0,
        input.bodyFile !== undefined,
        input.block === true,
        input.mapDir !== undefined,
    ].filter(Boolean);
    if (chosen.length !== 1) {
        return {
            error: "pick exactly one action: --replace <from=>to>, --body-file <file>, --block, or --map-dir <dir>",
        };
    }

    if (input.mapDir !== undefined) {
        return { mode: { kind: "map-dir", dir: input.mapDir } };
    }

    if (input.bodyFile !== undefined) {
        return { mode: { kind: "body-file", path: input.bodyFile } };
    }

    if (input.block) {
        return { mode: { kind: "block" } };
    }

    try {
        return { mode: { kind: "replace", rules: input.replace.map(parseReplaceSpec) } };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/** --replace needs the response body; --body-file and --block answer before the network by default. */
/**
 * The carried map for a requested script. `carry` keys `index.json` by the full deployed URL, query included
 * (`/config.js?v=1` and `?v=2` are different files), so the exact URL minus its #fragment wins. Without an exact
 * hit, a query-less match is used only when exactly one carried URL has that path.
 */
export function carriedMapFor(carried: Map<string, string>, url: string): string | undefined {
    const exact = url.split("#")[0] ?? url;
    const hit = carried.get(exact);
    if (hit) {
        return hit;
    }

    const bare = exact.split("?")[0] ?? exact;
    const candidates = [...carried.keys()].filter((key) => (key.split("?")[0] ?? key) === bare);
    return candidates.length === 1 ? carried.get(candidates[0] as string) : undefined;
}

export function defaultStage(mode: InterceptMode): InterceptStage {
    return mode.kind === "replace" || mode.kind === "map-dir" ? "response" : "request";
}

export function stageProblem(mode: InterceptMode, stage: InterceptStage): string | null {
    if (mode.kind === "replace" && stage === "request") {
        return "--replace rewrites a response body, so it needs --stage response";
    }

    if (mode.kind === "map-dir" && stage === "request") {
        return "--map-dir adds a map to the real script, so it needs --stage response";
    }

    return null;
}

export type HoldOutcome = "timeout" | "interrupted" | "detached";

/**
 * Keeps the process (and so the CDP session and its overrides) alive until `seconds` pass, the signal aborts
 * (Ctrl-C), or the target goes away. Never rejects.
 */
export function holdSession(options: { seconds?: number; signal: AbortSignal; cdp?: CdpLike }): Promise<HoldOutcome> {
    const { seconds, signal, cdp } = options;
    if (signal.aborted) {
        return Promise.resolve("interrupted");
    }

    return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: HoldOutcome): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            cdp?.off("Inspector.detached", onDetached);
            cdp?.off("Inspector.targetCrashed", onDetached);
            resolve(outcome);
        };
        const onAbort = (): void => finish("interrupted");
        const onDetached = (): void => finish("detached");
        signal.addEventListener("abort", onAbort, { once: true });
        cdp?.on("Inspector.detached", onDetached);
        cdp?.on("Inspector.targetCrashed", onDetached);
        if (seconds !== undefined) {
            timer = setTimeout(() => finish("timeout"), seconds * 1000);
        }
    });
}
