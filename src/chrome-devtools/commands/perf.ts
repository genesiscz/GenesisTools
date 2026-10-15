/** perf load / perf record / perf ab — main-thread cost measured with in-page observers, not a DevTools trace. */
import { type AbResult, type AbSample, runAb } from "@genesiscz/utils/chrome-devtools/ab";
import type { CdpLike } from "@genesiscz/utils/chrome-devtools/cdp-like";
import {
    isNetworkPreset,
    NETWORK_PRESET_NAMES,
    type NetworkPreset,
    resetEmulation,
    setCpuThrottle,
    setNetwork,
} from "@genesiscz/utils/chrome-devtools/emulate";
import { evaluateExpression, type InitScript } from "@genesiscz/utils/chrome-devtools/evaluate";
import { type InterceptHandle, rewriteResponses } from "@genesiscz/utils/chrome-devtools/intercept";
import {
    collectPerf,
    installPerf,
    type LoadSample,
    measureLoad,
    type PerfMark,
    type PerfSnapshot,
    resetPerfMarks,
} from "@genesiscz/utils/chrome-devtools/perf";
import { clearStorageBeforeLoad, deleteCookies } from "@genesiscz/utils/chrome-devtools/storage";
import {
    type Distribution,
    distribution,
    type PerfSummary,
    summarizePerf,
} from "@genesiscz/utils/chrome-devtools/summaries";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import type { Page } from "../lib/cdp.ts";
import { cdpLikeOf } from "../lib/cdp-like-adapter.ts";
import {
    type AbSpec,
    type AbSpecVariant,
    applyVariantRewrites,
    type CompiledRewrite,
    collect,
    compileVariantRewrites,
    describeNetwork,
    formatMetric,
    holdSession,
    orderMetricKeys,
    parseAbSpec,
    parseMarkSpec,
    perfMetrics,
    rewriteGlobs,
} from "../lib/perf-cli.ts";
import { artifactPath } from "../lib/platform.ts";
import { attachTab, positiveNumber, suggest, TOOL_CMD, withPage } from "./shared.ts";

const { log } = logger.scoped("chrome-devtools:perf");

export interface EmulationFlags {
    cpu?: string;
    network?: string | boolean;
}

export interface EmulationPlan {
    cpu: number;
    network: NetworkPreset | null;
}

/** `--cpu <rate>`: a slowdown factor of 1 or more; exits with guidance otherwise. */
export function cpuRate(raw: string | undefined): number {
    const rate = positiveNumber(raw, 1, "--cpu");
    if (rate < 1) {
        out.log.error(`--cpu is a slowdown factor of 1 or more (4 = DevTools "4x slowdown"), got '${raw}'.`);
        process.exit(1);
    }

    return rate;
}

/** --cpu and --network of a verb. Null when --network was bare or unknown: guidance is printed and exit code set. */
export async function emulationPlan(opts: EmulationFlags, subcommand: string[]): Promise<EmulationPlan | null> {
    const cpu = cpuRate(opts.cpu);
    if (opts.network === undefined) {
        return { cpu, network: null };
    }

    const network = await pickEnumFlag({
        tool: `${TOOL_CMD} ${subcommand.join(" ")}`,
        subcommand,
        flag: "--network",
        given: opts.network,
        values: NETWORK_PRESET_NAMES,
        fallback: "none",
        accepts: isNetworkPreset,
    });
    return network === null ? null : { cpu, network };
}

export function withEmulationFlags(cmd: Command): Command {
    return cmd
        .option("--cpu <rate>", "CPU slowdown factor (1 = off, 4 = DevTools 4x)")
        .option("--network [preset]", `network preset: ${NETWORK_PRESET_NAMES.join(", ")}`);
}

/** Applies the plan; returns a line per active override (empty when nothing changed). */
export async function applyEmulation(cdp: CdpLike, plan: EmulationPlan): Promise<string[]> {
    const active: string[] = [];
    if (plan.cpu !== 1) {
        await setCpuThrottle(cdp, plan.cpu);
        active.push(`CPU ${plan.cpu}x slowdown`);
    }

    if (plan.network) {
        const conditions = await setNetwork(cdp, plan.network);
        active.push(`network ${plan.network} (${describeNetwork(conditions)})`);
    }

    return active;
}

