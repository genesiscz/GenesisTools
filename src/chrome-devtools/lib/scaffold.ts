/**
 * `scaffold` — create a CDP scratch script INTO the `tools scripts` store, so
 * it is versioned, listable and runnable there (`tools scripts run <name>`).
 * Bindings-free: the templates import the cdp lib via the `@gt/chrome-devtools/*`
 * tsconfig mapping that the store scaffold writes (see src/scripts/lib/store.ts).
 */
import { chmod, mkdir } from "node:fs/promises";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { inferProject, SCRIPT_NAME_RE, type ScriptEntry, scriptPaths, upsertEntry } from "../../scripts/lib/journal.ts";
import { commitStore, ensureStoreScaffold } from "../../scripts/lib/store.ts";

export interface Recipe {
    name: string;
    description: string;
    body: (scriptName: string) => string;
}

const HEADER = (what: string, imports = "attach") => `#!/usr/bin/env bun
/**
 * ${what}
 * Run: ${toolCommand("scripts run", "<name>", "--", "--port", "9222")} [--match <url-substr>]
 * 9222 is a placeholder — \`${toolCommand("chrome-devtools attach")}\` lists the live ports.
 * The cdp lib resolves via the store tsconfig's @gt/chrome-devtools/* mapping.
 */
import { ${imports} } from "@gt/chrome-devtools/cdp";

const arg = (flag: string, fallback?: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("--port", "9222"));
`;

/** Header for the perf recipes: our CDP client, the CdpLike adapter, and a cleanup that always runs. */
const PERF_HEADER = (what: string, utils: string[]) => `#!/usr/bin/env bun
/**
 * ${what}
 * Run: ${toolCommand("scripts run", "<name>", "--", "--port", "9222", "--match", "<url-substr>")}
 * 9222 is a placeholder — \`${toolCommand("chrome-devtools attach")}\` lists the live ports.
 * The libraries resolve via the store tsconfig (@gt/chrome-devtools/* and @gt/utils/*).
 * CPU/network overrides and init scripts belong to this script's CDP session: they end when it exits.
 */
import { attach } from "@gt/chrome-devtools/cdp";
import { cdpLikeOf } from "@gt/chrome-devtools/cdp-like-adapter";
${utils.join("\n")}

const arg = (flag: string, fallback?: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const args = (flag: string): string[] => process.argv.flatMap((value, i) => (process.argv[i - 1] === flag ? [value] : []));
const port = Number(arg("--port", "9222"));
const out = arg("--out");
const page = await attach({ port, url: arg("--match") });
const cdp = cdpLikeOf(page);
let cleaning = false;
const cleanup = async (): Promise<void> => {
    if (cleaning) {
        return;
    }
    cleaning = true;
    await resetEmulation(cdp).catch((error: unknown) => console.error("reset failed:", error));
    page.close();
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));
`;

