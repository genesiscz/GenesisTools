#!/usr/bin/env bun
/**
 * Browser goal-loop benchmark with outcomes checked in code, never by Jev's own "done". Ported
 * from browser-use/jev-ultrafast `examples/flights.py` + `scripts/measure_flights.py` and
 * typesafe-computer-use's benchmark record: every result names the code it ran (SHA-256 of the
 * files that decide), the browser, and what each task cost.
 *
 * Runs a HEADLESS Chrome on a throwaway profile against fixture pages served on 127.0.0.1. It
 * spends real Jev requests (a few per task).
 *
 *   bun src/jev/scripts/browser-benchmark.ts                 # every task once
 *   bun src/jev/scripts/browser-benchmark.ts --runs 3 --task checkout --out /tmp/bench.json
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { browserVersion } from "@app/chrome-devtools/lib/cdp";
import { launchHeadlessChrome } from "@app/chrome-devtools/lib/headless";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { createBrowserSurface } from "../lib/loop/browser";
import { RunFolder } from "../lib/loop/record";
import { runGoalLoop } from "../lib/loop/run";

const SOURCES = [
    "src/chrome-devtools/lib/dom/in-page.ts",
    "src/chrome-devtools/lib/dom/page.ts",
    "src/jev/lib/loop/browser.ts",
    "src/jev/lib/loop/run.ts",
    "src/control/lib/decision/observe.ts",
    "src/control/lib/decision/decisions.ts",
];

const PAGES: Record<string, string> = {
    "/search":
        "<!doctype html><title>Shop search</title><h1>Shop</h1><form action='/results'><label for='q'>Search</label> <input id='q' name='q'> <button>Search</button></form><p><a href='/help'>Help</a></p>",
    "/checkout":
        "<!doctype html><title>Checkout</title><h1>Checkout</h1><form action='/done'><label for='ship'>Shipping</label> <select id='ship' name='ship'><option>Standard</option><option>Express</option><option>Pickup</option></select><p><input type='checkbox' id='terms' name='terms'><label for='terms'>I accept the terms</label></p><button>Continue</button> <a href='/cart'>Back to cart</a></form>",
    "/settings":
        "<!doctype html><title>Settings</title><h1>Settings</h1><nav><a href='/settings/general'>General</a> <a href='/settings/privacy'>Privacy</a> <a href='/settings/billing'>Billing</a></nav><p>Choose a section.</p>",
    "/settings/general":
        "<!doctype html><title>General settings</title><h1>General</h1><p>Language: English</p><a href='/settings'>All settings</a>",
    "/settings/privacy":
        "<!doctype html><title>Privacy settings</title><h1>Privacy</h1><form action='/saved'><p><input type='checkbox' id='trackers' name='trackers'><label for='trackers'>Block trackers</label></p><p><input type='checkbox' id='ads' name='ads'><label for='ads'>Personalised ads</label></p><button>Save</button></form><a href='/settings'>All settings</a>",
};

function dynamicPage(path: string, query: URLSearchParams): string {
    if (path === "/results") {
        return query.get("q")?.toLowerCase() === "kettle"
            ? "<!doctype html><title>Results for kettle</title><h1>Results</h1><ul><li><a href='/item/red-kettle'>Red Kettle</a></li><li><a href='/item/blue-kettle'>Blue Kettle</a></li><li><a href='/item/descaler'>Kettle descaler</a></li></ul>"
            : "<!doctype html><title>No results</title><p>No results.</p><a href='/search'>Search again</a>";
    }

    if (path.startsWith("/item/")) {
        const name = path.slice("/item/".length).replace(/-/g, " ");
        return `<!doctype html><title>${name}</title><h1>${name}</h1><button>Add to basket</button>`;
    }

    return `<!doctype html><title>${path}</title><p>Page ${path}.</p><p>Query ${query.toString()}</p>`;
}

function evidenceUrl(evidence: unknown): string | undefined {
    if (typeof evidence !== "object" || evidence === null || !("url" in evidence)) {
        return undefined;
    }

    return typeof evidence.url === "string" ? evidence.url : undefined;
}

interface Task {
    name: string;
    path: string;
    goal: string;
    inputs?: Record<string, string>;
    /** The outcome, checked from the final URL alone. */
    passed(url: URL): boolean;
}

