/**
 * `scaffold` — create a CDP scratch script INTO the `tools scripts` store, so
 * it is versioned, listable and runnable there (`tools scripts run <name>`).
 * Bindings-free: the templates import the cdp lib via the `@gt/chrome-devtools/*`
 * tsconfig mapping that the store scaffold writes (see src/scripts/lib/store.ts).
 */
import { chmod, mkdir } from "node:fs/promises";
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
 * Run: tools scripts run <name> -- --port 9222 [--match <url-substr>]
 * 9222 is a placeholder — \`tools chrome-devtools attach\` lists the live ports.
 * The cdp lib resolves via the store tsconfig's @gt/chrome-devtools/* mapping.
 */
import { ${imports} } from "@gt/chrome-devtools/cdp";

const arg = (flag: string, fallback?: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("--port", "9222"));
`;

export const RECIPES: Recipe[] = [
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

    return { file, runHint: `tools scripts run ${opts.name} -- --port 9222` };
}