/** CPU back to 1x, no network shaping. A gone tab is fine: the overrides die with the session anyway. */
export async function restoreEmulation(cdp: CdpLike): Promise<void> {
    try {
        await resetEmulation(cdp);
    } catch (err) {
        log.debug({ err }, "emulation reset failed; the session ends with this process anyway");
    }
}

function parseMarks(specs: string[], example: string[]): PerfMark[] {
    try {
        return specs.map(parseMarkSpec);
    } catch (err) {
        out.log.error(err instanceof Error ? err.message : String(err));
        out.log.info(`  e.g. ${suggest(example)}`);
        process.exit(1);
    }
}

function positiveInt(raw: string | undefined, fallback: number, flag: string): number {
    const value = positiveNumber(raw, fallback, flag);
    if (!Number.isInteger(value)) {
        out.log.error(`${flag} must be a whole number, got '${raw}'.`);
        process.exit(1);
    }

    return value;
}

function ms(value: number): string {
    return `${Math.round(value)} ms`;
}

/** The ready-to-run source-map lookup for the longest frame that names a script position, or null. */
function sourceHint(summaries: PerfSummary[]): string | null {
    const frames = summaries.flatMap((summary) => summary.worst).filter((frame) => frame.source !== null);
    const worst = frames.sort((a, b) => b.duration - a.duration)[0];
    if (!worst?.source) {
        return null;
    }

    // The worst frame overall may have no script, so name the frame this lookup is for.
    return `which source line (longest frame with a script: ${ms(worst.duration)} ${worst.kind}): ${toolCommand("ts", "sourcemaps", "resolve", `${worst.source.url}:${worst.source.offset}`)} (add --build <dir> when the site publishes no maps)`;
}

/** The compact per-run (or per-recording) block: blocking, worst frame, invokers, long tasks, CLS, lag, marks. */
export function summaryLines(summary: PerfSummary, marks: PerfMark[]): string[] {
    const lines: string[] = [];
    const frames = summary.frames;
    lines.push(
        `  blocking ${pc.bold(ms(frames.blockingMs))} · ${frames.frames} long frame(s), ${ms(frames.totalMs)} total, ${frames.over200} over 200 ms`
    );
    const worst = summary.worst[0];
    if (worst) {
        lines.push(
            `  worst ${pc.bold(ms(worst.duration))}  ${worst.kind}${worst.location ? `  ${pc.dim(worst.location)}` : `  (render ${ms(worst.renderMs)}, style+layout ${ms(worst.styleAndLayoutMs)})`}${worst.forcedLayoutMs > 0 ? `  (forced layout ${ms(worst.forcedLayoutMs)})` : ""}`
        );
    }

    if (summary.byInvoker.length > 0) {
        const groups = summary.byInvoker
            .slice(0, 3)
            .map((group) => `${group.kind} ${ms(group.totalMs)} ×${group.frames}`)
            .join(" · ");
        lines.push(`  by invoker  ${groups}`);
    }

    lines.push(
        `  long tasks ${summary.longtasks.count} (${ms(summary.longtasks.totalMs)}, worst ${ms(summary.longtasks.worstMs)}) · CLS ${summary.cls.toFixed(3)} · max lag ${ms(summary.maxLagMs)}${summary.hiddenMs > 0 ? " while visible" : ""}`
    );
    if (marks.length > 0) {
        const reached = marks
            .filter((mark) => summary.marks[mark.name] !== undefined)
            .map((mark) => `${mark.name} ${ms(summary.marks[mark.name] ?? 0)}`);
        const missed = marks.filter((mark) => summary.marks[mark.name] === undefined).map((mark) => mark.name);
        lines.push(
            `  marks  ${reached.join(" · ") || "none reached"}${missed.length ? pc.yellow(`  missed: ${missed.join(", ")}`) : ""}`
        );
    }

    for (const warning of summary.warnings) {
        lines.push(pc.yellow(`  ⚠ ${warning}`));
    }

    return lines;
}