const TASKS: Task[] = [
    {
        name: "search",
        path: "/search",
        goal: "Search the shop for kettle and open the Blue Kettle product page",
        inputs: { q: "kettle" },
        passed: (url) => url.pathname === "/item/blue-kettle",
    },
    {
        name: "checkout",
        path: "/checkout",
        goal: "Choose Express shipping, accept the terms and continue",
        passed: (url) =>
            url.pathname === "/done" && url.searchParams.get("ship") === "Express" && url.searchParams.has("terms"),
    },
    {
        name: "settings",
        path: "/settings",
        goal: "Open the Privacy settings, turn on Block trackers, leave personalised ads off, and save",
        passed: (url) => url.pathname === "/saved" && url.searchParams.has("trackers") && !url.searchParams.has("ads"),
    },
];

const { values } = parseArgs({
    options: {
        runs: { type: "string", default: "1" },
        task: { type: "string" },
        out: { type: "string" },
        "max-steps": { type: "string", default: "10" },
    },
});
const runs = Math.max(1, Number(values.runs) || 1);
const tasks = TASKS.filter((task) => values.task === undefined || task.name === values.task);
if (tasks.length === 0) {
    console.error(`No task named ${values.task}; tasks: ${TASKS.map((task) => task.name).join(", ")}`);
    process.exit(1);
}

const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
        const url = new URL(request.url);
        const body = PAGES[url.pathname] ?? dynamicPage(url.pathname, url.searchParams);
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
});
const base = `http://127.0.0.1:${server.port}`;
const chrome = await launchHeadlessChrome({ binary: process.env.CHROME });
const browserName = await browserVersion(chrome.port);
const evaluate = await createEvaluator({});
const runsRoot = mkdtempSync(join(tmpdir(), "jev-browser-bench-"));
const results: Array<Record<string, unknown>> = [];

try {
    for (let run = 0; run < runs; run++) {
        for (const task of tasks) {
            const surface = createBrowserSurface({
                port: chrome.port,
                url: `${base}${task.path}`,
                inputs: task.inputs,
            });
            const clock = new Stopwatch();
            const record = RunFolder.create({ goal: task.goal, surface: "browser", root: runsRoot });
            try {
                const outcome = await runGoalLoop({
                    goal: task.goal,
                    surface,
                    evaluate,
                    maxSteps: Number(values["max-steps"]),
                    record,
                });
                const wallMs = Math.round(clock.elapsedMs);
                const last = await surface.see();
                const finalUrl = new URL(evidenceUrl(last.evidence) ?? base);
                const passed = task.passed(finalUrl);
                results.push({
                    task: task.name,
                    run,
                    passed,
                    loop: `${outcome.status}:${outcome.reason}`,
                    steps: outcome.trace.length,
                    finalUrl: finalUrl.pathname + finalUrl.search,
                    wallMs,
                    jevCalls: outcome.calls.calls,
                    jevMs: outcome.calls.ms,
                    inputTokens: outcome.calls.inputTokens,
                    outputTokens: outcome.calls.outputTokens,
                    runDir: outcome.runDir,
                });
                console.log(
                    `${passed ? "PASS" : "FAIL"}  ${task.name} #${run}  ${outcome.status}:${outcome.reason}  ${outcome.trace.length} steps  ${wallMs} ms  jev ${outcome.calls.calls} calls ${outcome.calls.ms} ms  ${outcome.calls.inputTokens}/${outcome.calls.outputTokens} tokens  → ${finalUrl.pathname}${finalUrl.search}`
                );
            } catch (error) {
                // A provider refusal or a browser failure is a failed task with its reason, not a crash.
                const message = error instanceof Error ? error.message : String(error);
                results.push({
                    task: task.name,
                    run,
                    passed: false,
                    loop: "error",
                    error: message,
                    wallMs: Math.round(clock.elapsedMs),
                });
                console.log(`FAIL  ${task.name} #${run}  error: ${message}`);
            } finally {
                await surface.close();
            }
        }
    }
} finally {
    chrome.close();
    server.stop(true);
}

const walls = results.map((row) => Number(row.wallMs)).sort((a, b) => a - b);
const summary = {
    measuredAt: new Date().toISOString(),
    browser: browserName,
    sources: Object.fromEntries(
        SOURCES.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)])
    ),
    tasks: results.length,
    passed: results.filter((row) => row.passed).length,
    medianWallMs: walls[Math.floor(walls.length / 2)] ?? 0,
    jevCalls: results.reduce((total, row) => total + Number(row.jevCalls), 0),
    results,
};
const text = `${SafeJSON.stringify(summary, null, 2)}\n`;
if (values.out) {
    await Bun.write(values.out, text);
    console.log(`wrote ${values.out}`);
} else {
    console.log(text);
}

console.log(
    `${summary.passed}/${summary.tasks} passed, median ${summary.medianWallMs} ms, ${summary.jevCalls} Jev calls`
);
process.exit(summary.passed === summary.tasks ? 0 : 1);