export const RECIPES: Recipe[] = [
    {
        name: "perf-load",
        description: "measure page loads at several CPU rates: blocking by invoker, worst frames, marks, distributions",
        body: () => `${PERF_HEADER(
            "Measure page loads with init-script observers (LoAF, long tasks, CLS, lag), at several CPU rates.",
            [
                'import { resetEmulation, setCpuThrottle, setNetwork, isNetworkPreset } from "@gt/utils/chrome-devtools/emulate";',
                'import { measureLoad } from "@gt/utils/chrome-devtools/perf";',
                'import { distribution, summarizePerf } from "@gt/utils/chrome-devtools/summaries";',
            ]
        )}
// --url <url> (default: reload the tab) --rates 1,4,6 --runs 3 --wait 15 --network slow-4g
// --mark name=selector (repeatable; add @text to require text: cases=[data-testid=cases]@Requests)
const url = arg("--url");
const rates = (arg("--rates", "1,4") ?? "1").split(",").map(Number);
const runs = Number(arg("--runs", "3"));
const waitMs = Number(arg("--wait", "15")) * 1000;
const marks = args("--mark").map((spec) => {
    const [name, rest] = spec.split(/=(.*)/s);
    const [selector, text] = (rest ?? "").split("@");
    return { name, selector, text: text || undefined };
});
const network = arg("--network");
try {
    if (network) {
        if (!isNetworkPreset(network)) {
            throw new Error(\`--network must be a preset, got \${network}\`);
        }
        await setNetwork(cdp, network);
    }
    const all: Array<Record<string, unknown>> = [];
    for (const rate of rates) {
        await setCpuThrottle(cdp, rate);
        const blocking: number[] = [];
        for (let run = 1; run <= runs; run++) {
            const sample = await measureLoad(cdp, { url, waitMs, config: { marks } });
            const summary = summarizePerf(sample.snapshot);
            blocking.push(summary.frames.blockingMs);
            all.push({ rate, run, loadEventMs: sample.loadEventMs, summary, snapshot: sample.snapshot });
            console.log(
                \`\${rate}x run \${run}: blocking \${summary.frames.blockingMs} ms in \${summary.frames.frames} frames, worst \${summary.frames.worstMs} ms\`,
                summary.worst[0] ? \`(\${summary.worst[0].kind} \${summary.worst[0].location ?? ""})\` : "",
                \`marks \${JSON.stringify(summary.marks)}\`
            );
            for (const group of summary.byInvoker.slice(0, 3)) {
                console.log(\`    \${group.kind}: \${group.totalMs} ms in \${group.frames} frames  \${group.sources[0]?.location ?? ""}\`);
            }
            if (out) {
                await Bun.write(out, JSON.stringify(all, null, 1));
            }
        }
        console.log(\`\${rate}x blocking ms:\`, JSON.stringify(distribution(blocking)));
    }
} finally {
    await cleanup();
}
`,
    },
    {
        name: "perf-ab",
        description:
            "interleaved A/B of page loads: response rewrite per variant, per-run storage reset, distributions",
        body: () => `${PERF_HEADER(
            "A/B page loads in ABBA order. Edit VARIANTS: each one rewrites responses its own way.",
            [
                'import { runAb } from "@gt/utils/chrome-devtools/ab";',
                'import { resetEmulation, setCpuThrottle } from "@gt/utils/chrome-devtools/emulate";',
                'import { rewriteResponses } from "@gt/utils/chrome-devtools/intercept";',
                'import { measureLoad } from "@gt/utils/chrome-devtools/perf";',
                'import { clearStorageBeforeLoad } from "@gt/utils/chrome-devtools/storage";',
                'import { frameTotals } from "@gt/utils/chrome-devtools/summaries";',
            ]
        )}
// --url <url> (required) --rounds 3 --rate 6 --wait 20
// Attribution by sourceURL fails when a library is bundled into the app chunks: the A/B difference IS the attribution.
type Variant = { pattern: string; transform: (body: string) => string };
const VARIANTS: Array<{ name: string; config: Variant | null }> = [
    { name: "baseline", config: null },
    { name: "changed", config: { pattern: "*/config.js*", transform: (body) => body.replace(/FEATURE_FLAG:\\s*"[^"]*"/, 'FEATURE_FLAG: "false"') } },
];
// State that survives reloads leaks between variants; name it here so every run starts clean.
const RESET = { sessionStorage: [] as string[], localStorage: [] as string[] };
const url = arg("--url");
if (!url) {
    throw new Error("--url is required");
}
let current: Variant | null = null;
try {
    await setCpuThrottle(cdp, Number(arg("--rate", "6")));
    const reset = await clearStorageBeforeLoad(cdp, RESET);
    const patterns = [...new Set(VARIANTS.flatMap((variant) => (variant.config ? [variant.config.pattern] : [])))];
    const rewrite = await rewriteResponses(
        cdp,
        patterns.map((pattern) => ({
            urlPattern: pattern,
            transform: (body: string) => (current && current.pattern === pattern ? current.transform(body) : body),
        }))
    );
    const result = await runAb({
        variants: VARIANTS,
        rounds: Number(arg("--rounds", "3")),
        setup: (run) => {
            current = run.variant.config ?? null;
        },
        measure: () => measureLoad(cdp, { url, waitMs: Number(arg("--wait", "20")) * 1000 }),
        metrics: (sample) => {
            const totals = frameTotals(sample.snapshot.frames);
            return { blockingMs: totals.blockingMs, totalFrameMs: totals.totalMs, worstFrameMs: totals.worstMs };
        },
        onSample: async (sample, all) => {
            console.log(\`round \${sample.round} \${sample.variant}: \${JSON.stringify(sample.metrics ?? sample.error)}\`);
            if (out) {
                await Bun.write(out, JSON.stringify(all.map(({ sample: _s, ...rest }) => rest), null, 1));
            }
        },
    });
    for (const variant of result.summary) {
        console.log(variant.variant, JSON.stringify(variant.metrics.blockingMs), \`failed \${variant.failed}\`);
    }
    await rewrite.stop();
    await reset.remove();
} finally {
    await cleanup();
}
`,
    },
    {
        name: "spa-steps",
        description: "walk in-app routes without reloads (pushState) and measure each step's own frames and marks",
        body: () => `${PERF_HEADER(
            "Walk in-app routes without reloads; each step reads only its own frames (collectPerf since/drain).",
            [
                'import { resetEmulation, setCpuThrottle } from "@gt/utils/chrome-devtools/emulate";',
                'import { collectPerf, installPerf, resetPerfMarks } from "@gt/utils/chrome-devtools/perf";',
                'import { navigateSpa } from "@gt/utils/chrome-devtools/spa";',
                'import { summarizePerf } from "@gt/utils/chrome-devtools/summaries";',
            ]
        )}
// --route /path (repeatable, in order) --wait-for <selector> --settle 3 --rate 1
const routes = args("--route");
const waitFor = arg("--wait-for");
const settleMs = Number(arg("--settle", "3")) * 1000;
if (routes.length === 0) {
    throw new Error("give at least one --route /path");
}
try {
    await setCpuThrottle(cdp, Number(arg("--rate", "1")));
    const perf = await installPerf(cdp, {}, { now: true });
    const steps: Array<Record<string, unknown>> = [];
    for (const route of routes) {
        const t0 = await resetPerfMarks(cdp, { marks: waitFor ? [{ name: "ready", selector: waitFor }] : [] });
        const moved = await navigateSpa(cdp, { path: route, waitFor: waitFor ? { selector: waitFor } : undefined, timeoutMs: 15000 });
        await Bun.sleep(settleMs);
        const summary = summarizePerf(await collectPerf(cdp, { since: t0, drain: true }));
        steps.push({ route, moved, summary });
        console.log(
            \`\${route}: ready \${summary.marks.ready ?? "-"} ms, blocking \${summary.frames.blockingMs} ms, worst \${summary.frames.worstMs} ms\`,
            summary.worst[0] ? \`(\${summary.worst[0].kind} \${summary.worst[0].location ?? ""})\` : ""
        );
        if (out) {
            await Bun.write(out, JSON.stringify(steps, null, 1));
        }
    }
    await perf.remove();
} finally {
    await cleanup();
}
`,
    },
    {
        name: "interaction",
        description: "click a selector with a real mouse event and time it until another selector shows (INP-grade)",
        body: () => `${PERF_HEADER(
            "Click with a real (trusted) mouse event and time click -> visible, plus the event-timing INP.",
            [
                'import { resetEmulation, setCpuThrottle } from "@gt/utils/chrome-devtools/emulate";',
                'import { evaluateExpression } from "@gt/utils/chrome-devtools/evaluate";',
                'import { collectPerf, installPerf } from "@gt/utils/chrome-devtools/perf";',
                'import { waitForPage } from "@gt/utils/chrome-devtools/spa";',
                'import { distribution, summarizePerf } from "@gt/utils/chrome-devtools/summaries";',
            ]
        )}
// --click <selector> (required) --until <selector> (required) --close-key Escape --rates 1,4,6 --runs 5
const click = arg("--click");
const until = arg("--until");
if (!click || !until) {
    throw new Error("--click <selector> and --until <selector> are required");
}
const rates = (arg("--rates", "1,4") ?? "1").split(",").map(Number);
const runs = Number(arg("--runs", "5"));
const closeKey = arg("--close-key", "Escape") ?? "Escape";
try {
    await installPerf(cdp, {}, { now: true });
    for (const rate of rates) {
        await setCpuThrottle(cdp, rate);
        const times: number[] = [];
        for (let run = 1; run <= runs; run++) {
            const box = (await evaluateExpression(
                cdp,
                \`(() => { const r = document.querySelector(\${JSON.stringify(click)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, t: performance.now() } : null; })()\`
            )) as { x: number; y: number; t: number } | null;
            if (!box) {
                throw new Error(\`nothing matches --click \${click}\`);
            }
            for (const type of ["mousePressed", "mouseReleased"]) {
                await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
            }
            const shown = await waitForPage(cdp, { selector: until }, 15000);
            times.push(shown.ms);
            console.log(\`\${rate}x run \${run}: visible after \${shown.ok ? shown.ms : "timeout"} ms\`);
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: closeKey });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: closeKey });
            await Bun.sleep(500);
        }
        const summary = summarizePerf(await collectPerf(cdp, { drain: true }));
        console.log(\`\${rate}x click -> visible:\`, JSON.stringify(distribution(times)), \`INP \${summary.inp ?? "-"} ms\`);
    }
} finally {
    await cleanup();
}
`,
    },
    {
        name: "idb-dump",
        description: "dump the tab's IndexedDB (optionally one db/store/key) to a JSON file, read-only",
        body: () => `${PERF_HEADER(
            "Dump IndexedDB of the tab's origin to a file. Read-only: missing databases are never created.",
            [
                'import { resetEmulation } from "@gt/utils/chrome-devtools/emulate";',
                'import { dumpIndexedDb } from "@gt/utils/chrome-devtools/storage";',
            ]
        )}
// --db <name> --store <name> --key <key> --max-value-bytes <n> --out dump.json
try {
    const key = arg("--key");
    const dump = await dumpIndexedDb(cdp, {
        db: arg("--db"),
        store: arg("--store"),
        key: key !== undefined && /^\\d+$/.test(key) ? Number(key) : key,
        maxValueBytes: arg("--max-value-bytes") ? Number(arg("--max-value-bytes")) : undefined,
    });
    for (const database of dump.databases) {
        for (const store of database.stores) {
            console.log(\`\${database.name}/\${store.name}: \${store.count} rows, \${store.jsonBytes} bytes of JSON\`);
        }
    }
    if (dump.error) {
        console.error(dump.error);
    }
    await Bun.write(out ?? "idb-dump.json", JSON.stringify(dump));
    console.log(\`written: \${out ?? "idb-dump.json"} (the leveldb folder size on disk is NOT the data size)\`);
} finally {
    await cleanup();
}
`,
    },
    {
        name: "redirect-chain",
        description: "record the live redirect chain (status, from, Location) while you reproduce a flow",
        body: () => `${HEADER("Record the redirect chain of a flow — the data a flat request list hides.")}
const match = arg("--match");
const seconds = Number(arg("--seconds", "30"));
const page = await attach({ port, url: match });
console.error(\`attached to \${page.target.url} — reproduce the flow now (\${seconds}s)...\`);
const events = page.recordNetwork(match ? (u) => u.includes(match) : undefined);
await Bun.sleep(seconds * 1000);
for (const e of events) {
    if (e.kind === "redirect") {
        console.log(\`\${e.status} \${e.from}\\n    -> \${e.location}\`);
    }
    if (e.kind === "nav") {
        console.log(\`NAV \${e.url}\`);
    }
}
page.close();
`,
    },
    {
        name: "cookie-diff",
        description: "diff cookies between two browsers by (name, domain, path) — the session-poison finder",
        body: () => `${HEADER("Diff cookies between two CDP browsers: broken (--port) vs fresh (--port-b).", "browser")}
const portB = Number(arg("--port-b", "9223"));
const domain = arg("--domain") ?? "";
const key = (c: { name: string; domain: string; path: string }) => \`\${c.name}|\${c.domain}|\${c.path}\`;
const [a, b] = await Promise.all([browser(port), browser(portB)]);
const [A, B] = await Promise.all([a.cookies(domain), b.cookies(domain)]);
const mapB = new Map(B.map((c) => [key(c), c]));
for (const c of A) {
    if (!mapB.has(key(c))) {
        console.log(\`BROKEN-ONLY \${key(c)} httpOnly=\${c.httpOnly} len=\${c.value.length}\`);
    }
}
const names = new Map<string, number>();
for (const c of A) {
    names.set(c.name, (names.get(c.name) ?? 0) + 1);
}
for (const [n, count] of names) {
    if (count > 1) {
        console.log(\`DUPLICATE NAME: \${n}  <-- longer path is sent FIRST (RFC 6265); stale sessions win\`);
    }
}
a.close();
b.close();
`,
    },
    {
        name: "storage-snapshot",
        description: "dump localStorage/sessionStorage of a tab (spot per-attempt retry-key buildup)",
        body: () => `${HEADER("Snapshot local/sessionStorage of one tab.")}
const match = arg("--match");
const page = await attach({ port, url: match });
console.log(
    JSON.stringify(
        await page.evaluate(\`() => ({
            url: location.href,
            ls: Object.fromEntries(Object.entries(localStorage).map(([k, v]) => [k, String(v).slice(0, 120)])),
            ss: Object.fromEntries(Object.entries(sessionStorage).map(([k, v]) => [k, String(v).slice(0, 120)])),
        })\`),
        null,
        1,
    ),
);
page.close();
`,
    },
    {
        name: "body-fetch",
        description: "capture responses matching a URL and print their bodies",
        body: () => `${HEADER("Fetch response bodies for requests hitting --match while you reproduce.")}
const match = arg("--match") ?? "/api/";
const seconds = Number(arg("--seconds", "20"));
const page = await attach({ port });
const events = page.recordNetwork((u) => u.includes(match));
console.error(\`recording \${match} on \${page.target.url} for \${seconds}s — trigger the request now...\`);
await Bun.sleep(seconds * 1000);
for (const e of events) {
    if (e.kind === "response") {
        const body = await page.responseBody(String(e.requestId)).catch(() => null);
        console.log(\`\\n=== \${e.status} \${e.url}\`);
        console.log(String(body?.body ?? "<no body — navigated away?>").slice(0, 800));
    }
}
page.close();
`,
    },
    {
        name: "console-trap",
        description: "capture console messages and exceptions around an action (attaches first, so nothing is missed)",
        body: () => `${HEADER("Trap console output of a tab; --reload replays load-time messages.")}
const match = arg("--match");
const seconds = Number(arg("--seconds", "15"));
const page = await attach({ port, url: match });
const lines: string[] = [];
page.onConsole((level, text) => lines.push(\`[\${level}] \${text}\`));
if (process.argv.includes("--reload")) {
    await page.reload();
}
console.error(\`listening on \${page.target.url} for \${seconds}s...\`);
await Bun.sleep(seconds * 1000);
console.log(lines.length ? lines.join("\\n") : "<nothing logged in that window — try --reload>");
page.close();
`,
    },
    {
        name: "blank",
        description: "empty scratch script with the cdp lib imported and a target list to start from",
        body: () => `${HEADER("Blank CDP scratch script.", "attach, browser, targets")}
console.log(JSON.stringify(await targets(port), null, 1));
// const page = await attach({ port, url: "example.com" });
// const b = await browser(port);
`,
    },
];