function resourceLines(snapshot: PerfSnapshot): string[] {
    return snapshot.resources.map(
        (resource) =>
            `  resource ${truncateDisplay(resource.name.replace(/^[a-z]+:\/\/[^/]+/i, ""), 70)}  start ${ms(resource.start)}  ${ms(resource.duration)}  ${resource.transferSize} B`
    );
}

function distributionTable(title: string, subtitle: string, values: Array<Record<string, number>>): void {
    const keys = orderMetricKeys(values.flatMap((entry) => Object.keys(entry)));
    renderCliHeader(title, subtitle);
    const table = createBoxTable(["METRIC", "N", "P50", "P90", "MIN", "MAX"]);
    for (const key of keys) {
        const dist = distribution(
            values.map((entry) => entry[key]).filter((value): value is number => typeof value === "number")
        );
        table.push([
            key,
            String(dist.n),
            formatMetric(key, dist.p50),
            formatMetric(key, dist.p90),
            formatMetric(key, dist.min),
            formatMetric(key, dist.max),
        ]);
    }

    out.println(table.toString());
}

/** Closes the CDP socket (it would keep the process alive) and exits. */
export function closeAndExit(page: Page, code: number): never {
    page.close();
    process.exit(code);
}

interface LoadOptions extends EmulationFlags {
    port?: string;
    match?: string;
    runs?: string;
    wait?: string;
    until?: string;
    untilText?: string;
    mark: string[];
    resources: string[];
    json?: boolean;
    out?: string;
}

function registerLoad(perf: Command): void {
    withEmulationFlags(
        withPage(perf.command("load"))
            .description(
                "measure page load(s): long frames with the script that started them, long tasks, CLS, lag, marks"
            )
            .argument("[url]", "navigate here for every run (default: reload the picked tab)")
    )
        .option("--runs <n>", "how many loads", "1")
        .option("--wait <seconds>", "how long to observe after the load event", "10")
        .option("--until <selector>", "stop observing once this element exists")
        .option("--until-text <text>", "stop observing once this text shows (inside --until, or anywhere)")
        .option(
            "--mark <spec>",
            "name=selector[@text]: time until that element (with that text) appears; repeatable",
            collect,
            []
        )
        .option("--resources <substr>", "include resource timings whose URL contains this; repeatable", collect, [])
        .option("--json", "machine-readable result on stdout")
        .option("-o, --out <file>", "write every full sample (frames, scripts, shifts) as JSON")
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["perf", "load", "http://localhost:3000/", "--runs", "5", "--cpu", "4", "--mark", "'cases=[data-testid=cases]'"])}
  ${suggest(["perf", "load", "--match", "localhost:3000", "--until", "'[data-testid=cases]'", "--network", "slow-4g"])}
  ${suggest(["perf", "load", "https://app.example.com/", "--runs", "3", "-o", artifactPath("perf-load.json")])}

Use it to find what blocks the main thread while a page loads, and which script started it
(a 'worst' line names the invoker, e.g. TimerHandler:setTimeout, and the script position).
Observers are injected before the page's own scripts on every run. To compare two builds or
settings, use 'perf ab', which interleaves the runs.`
        )
        .action(async (url: string | undefined, opts: LoadOptions) => {
            const runs = positiveInt(opts.runs, 1, "--runs");
            const waitMs = positiveNumber(opts.wait, 10, "--wait") * 1000;
            const marks = parseMarks(opts.mark, ["perf", "load", "<url>", "--mark", "'cases=[data-testid=cases]'"]);
            const plan = await emulationPlan(opts, ["perf", "load"]);
            if (!plan) {
                return;
            }

            const until = opts.until || opts.untilText ? { selector: opts.until, text: opts.untilText } : undefined;
            const page = await attachTab(opts);
            const cdp = cdpLikeOf(page);
            const samples: LoadSample[] = [];
            if (!opts.match) {
                out.log.info("no --match given: acting on the most recently active tab");
            }

            let failure: string | undefined;
            try {
                await withInterrupt(async (signal) => {
                    const active = await applyEmulation(cdp, plan);
                    out.log.info(
                        `measuring ${url ?? `${page.target.url} (reload)`} · ${runs} run(s) · ${active.join(" · ") || "no throttling"}`
                    );
                    for (let index = 0; index < runs; index++) {
                        if (signal.aborted) {
                            out.log.warn(`interrupted after ${samples.length} of ${runs} run(s)`);
                            break;
                        }

                        const sample = await measureLoad(cdp, {
                            url,
                            waitMs,
                            until,
                            config: { marks },
                            resources: opts.resources,
                        });
                        samples.push(sample);
                        log.debug({ run: index + 1, loadEventMs: sample.loadEventMs }, "perf load run done");
                        if (!opts.json) {
                            const untilText = sample.until
                                ? sample.until.ok
                                    ? ` · until held at ${ms(sample.until.ms)} after load`
                                    : pc.yellow(` · until NOT reached within ${waitMs / 1000} s`)
                                : "";
                            out.println(
                                `${pc.cyan(`run ${index + 1}/${runs}`)}  load event ${ms(sample.loadEventMs)}${untilText}`
                            );
                            out.println(summaryLines(summarizePerf(sample.snapshot), marks).join("\n"));
                            const resources = resourceLines(sample.snapshot);
                            if (resources.length > 0) {
                                out.println(resources.join("\n"));
                            }
                        }
                    }
                });
            } catch (err) {
                failure = err instanceof Error ? err.message : String(err);
            } finally {
                await restoreEmulation(cdp);
            }

            if (failure) {
                out.log.error(`perf load failed after ${samples.length} run(s): ${failure}`);
            }

            const hint = opts.json ? null : sourceHint(samples.map((sample) => summarizePerf(sample.snapshot)));
            if (hint) {
                out.println(pc.dim(hint));
            }

            const perRun: Array<Record<string, number>> = samples.map((sample) => ({
                loadEventMs: sample.loadEventMs,
                ...perfMetrics(sample.snapshot),
            }));
            if (opts.out && samples.length > 0) {
                await Bun.write(
                    opts.out,
                    SafeJSON.stringify(
                        { url: url ?? page.target.url, cpu: plan.cpu, network: plan.network, samples },
                        null,
                        2
                    )
                );
                out.log.info(`full samples -> ${opts.out}`);
            }

            if (opts.json) {
                const keys = orderMetricKeys(perRun.flatMap((entry) => Object.keys(entry)));
                out.result({
                    url: url ?? page.target.url,
                    cpu: plan.cpu,
                    network: plan.network,
                    runs: samples.map((sample, index) => ({
                        loadEventMs: sample.loadEventMs,
                        until: sample.until,
                        metrics: perRun[index],
                        summary: summarizePerf(sample.snapshot),
                    })),
                    distribution: Object.fromEntries(
                        keys.map((key) => [
                            key,
                            distribution(
                                perRun
                                    .map((entry) => entry[key])
                                    .filter((value): value is number => typeof value === "number")
                            ),
                        ])
                    ),
                    error: failure,
                });
            } else if (samples.length > 1) {
                const conditions = [plan.cpu !== 1 ? `CPU ${plan.cpu}x` : "", plan.network ?? ""].filter(Boolean);
                distributionTable(
                    `perf load · ${samples.length} runs${conditions.length ? ` · ${conditions.join(" · ")}` : ""}`,
                    url ?? page.target.url,
                    perRun
                );
            }

            closeAndExit(page, failure ? 1 : 0);
        });
}

interface RecordOptions extends EmulationFlags {
    port?: string;
    match?: string;
    seconds?: string;
    mark: string[];
    json?: boolean;
    out?: string;
}

function registerRecordVerb(perf: Command): void {
    withEmulationFlags(
        withPage(perf.command("record")).description(
            "observe the CURRENT document while you interact: INP, slowest events, long frames, marks"
        )
    )
        .option("--seconds <n>", "how long to record (Ctrl-C stops early)", "20")
        .option(
            "--mark <spec>",
            "name=selector[@text]: time from the start until that element appears; repeatable",
            collect,
            []
        )
        .option("--json", "machine-readable result on stdout")
        .option("-o, --out <file>", "write the raw snapshot as JSON")
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["perf", "record", "--match", "localhost:3000", "--seconds", "30"])}
  ${suggest(["perf", "record", "--match", "localhost:3000", "--cpu", "4", "--mark", "'submenu=[role=menu]'"])}
  ${suggest(["perf", "record", "--match", "app.example.com", "--network", "fast-4g", "--json"])}

Use it to time an interaction (click to submenu, typing lag) in a page that is already open:
start it, use the page, then read INP and the slowest events. Nothing reloads. The throttling
holds only while this command runs.`
        )
        .action(async (opts: RecordOptions) => {
            const seconds = positiveNumber(opts.seconds, 20, "--seconds");
            const marks = parseMarks(opts.mark, ["perf", "record", "--mark", "'submenu=[role=menu]'"]);
            const plan = await emulationPlan(opts, ["perf", "record"]);
            if (!plan) {
                return;
            }

            const page = await attachTab(opts);
            const cdp = cdpLikeOf(page);
            let installed: InitScript | undefined;
            let snapshot: PerfSnapshot | undefined;
            let failure: string | undefined;
            let markBase = 0;
            try {
                const active = await applyEmulation(cdp, plan);
                installed = await installPerf(cdp, { marks }, { now: true });
                markBase = await resetPerfMarks(cdp, { marks, activeMs: seconds * 1000 + 10_000 });
                const origin = await evaluateExpression(cdp, "performance.timeOrigin");
                out.log.info(
                    `recording ${page.target.url} for up to ${seconds} s · ${active.join(" · ") || "no throttling"}`
                );
                out.log.info("interact with the page now; Ctrl-C stops early. Overrides end when this command exits.");
                const outcome = await withInterrupt((signal) => holdSession({ seconds, signal, cdp }));
                if (outcome === "detached") {
                    throw new Error("the tab went away during the recording");
                }

                const sameDocument = (await evaluateExpression(cdp, "performance.timeOrigin")) === origin;
                if (!sameDocument) {
                    out.log.warn("the tab loaded a new document while recording; this covers the new document only");
                }

                snapshot = await collectPerf(cdp, sameDocument ? { since: markBase } : {});
            } catch (err) {
                failure = err instanceof Error ? err.message : String(err);
            } finally {
                await installed?.remove().catch((err: unknown) => log.debug({ err }, "init script removal failed"));
                await restoreEmulation(cdp);
            }

            if (!snapshot) {
                out.log.error(`perf record failed: ${failure ?? "no snapshot"}`);
                closeAndExit(page, 1);
            }

            const summary = summarizePerf(snapshot);
            const slowest = [...snapshot.events].sort((a, b) => b.duration - a.duration).slice(0, 10);
            const interactions = new Set(snapshot.events.map((event) => event.interactionId).filter((id) => id > 0));
            if (opts.out) {
                await Bun.write(
                    opts.out,
                    SafeJSON.stringify({ cpu: plan.cpu, network: plan.network, snapshot }, null, 2)
                );
                out.log.info(`raw snapshot -> ${opts.out}`);
            }

            if (opts.json) {
                out.result({ cpu: plan.cpu, network: plan.network, summary, slowestEvents: slowest });
                closeAndExit(page, 0);
            }

            out.println(pc.cyan(`recorded ${snapshot.url}`));
            out.println(
                summary.inp === null
                    ? "  INP  no interactions recorded (click, tap or type in the page while it records)"
                    : `  INP ${pc.bold(ms(summary.inp))} over ${interactions.size} interaction(s)`
            );
            out.println(summaryLines(summary, marks).join("\n"));
            const hint = sourceHint([summary]);
            if (hint) {
                out.println(pc.dim(hint));
            }

            if (slowest.length > 0) {
                const table = createBoxTable(["EVENT", "DURATION", "INPUT DELAY", "PROCESSING", "TARGET", "AT"]);
                for (const event of slowest) {
                    table.push([
                        event.name,
                        ms(event.duration),
                        ms(event.inputDelay),
                        ms(event.processing),
                        truncateDisplay(event.target, 40),
                        `+${((event.start - markBase) / 1000).toFixed(1)} s`,
                    ]);
                }

                out.println(table.toString());
            }

            closeAndExit(page, 0);
        });
}