export function recipeNames(): string[] {
    return RECIPES.map((r) => r.name);
}

export function recipeHelpLines(): string[] {
    return RECIPES.map((r) => `  ${r.name.padEnd(18)} ${r.description}`);
}

export function findRecipe(name: string): Recipe | undefined {
    return RECIPES.find((r) => r.name === name);
}

export interface ScaffoldResult {
    file: string;
    runHint: string;
}

export async function scaffoldRecipeScript(opts: { name: string; recipe: Recipe }): Promise<ScaffoldResult> {
    if (!SCRIPT_NAME_RE.test(opts.name)) {
        throw new Error(
            `Invalid script name '${opts.name}'. Use letters, digits, dash, underscore; start with a letter.`
        );
    }

    const { dir, file } = scriptPaths(opts.name);

    if (await Bun.file(file).exists()) {
        throw new Error(`${file} already exists. Pick another name, or edit it in place.`);
    }

    await ensureStoreScaffold();
    await mkdir(dir, { recursive: true });
    await Bun.write(file, opts.recipe.body(opts.name));
    await chmod(file, 0o755);

    const now = new Date().toISOString();
    const cwd = process.cwd();
    const entry: ScriptEntry = {
        name: opts.name,
        file,
        description: opts.recipe.description,
        imports: [],
        tools: [],
        servers: [],
        tags: ["chrome-devtools", opts.recipe.name],
        project: inferProject(cwd),
        createdFrom: cwd,
        createdAt: now,
        updatedAt: now,
        runs: 0,
    };
    await upsertEntry(entry);
    await commitStore(`feat: scaffold chrome-devtools ${opts.recipe.name} script ${opts.name}`);

    return { file, runHint: toolCommand("scripts run", opts.name, "--", "--port", "9222") };
}