interface AbOptions {
    port?: string;
    match?: string;
    out: string;
    json?: boolean;
}

const AB_SPEC_EXAMPLE = `{
    "url": "http://localhost:3000/",
    "rounds": 4,
    "cpu": 4,
    "until": { "selector": "[data-testid=cases]" },
    "marks": [{ "name": "cases", "selector": "[data-testid=cases]" }],
    "clearStorage": { "sessionStorage": ["replaySession"] },
    "probe": "() => ({ replay: window.appConfig?.replay })",
    "variants": [
      { "name": "baseline" },
      { "name": "no-replay", "rewrite": [{ "url": "*/config.js*", "replace": [{ "from": "replay:true", "to": "replay:false" }] }] }
    ]
  }`;

/** A load sample plus what the spec's `probe` read from the page right after it. */
type AbLoadSample = LoadSample & { probe?: unknown; probeError?: string };

function probeText(sample: AbLoadSample | undefined): string | null {
    if (!sample || (sample.probe === undefined && !sample.probeError)) {
        return null;
    }

    return sample.probeError
        ? `probe failed: ${sample.probeError}`
        : `probe ${truncateDisplay(SafeJSON.stringify(sample.probe) ?? "undefined", 60)}`;
}

function abRunLine(sample: AbSample<AbLoadSample>, total: number, rewrites: number): string {
    const head = `${pc.cyan(`run ${sample.index + 1}/${total}`)}  ${sample.variant} r${sample.round}`;
    if (sample.error || !sample.metrics) {
        return `${head}  ${pc.red(`FAILED: ${sample.error ?? "no metrics"}`)}`;
    }

    const metrics = sample.metrics;
    const marks = Object.entries(metrics)
        .filter(([key]) => key.startsWith("mark:"))
        .map(([key, value]) => `${key.slice(5)} ${ms(value)}`);
    const until = sample.sample?.until;
    const parts = [
        `blocking ${ms(metrics.blockingMs ?? 0)}`,
        `frames ${ms(metrics.totalFrameMs ?? 0)}`,
        `worst ${ms(metrics.worstFrameMs ?? 0)}`,
        `>200 ${metrics.framesOver200 ?? 0}`,
        `lag ${ms(metrics.maxLagMs ?? 0)}`,
        `CLS ${(metrics.cls ?? 0).toFixed(3)}`,
        ...marks,
    ];
    if (until && !until.ok) {
        parts.push(pc.yellow("until NOT reached"));
    }

    const probe = probeText(sample.sample);
    if (probe) {
        parts.push(pc.magenta(probe));
    }

    return `${head}  ${parts.join(" · ")}  ${pc.dim(`(${(sample.wallMs / 1000).toFixed(1)} s, ${rewrites} replacement(s))`)}`;
}

function abSummaryTable(
    spec: AbSpec,
    summary: Array<{ variant: string; metrics: Record<string, Distribution> }>
): void {
    const keys = orderMetricKeys(summary.flatMap((entry) => Object.keys(entry.metrics)));
    const table = createBoxTable(["METRIC", "VARIANT", "N", "P50", "P90", "MIN", "MAX", "Δ P50"]);
    for (const key of keys) {
        const base = summary[0]?.metrics[key];
        summary.forEach((entry, index) => {
            const dist = entry.metrics[key];
            if (!dist) {
                table.push([index === 0 ? key : "", entry.variant, "0", "", "", "", "", ""]);
                return;
            }

            const delta =
                index === 0 || !base || base.n === 0
                    ? ""
                    : `${dist.p50 - base.p50 >= 0 ? "+" : ""}${formatMetric(key, dist.p50 - base.p50)}`;
            table.push([
                index === 0 ? key : "",
                entry.variant,
                String(dist.n),
                formatMetric(key, dist.p50),
                formatMetric(key, dist.p90),
                formatMetric(key, dist.min),
                formatMetric(key, dist.max),
                delta,
            ]);
        });
    }

    renderCliHeader(
        `perf ab · ${summary.length} variants × ${spec.rounds}`,
        `${spec.order} order${spec.cpu ? ` · CPU ${spec.cpu}x` : ""}${spec.network ? ` · ${spec.network}` : ""}`
    );
    out.println(table.toString());
}

function registerAb(perf: Command): void {
    withPage(perf.command("ab"))
        .description("interleaved A/B page loads from a JSON spec: per-variant p50/p90/min/max of every metric")
        .argument("<spec>", "JSON spec file (format below)")
        .option("-o, --out <file>", "every sample, rewritten after each run", artifactPath("perf-ab.json"))
        .option("--json", "machine-readable summary on stdout")
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["perf", "ab", artifactPath("ab.json"), "--match", "localhost:3000"])}
  ${suggest(["perf", "ab", artifactPath("ab.json"), "--match", "localhost:3000", "-o", artifactPath("ab-run.json")])}

Use it to decide whether a change (a library, a flag, a rewritten config) makes loads faster:
each variant runs 'rounds' times in ABBA order, so drift over time hits every variant alike.

Spec:
  ${AB_SPEC_EXAMPLE}
  Optional: order ("abba" | "same"), network (${NETWORK_PRESET_NAMES.join(", ")}), waitMs (default 10000),
  clearCookies (names; only the measured site's cookies), and per variant: url, cpu, network, rewrite.
  rewrite.url is a glob (* any run); replace.from is a regular expression, replace.to may use $1.

Attribution by sourceURL fails when a library is bundled into the app's chunks: the frames name
the chunk, not the library. Then the A/B diff IS the attribution: rewrite the library away in
one variant and compare.
State that survives a reload leaks between runs (a sessionStorage sampling flag, a cached
decision). Clear it with clearStorage (and clearCookies), or the first run decides for all.
A replacement count proves the rewrite matched, not that the app changed. Add "probe": a page
function run after every load (e.g. () => window.appConfig.replay); its value is printed and saved per
sample, so you can see each variant really ran as intended.
Ctrl-C stops after the current run and still prints the summary.`
        )
        .action(async (specPath: string, opts: AbOptions) => {
            const file = Bun.file(specPath);
            if (!(await file.exists())) {
                out.log.error(`spec file ${specPath} does not exist.`);
                out.log.info(`  see the format: ${suggest(["perf", "ab", "--help"])}`);
                process.exit(1);
            }

            let raw: unknown;
            try {
                raw = SafeJSON.parse(await file.text(), { strict: true });
            } catch (err) {
                out.log.error(
                    `spec file ${specPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
                );
                process.exit(1);
            }

            const parsed = parseAbSpec(raw);
            if (!parsed.ok) {
                out.log.error(
                    `spec file ${specPath} is invalid:\n${parsed.errors.map((line) => `  ${line}`).join("\n")}`
                );
                out.log.info(`  see the format: ${suggest(["perf", "ab", "--help"])}`);
                process.exit(1);
            }

            const spec = parsed.spec;
            const page = await attachTab(opts);
            const cdp = cdpLikeOf(page);
            const compiled = new Map(spec.variants.map((variant) => [variant.name, compileVariantRewrites(variant)]));
            const total = spec.variants.length * spec.rounds;
            let current: CompiledRewrite[] = [];
            let replacements = 0;
            let rewrite: InterceptHandle | undefined;
            let storageReset: InitScript | undefined;
            let failure: string | undefined;
            let result: AbResult<AbLoadSample> | undefined;
            try {
                await cdp.send("Page.enable");
                const globs = rewriteGlobs(spec);
                if (globs.length > 0) {
                    rewrite = await rewriteResponses(
                        cdp,
                        globs.map((glob) => ({
                            urlPattern: glob,
                            transform: (body, context) => {
                                const applied = applyVariantRewrites(current, context.url, body);
                                replacements += applied.replaced;
                                return applied.body;
                            },
                        }))
                    );
                }

                if (spec.clearStorage) {
                    // Only the measured app's documents: not a login provider or an embedded third-party frame.
                    const origins = [spec.url, ...spec.variants.map((variant) => variant.url)]
                        .filter((url): url is string => Boolean(url))
                        .map((url) => new URL(url).origin);
                    storageReset = await clearStorageBeforeLoad(cdp, {
                        ...spec.clearStorage,
                        origins: [...new Set(origins)],
                    });
                }

                out.log.info(
                    `${spec.variants.map((variant) => variant.name).join(" vs ")} on ${spec.url} · ${total} runs (${spec.order}) · samples -> ${opts.out}`
                );
                result = await withInterrupt(
                    (signal) =>
                        runAb<AbSpecVariant, AbLoadSample>({
                            variants: spec.variants.map((variant) => ({ name: variant.name, config: variant })),
                            rounds: spec.rounds,
                            order: spec.order,
                            signal,
                            async setup(run) {
                                const variant = run.variant.config;
                                current = compiled.get(run.variant.name) ?? [];
                                replacements = 0;
                                await setCpuThrottle(cdp, variant?.cpu ?? spec.cpu ?? 1);
                                await setNetwork(cdp, variant?.network ?? spec.network ?? "none");
                                if (spec.clearCookies?.length) {
                                    // Only the measured site's cookies: the same name on another site stays.
                                    const domain = new URL(variant?.url ?? spec.url).hostname;
                                    await deleteCookies(cdp, { names: spec.clearCookies, domain });
                                }
                            },
                            measure: async (run): Promise<AbLoadSample> => {
                                const loaded = await measureLoad(cdp, {
                                    url: run.variant.config?.url ?? spec.url,
                                    waitMs: spec.waitMs,
                                    until: spec.until,
                                    config: { marks: spec.marks },
                                });
                                if (!spec.probe) {
                                    return loaded;
                                }

                                // Proves the variant took effect in the app, not only that a rewrite matched.
                                try {
                                    const probe = await evaluateExpression(cdp, `(${spec.probe})()`, {
                                        timeoutMs: 5_000,
                                    });
                                    return { ...loaded, probe };
                                } catch (err) {
                                    return {
                                        ...loaded,
                                        probeError: (err instanceof Error ? err.message : String(err)).split("\n")[0],
                                    };
                                }
                            },
                            metrics: (sample) => perfMetrics(sample.snapshot),
                            async onSample(sample, all) {
                                await Bun.write(
                                    opts.out,
                                    SafeJSON.stringify({ spec, specPath, total, samples: all }, null, 2)
                                );
                                if (!opts.json) {
                                    out.println(abRunLine(sample, total, replacements));
                                }
                            },
                        }),
                    { onInterrupt: () => out.log.warn("Ctrl-C: stopping after the current run") }
                );
            } catch (err) {
                failure = err instanceof Error ? err.message : String(err);
            } finally {
                current = [];
                await rewrite?.stop().catch((err: unknown) => log.debug({ err }, "rewrite stop failed"));
                await storageReset
                    ?.remove()
                    .catch((err: unknown) => log.debug({ err }, "storage reset removal failed"));
                await restoreEmulation(cdp);
            }

            if (!result) {
                out.log.error(`perf ab failed: ${failure ?? "no result"}`);
                closeAndExit(page, 1);
            }

            const failed = result.samples.filter((sample) => sample.error).length;
            if (opts.json) {
                out.result({ out: opts.out, aborted: result.aborted, failed, summary: result.summary });
            } else {
                abSummaryTable(spec, result.summary);
                if (result.aborted) {
                    out.log.warn(`interrupted: ${result.samples.length} of ${total} runs done`);
                }

                if (failed > 0) {
                    out.log.warn(`${failed} run(s) failed; their errors are in ${opts.out}`);
                }

                out.log.info(`all samples -> ${opts.out}`);
            }

            closeAndExit(page, failed === result.samples.length && failed > 0 ? 1 : 0);
        });
}

export function registerPerf(program: Command): void {
    const perf = program
        .command("perf")
        .description(
            "main-thread cost from in-page observers (long animation frames with script attribution, lag, CLS, INP, marks); not a DevTools trace"
        )
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["perf", "load", "http://localhost:3000/", "--runs", "3", "--cpu", "4"])}
  ${suggest(["perf", "record", "--match", "localhost:3000", "--seconds", "30"])}
  ${suggest(["perf", "ab", artifactPath("ab.json"), "--match", "localhost:3000"])}

load measures page loads, record measures interactions in the open page, ab compares variants.
CPU and network throttling, the observers and response rewrites belong to this command's CDP
session: they end when the command exits.`
        );

    registerLoad(perf);
    registerRecordVerb(perf);
    registerAb(perf);
}
