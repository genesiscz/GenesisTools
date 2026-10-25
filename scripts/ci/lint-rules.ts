#!/usr/bin/env bun
/**
 * Repo-specific lint rules, replacing six GritQL Biome plugins.
 *
 * WHY THIS EXISTS: the plugins were 90% of `biome check .`. Measured on this
 * machine, 4763 files: 1.0s with `plugins: []`, 9.8s with all six. On the
 * 4-core GitHub runner that stretched to ~171s against a 180s step timeout,
 * so CI flaked (run 32243392511 timed out; the retry took 174s).
 *
 * The cost is structural, not incidental. GritQL in Biome 2.x cannot match a
 * bare string literal — the metavariable must be bound by a containing
 * context — so four of the rules enumerate every binding context they care
 * about, including `$_($val)`, `$_($val, $_)`, `$_($_, $val)` and
 * `$_($_, $_, $val)`. Those patterns match EVERY call expression in the
 * codebase before the regex ever runs. Per-plugin cost, baseline subtracted:
 *
 *   no-hardcoded-tmp                   3234ms
 *   no-hardcoded-user-paths            3073ms
 *   no-homedir-genesis-tools           1921ms
 *   no-mock-module-prompts              838ms
 *   no-homedir-genesis-tools-template   563ms
 *   no-direct-prompt-backend            278ms
 *
 * The three worst are exactly the three that enumerate call arguments.
 *
 * The replacement uses @ast-grep/napi, already a dependency and already used
 * by src/indexer. Matching happens in Rust, and a literal is
 * found by KIND rather than by guessing at its parents, so the context
 * enumeration disappears along with its cost.
 *
 * Full measurements and the decision record live in the author's notes, out of repo.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { findInFiles, Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { SafeJSON } from "@genesiscz/utils/json";
import { TOOL_COMMAND_RATCHET } from "./tool-command-ratchet";
import { TRANSCRIPT_FORMAT_RATCHET } from "./transcript-format-ratchet";

export type Severity = "error" | "warn";

export interface Finding {
    file: string;
    line: number;
    column: number;
    rule: string;
    severity: Severity;
    message: string;
    text: string;
}

interface Rule {
    name: string;
    severity: Severity;
    message: string;
    /** Node kinds this rule inspects. Cheaper than walking the whole tree per rule. */
    kinds: string[];
    /**
     * The rule's own ast-grep matcher, for a rule that is not about string literals. Without one the rule rides the
     * shared literal walk, which visits only `string` and `template_string` nodes.
     */
    matcher?: NapiConfig;
    /** Given the node's source text (and the node, for a rule that needs its parent), does it violate? */
    test: (text: string, node: SgNode) => boolean;
    /** Files where the pattern is the implementation, not a violation. */
    allowedIn?: RegExp;
    /** The rule runs only on these files. */
    onlyIn?: RegExp;
    /** Single files still allowed while they are migrated (a ratchet: an entry only ever leaves). */
    allowedFiles?: ReadonlySet<string>;
}

function ruleApplies(rule: Rule, file: string): boolean {
    return (rule.onlyIn?.test(file) ?? true) && !rule.allowedIn?.test(file) && !rule.allowedFiles?.has(file);
}

/**
 * `/tmp` does not exist on Windows. The GritQL original matched the literal
 * SOURCE including quotes, hence the leading quote class; kept here so the
 * semantics stay recognisably the same rule.
 */
const HARDCODED_TMP = /^["'`]\/tmp\/.+/s;
const HARDCODED_USER_PATH = /^["'`]\/Users\/[^/]+\//s;
/** An entire storage segment, including a suffix, but not a similarly named folder or plist. */
const GENESIS_TOOLS_LITERAL = /^["'`]\.genesis-tools(?:[/\\]|["'`])/s;
const HAND_JOINED_GENESIS_TOOLS_TEMPLATE = /\$\{[^}]+\}[/\\]\.genesis-tools(?:[/\\]|`)/s;
const STORAGE_ROOT_ALLOWED = /(^|\/)(?:plugins\/|src\/utils\/storage\/root\.ts$)/;
const STORAGE_ROOT_RULE = {
    name: "no-hand-joined-genesis-tools",
    severity: "error" as const,
    message:
        "Construct storage paths with genesisToolsDir/toolDataDir from @genesiscz/utils/storage/root. " +
        "Use genesisToolsDirIn for an explicit fixture or sandbox home.",
};

function recordHandJoinedStorage(
    nodes: SgNode[],
    filenameOf: (node: SgNode) => string,
    record: (node: SgNode, rule: typeof STORAGE_ROOT_RULE) => void
): void {
    for (const node of nodes) {
        if (STORAGE_ROOT_ALLOWED.test(filenameOf(node))) {
            continue;
        }

        const args = node.getMultipleMatches("ARGS");
        if (args.length > 1 && args.some((arg) => GENESIS_TOOLS_LITERAL.test(arg.text()))) {
            record(node, STORAGE_ROOT_RULE);
        }
    }
}

const LITERAL_KINDS = ["string", "template_string"];

/** A link to a GenesisTools app: on the browser router's host, or an app's own scheme. */
const GENESIS_ROUTER_LINK = /genesis\.tools\/|genesis-(?:md|tools):\/\//;

/** Every tool name: a `src/<name>/` folder or a `src/<name>.ts` file. */
function toolNames(): Set<string> {
    const names = new Set<string>();

    for (const entry of readdirSync(join(import.meta.dir, "..", "..", "src"), { withFileTypes: true })) {
        if (entry.isDirectory()) {
            names.add(entry.name);
        } else if (/\.tsx?$/.test(entry.name)) {
            names.add(entry.name.replace(/\.tsx?$/, ""));
        }
    }

    return names;
}

const TOOL_NAMES = toolNames();
const TOOL_MENTION = /(?:^|[^\w./-])tools ([a-z][a-z0-9-]*)/g;
const TOOL_COMMAND_CALLEES = new Set(["toolCommand", "suggestCommand"]);

/**
 * True for a literal that names a GenesisTools command: `tools <tool>` written out, where `<tool>` is a real tool (so
 * prose such as "the tools are" passes), or the first argument of `toolCommand(…)`. Comments are not literals.
 */
export function namesToolCommand(text: string, node: SgNode): boolean {
    for (const match of text.matchAll(TOOL_MENTION)) {
        if (TOOL_NAMES.has(match[1])) {
            return true;
        }
    }

    const args = node.parent();
    const callee = args?.kind() === "arguments" ? args.parent()?.field("function")?.text() : undefined;
    const first = args?.children().find((child) => child.isNamed());

    return (
        callee !== undefined &&
        TOOL_COMMAND_CALLEES.has(callee) &&
        first !== undefined &&
        first.range().start.index === node.range().start.index
    );
}

/** `import.meta` members only Bun sets; Vite's SSR runner and Node leave them undefined. */
const BUN_ONLY_IMPORT_META = /^import\.meta\.(?:dir|dirname|filename|path)$/;
/** Code a Vite dashboard can load server-side: the shared utils and the dashboards' own sources. */
const SSR_REACHABLE =
    /(?:^|\/)src\/(?:utils\/|[^/]+\/ui\/|dashboard\/|claude-history-dashboard\/|debugging-master\/dashboard\/)/;
/**
 * Files under src/utils that still call a bare `require()`, each inside a function (a lazy load), counted 2026-10-22
 * when lint-rules `no-bare-require-in-utils` was added. A ratchet: no file joins, and lint-rules.test.ts fails when a
 * listed file no longer calls it.
 */
export const BARE_REQUIRE_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/utils/ai/local/runtimes/sherpa/diarize.ts",
    "src/utils/browser-router/link-gate.ts",
    "src/utils/date.ts",
    "src/utils/search/drivers/sqlite-fts5/index.ts",
    "src/utils/search/stores/sqlite-vec-loader.ts",
    "src/utils/tokens.ts",
]);

/**
 * A literal that names a coding agent's transcript format: a Claude, Codex or Grok record type or field, or a raw-line
 * probe such as `'"type":"user"'`. That knowledge belongs to the provider readers (.claude/rules/agent-transcripts.md).
 */
const TRANSCRIPT_FORMAT =
    /^["'`](?:continued-in|continuedInSessionId|response_item|event_msg|session_meta|turn_context|compact_boundary|isCompactSummary|isSidechain|chat_history\.jsonl)["'`]$|\\?"(?:type|subtype)\\?"\s*:\s*\\?"(?:user|assistant|continued-in|response_item|event_msg|session_meta|turn_context|compact_boundary)\\?"/;
/** The readers own the format; the Claude SDK message types describe it; plugins are standalone; benchmarks replay it. */
const TRANSCRIPT_FORMAT_ALLOWED =
    /^(?:src\/utils\/agent-sessions\/|src\/utils\/claude\/types\.ts$|plugins\/|scripts\/benchmarks\/)/;

export function namesTranscriptFormat(text: string): boolean {
    return TRANSCRIPT_FORMAT.test(text);
}

const RULES: Rule[] = [
    {
        ...STORAGE_ROOT_RULE,
        kinds: LITERAL_KINDS,
        test: (text) => text.startsWith("`") && HAND_JOINED_GENESIS_TOOLS_TEMPLATE.test(text),
        allowedIn: STORAGE_ROOT_ALLOWED,
    },
    {
        name: "no-hardcoded-tmp",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "Hardcoded `/tmp/...` is not Windows-portable. Use `join(tmpdir(), '...')` from node:os + node:path. " +
            "PR #179 t2/t3/t4/t13.",
        test: (text) => HARDCODED_TMP.test(text),
    },
    {
        name: "no-hardcoded-user-paths",
        severity: "warn",
        kinds: LITERAL_KINDS,
        message:
            "Hardcoded user-specific path. Use `homedir()` from node:os, `process.env.HOME`, or resolve relative " +
            "to the repo/project root.",
        test: (text) => HARDCODED_USER_PATH.test(text),
    },
    {
        name: "no-raw-genesis-link",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "A genesis.tools link opens something only when GenesisTools.app is installed, is the https handler and " +
            "routes that preset, and a link on the genesis-md or genesis-tools scheme only when its app is installed. Build it " +
            "with `routerLink()` from @genesiscz/utils/browser-router/router-link (or `schemeLink()` from " +
            "@genesiscz/utils/app-links/targets to open it): the " +
            "preset builds the link, and the caller gets its fallback with the reason instead of a dead link.",
        test: (text) => GENESIS_ROUTER_LINK.test(text),
        allowedIn: /(^|\/)src\/utils\/(browser-router|app-links)\//,
    },
    {
        name: "no-tool-command-in-utils",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "A module under src/utils names no `tools …` command: another repo copies these modules, and there " +
            "`toolCommand()` names its own binary. Add a function to src/utils/genesis-tools/tools/hints.ts and have " +
            "the GenesisTools caller pass its result into the util as an option; a util without the option prints " +
            "no hint. scripts/ci/tool-command-ratchet.ts lists the files not migrated yet.",
        test: namesToolCommand,
        onlyIn: /(^|\/)src\/utils\//,
        allowedIn: /(^|\/)src\/utils\/genesis-tools\/tools\/hints\.ts$/,
        allowedFiles: TOOL_COMMAND_RATCHET,
    },
    {
        name: "no-bun-only-import-meta",
        severity: "error",
        kinds: ["member_expression"],
        matcher: { rule: { kind: "member_expression", regex: "^import\\.meta\\.(?:dir|dirname|filename|path)$" } },
        message:
            "`import.meta.dir`, `.dirname`, `.filename` and `.path` exist only in Bun. Vite's SSR runner loads these " +
            "modules into every dashboard without them, and a module-level use broke `tools clarity ui` with a 500 " +
            "(2026-10-22). Use `moduleDir(import.meta)` or `requireSibling(import.meta, name)` from " +
            "@genesiscz/utils/fs/module-dir.",
        test: (text) => BUN_ONLY_IMPORT_META.test(text),
        onlyIn: SSR_REACHABLE,
        allowedIn: /(?:^|\/)src\/utils\/fs\/module-dir\.ts$|\.test\.tsx?$|(?:^|\/)vite\.config\.ts$/,
    },
    {
        name: "no-bare-require-in-utils",
        severity: "error",
        kinds: ["call_expression"],
        matcher: { rule: { kind: "call_expression", has: { field: "function", regex: "^require$" } } },
        message:
            "A bare `require()` throws a ReferenceError under Vite's SSR runner, which has no `require`. Use a static " +
            "import, or `requireSibling(import.meta, name)` / `createRequire(import.meta.url)` for a lazy load. " +
            "BARE_REQUIRE_RATCHET lists the files not migrated yet.",
        test: (_text, node) => node.field("function")?.text() === "require",
        onlyIn: /(?:^|\/)src\/utils\//,
        allowedIn: /\.test\.tsx?$|(?:^|\/)src\/utils\/test\//,
        allowedFiles: BARE_REQUIRE_RATCHET,
    },
    {
        name: "no-transcript-format-outside-readers",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "A transcript record type or field (Claude, Codex or Grok) outside the provider readers. Read the fact " +
            "through a NativeSessionReader member (src/utils/agent-sessions/types.ts), and add a required member for " +
            "all three readers when none exists (.claude/rules/agent-transcripts.md). " +
            "scripts/ci/transcript-format-ratchet.ts lists the files not migrated yet.",
        test: (text) => namesTranscriptFormat(text),
        allowedIn: TRANSCRIPT_FORMAT_ALLOWED,
        allowedFiles: TRANSCRIPT_FORMAT_RATCHET,
    },
];

const PROMPT_BACKEND_RULE = {
    name: "no-direct-prompt-backend",
    severity: "error" as const,
    message:
        "Direct prompt-backend call. Use `p.X(...)` facade from `@genesiscz/utils/prompts/p` + " +
        "`p.setBackend(inquirerBackend)` once at the tool's entrypoint. PR #179 t5-t8.",
};

const MOCK_MODULE_RULE = {
    name: "no-mock-module-prompts",
    severity: "error" as const,
    message:
        "Don't mock prompt modules with mock.module — it leaks across test files via worker-pool " +
        "reuse. Use `installPromptMock(yourBackend)` from `@genesiscz/utils/testing/prompt-mock`. " +
        "See commit c4230745a.",
};

const PROMPT_BACKENDS = new Set(["inquirerBackend", "clackBackend", "opentuiBackend"]);
const PROMPT_METHODS = new Set([
    "text",
    "confirm",
    "typedConfirm",
    "select",
    "multiselect",
    "password",
    "search",
    "editor",
    "number",
]);
/** Prompt modules that must not be replaced with `mock.module` — the mock leaks across test files. */
const MOCKED_PROMPT_MODULE =
    /^["'`]@(?:app|genesiscz)\/utils\/prompts\/p(?:\/(?:inquirer|clack|opentui)-backend)?["'`]$|^["'`]inquirer\/prompts["'`]$/;

/**
 * Test-only rule. The bun test preload gives every test process its own temp
 * root by setting TMPDIR on process.env (src/utils/bun/preload-test-tmpdir.ts),
 * but Bun does not forward a MUTATED process.env to a child spawned without an
 * explicit `env` — measured 2026-09-07 on bun 1.3.13 for Bun.spawn, Bun.spawnSync
 * and node:child_process alike: the child still sees the TMPDIR the parent was
 * started with. Such a child writes its fixtures into the real temp folder, which
 * is how that folder reached 33,694 entries and 3.2 GB the same day.
 */
const SPAWN_ENV_RULE = {
    name: "test-spawn-needs-env",
    severity: "error" as const,
    message:
        "A test that spawns a child must pass `env` (`env: process.env`, or `{ ...process.env, X: … }`). Bun does " +
        "not forward the test temp root (TMPDIR, set on process.env by the bun test preload) to a child spawned " +
        "without it, so the child writes into the real temp folder.",
};

const BUN_SPAWN_CALLEES = new Set(["Bun.spawn", "Bun.spawnSync"]);
const CHILD_PROCESS_CALLEES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const CHILD_PROCESS_IMPORT = /["'](?:node:)?child_process["']/;
/**
 * The callee filter runs in Rust: a call_expression whose `function` field IS one
 * of the spawn names. A `$FN($$$ARGS)` pattern would hand every call in every
 * test file to JS first, which is the cost the header of this file is about.
 */
const SPAWN_CALL_MATCHER = {
    rule: {
        kind: "call_expression",
        has: {
            field: "function",
            regex: `^(?:${[...BUN_SPAWN_CALLEES, ...CHILD_PROCESS_CALLEES].map((name) => name.replace(".", "\\.")).join("|")})$`,
        },
    },
};
/** Argument kinds the rule can see through. Anything else may carry an env, so it passes. */
const TRANSPARENT_ARG_KINDS = new Set([
    "string",
    "template_string",
    "array",
    "object",
    "number",
    "true",
    "false",
    "null",
]);

/**
 * Busy-wait guards (2026-09-16 campaign). A `RunLoop.run` with no sources returned at once and
 * spun an app face at 60% for an hour; 48 pipeline workers polling every 250 ms cost 0.9% of a
 * core doing nothing; a 50 ms stat loop was the whole idle cost of `tools watch`; `sleepSync` in
 * `waitFor` froze the event loop for 1055 ms per wait. The three rules below catch those shapes.
 */
const SUB_100MS_INTERVAL_RULE = {
    name: "no-sub-100ms-interval",
    severity: "error" as const,
    message:
        "`setInterval` under 100 ms is a busy poll. Wake on the event instead (fs.watch behind a slow safety " +
        "poll: `watchFileFeed`, `waitForPath`, `FileTailer`), or " +
        "`// lint-rules-ignore: <why this must poll>`.",
};
const INTERVAL_FLOOR_MS = 100;
const INTERVAL_CALL_MATCHER = {
    rule: {
        kind: "call_expression",
        has: { field: "function", regex: "^(?:globalThis\\.|window\\.)?setInterval$" },
    },
};

const SYNC_POLL_LOOP_RULE = {
    name: "no-sync-poll-loop",
    severity: "error" as const,
    message:
        "`sleepSync` inside a loop freezes the event loop for the whole wait (1055 ms stalls measured in " +
        "`waitFor`). Use `await Bun.sleep(...)` in an async loop, wait on the event, or " +
        "`// lint-rules-ignore: <why this process may block>`.",
};
const LOOP_KINDS = ["while_statement", "do_statement", "for_statement", "for_in_statement"];
const SLEEP_SYNC_IN_LOOP_MATCHER = {
    rule: {
        kind: "call_expression",
        has: { field: "function", regex: "^(?:Bun\\.)?sleepSync$" },
        inside: { any: LOOP_KINDS.map((kind) => ({ kind })), stopBy: "end" as const },
    },
};

const SWIFT_WAIT_RULE = {
    name: "swift-wait-without-timeout",
    severity: "error" as const,
    message:
        "A bare `.wait()` blocks forever when the signal never comes (an ax-tool face hung at 60% CPU for an " +
        "hour on exactly this). Use `.wait(timeout:)` and handle `.timedOut`, or " +
        "`// lint-rules-ignore: <why it cannot hang>`.",
};
const SWIFT_BARE_WAIT = /\.wait\(\s*\)/;

/**
 * Process tools (2026-10-14). The process table, command lines, executables, listening sockets and working
 * directories come from the kernel through `@genesiscz/utils/process` (libproc on macOS), measured at 9.5 ms where
 * `lsof` cost 282 ms of CPU and at 38 ms where `ps` cost 567 ms (fb1a5f6da, d56c55667, 01ad30303). That layer owns
 * the `ps`/`lsof` fallbacks for Linux, Windows and a failed self-check; nothing outside it spawns them.
 */
const PROCESS_TOOL_SPAWN_RULE = {
    name: "no-process-tool-spawn",
    severity: "error" as const,
    message:
        "Spawning ps, lsof or pgrep costs tens to hundreds of ms of CPU per call. Read the kernel through " +
        "`@genesiscz/utils/process` (libproc-table, socket-owner, ps.ts), which owns the fallbacks, or " +
        "`// lint-rules-ignore: <why the kernel read does not fit>`.",
};
const PROCESS_TOOLS = new Set(["ps", "lsof", "pgrep"]);
/** The process layer that owns the fallbacks, and the benchmarks that measure the spawn against the kernel read. */
const PROCESS_TOOL_EXEMPT = /^(?:src\/utils\/process\/|scripts\/benchmarks\/)/;
/** Callees whose FIRST argument is the program name, with the arguments in a separate array. */
const PROGRAM_FIRST_CALLEES = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "capture", "captureSync"]);
/** Callees that take one command string, and Bun's shell tag. */
const COMMAND_STRING_CALLEES = new Set(["exec", "execSync", "$"]);
/**
 * Rust-side prefilter: a call whose arguments quote ps, lsof or pgrep anywhere, or a string that is the absolute path
 * of one (`"/bin/ps"`, `"/usr/sbin/lsof"`), which no prose comment can be. `spawnsProcessTool` decides.
 */
const PROCESS_TOOL_CALL_MATCHER = {
    rule: {
        any: [
            {
                kind: "call_expression",
                has: { field: "arguments", regex: "[\"'`]\\s*(?:(?:/usr)?/s?bin/)?(?:ps|lsof|pgrep)[\"'`\\s]" },
            },
            { kind: "string", regex: "^[\"'](?:/usr)?/s?bin/(?:ps|lsof|pgrep)[\"']$" },
        ],
    },
};

function unquote(node: SgNode): string {
    return node.text().slice(1, -1);
}

function isToolString(node: SgNode | null | undefined): boolean {
    return node?.kind() === "string" && PROCESS_TOOLS.has(unquote(node));
}

/** An explicit shell `-c` invocation whose command starts with a process tool. */
function shellRunsProcessTool(program: string, args: SgNode[]): boolean {
    if (!/^(?:.*\/)?(?:sh|bash|zsh|dash|ksh)$/.test(program)) {
        return false;
    }

    for (let index = 0; index + 1 < args.length; index++) {
        const flag = args[index];
        const command = args[index + 1];

        if (flag.kind() === "string" && /^-[a-z]*c[a-z]*$/.test(unquote(flag)) && command.kind() === "string") {
            const executable = unquote(command).trim().split(/\s+/)[0].split("/").pop() ?? "";
            return PROCESS_TOOLS.has(executable);
        }
    }

    return false;
}

/** An argv array that runs a process tool: `["ps", …]`, or behind `env`: `["env", "LC_ALL=C", "ps", …]`. */
function argvRunsProcessTool(array: SgNode, viaEnv = false): boolean {
    const items = array.namedChildren();
    let index = 0;

    if (!viaEnv && items[0]?.kind() === "string" && unquote(items[0]) === "env") {
        viaEnv = true;
        index = 1;
    }

    while (viaEnv && items[index]?.kind() === "string" && unquote(items[index]).includes("=")) {
        index++;
    }

    const program = items[index];
    return (
        isToolString(program) ||
        (program?.kind() === "string" && shellRunsProcessTool(unquote(program), items.slice(index + 1)))
    );
}

function spawnsProcessTool(node: SgNode): boolean {
    // An absolute path to a process tool is only ever there to run it, whatever the call around it.
    if (node.kind() === "string") {
        return true;
    }

    const args = node.field("arguments");

    if (!args) {
        return false;
    }

    const calleeText = node.field("function")?.text() ?? "";
    const callee = calleeText.split(".").pop() ?? "";
    const first = args.kind() === "template_string" ? args : args.namedChildren()[0];

    if (!first) {
        return false;
    }

    // `Bun.which("lsof")` resolves the program a later spawn runs through a variable.
    if (callee === "which") {
        return isToolString(first);
    }

    if (first.kind() === "array") {
        // A method's argv is its own program's (`this.run(["ps", …])` is `docker ps`); Bun.spawn's is the process.
        const spawnsArgv = !calleeText.includes(".") || calleeText.startsWith("Bun.");

        return spawnsArgv && argvRunsProcessTool(first);
    }

    // `Bun.spawn({ cmd: ["ps", …] })`.
    if (first.kind() === "object" && calleeText.startsWith("Bun.")) {
        const cmd = first
            .namedChildren()
            .find((pair) => pair.field("key")?.text() === "cmd")
            ?.field("value");
        return cmd?.kind() === "array" && argvRunsProcessTool(cmd);
    }

    const named = args.kind() === "template_string" ? [] : args.namedChildren();

    // A program name followed by its argv anywhere in the call: `probeRun("listeners", "lsof", [...])`, and through
    // env: `probeRun("processes", "env", ["LC_ALL=C", "ps", …])`.
    for (let index = 0; index + 1 < named.length; index++) {
        const program = named[index];
        const argv = named[index + 1];

        if (program.kind() !== "string" || argv.kind() !== "array") {
            continue;
        }

        if (
            PROCESS_TOOLS.has(unquote(program)) ||
            (unquote(program) === "env" && argvRunsProcessTool(argv, true)) ||
            shellRunsProcessTool(unquote(program), argv.namedChildren())
        ) {
            return true;
        }
    }

    if (first.kind() !== "string" && first.kind() !== "template_string") {
        return false;
    }

    const text = unquote(first);

    if (PROCESS_TOOLS.has(text)) {
        return PROGRAM_FIRST_CALLEES.has(callee);
    }

    return COMMAND_STRING_CALLEES.has(callee) && PROCESS_TOOLS.has(text.trim().split(/\s+/)[0].split("/").pop() ?? "");
}

function recordProcessToolSpawns(nodes: SgNode[], fileOf: (node: SgNode) => string, record: RecordFinding): void {
    // One finding per line: `Bun.which("lsof") ?? "/usr/sbin/lsof"` is one call site, not two.
    const seen = new Set<string>();

    for (const node of nodes) {
        const file = fileOf(node).replace(/\\/g, "/");
        const key = `${file}:${node.range().start.line}`;

        if (!PROCESS_TOOL_EXEMPT.test(file) && !seen.has(key) && spawnsProcessTool(node)) {
            seen.add(key);
            record(node, PROCESS_TOOL_SPAWN_RULE);
        }
    }
}

function parseNumberLiteral(text: string): number | null {
    const value = Number(text.replace(/_/g, ""));

    return Number.isFinite(value) ? value : null;
}

function unwrapToNumberOrIdentifier(
    node: SgNode
): { kind: "number"; value: number } | { kind: "identifier"; name: string } | null {
    let current: SgNode | undefined = node;

    for (let i = 0; i < 4 && current; i++) {
        const kind = current.kind();

        if (kind === "number") {
            const value = parseNumberLiteral(current.text());

            return value === null ? null : { kind: "number", value };
        }

        if (kind === "identifier") {
            return { kind: "identifier", name: current.text() };
        }

        // Computed delays (`60 * 60 * 1000`) are not judged. Walking into the
        // binary expression would treat the first operand as the delay.
        if (kind === "binary_expression" || kind === "call_expression" || kind === "member_expression") {
            return null;
        }

        const next: SgNode | undefined = current.namedChildren()[0];

        if (!next) {
            return null;
        }

        current = next;
    }

    return null;
}

function findNumericBinding(root: SgNode, name: string, depth = 0): number | null {
    if (depth > 4) {
        return null;
    }

    for (const decl of root.findAll({ rule: { kind: "variable_declarator" } })) {
        const boundName =
            decl.field("name")?.text() ??
            decl
                .children()
                .find((child) => child.isNamed())
                ?.text();
        if (boundName !== name) {
            continue;
        }

        const value = decl.field("value") ?? decl.children().filter((child) => child.isNamed())[1];

        if (!value) {
            return null;
        }

        const unwrapped = unwrapToNumberOrIdentifier(value);

        if (!unwrapped) {
            return null;
        }

        if (unwrapped.kind === "number") {
            return unwrapped.value;
        }

        return findNumericBinding(root, unwrapped.name, depth + 1);
    }

    return null;
}

/** Number-literal delay, or an identifier bound to one in this file. Computed delays are not judged. */
function intervalDelayMs(node: SgNode): number | null {
    const args = (node.field("arguments")?.children() ?? []).filter((child) => child.isNamed());
    const delay = args[1];

    if (!delay) {
        return null;
    }

    const unwrapped = unwrapToNumberOrIdentifier(delay);

    if (!unwrapped) {
        return null;
    }

    if (unwrapped.kind === "number") {
        return unwrapped.value;
    }

    return findNumericBinding(intervalAstRoot(node), unwrapped.name);
}

/** `node.getRoot()` is the file SgRoot; `.root()` is the program SgNode that has `findAll`. */
function intervalAstRoot(node: SgNode): SgNode {
    return node.getRoot().root();
}

function intervalViolates(node: SgNode): boolean {
    const delay = intervalDelayMs(node);

    return delay !== null && delay < INTERVAL_FLOOR_MS;
}

type RecordFinding = (node: SgNode, rule: { name: string; severity: Severity; message: string }) => void;

function recordIntervalFindings(nodes: SgNode[], record: RecordFinding): void {
    for (const node of nodes) {
        if (intervalViolates(node)) {
            record(node, SUB_100MS_INTERVAL_RULE);
        }
    }
}

function recordSleepSyncFindings(nodes: SgNode[], record: RecordFinding): void {
    for (const node of nodes) {
        record(node, SYNC_POLL_LOOP_RULE);
    }
}

function recordBusyWaitFindings(root: SgNode, record: RecordFinding): void {
    recordIntervalFindings(root.findAll(INTERVAL_CALL_MATCHER), record);
    recordSleepSyncFindings(root.findAll(SLEEP_SYNC_IN_LOOP_MATCHER), record);
}

/** Swift has no grammar in the ast-grep napi package, so its one rule is a line regex. */
export function checkSwiftSource(file: string, source: string): Finding[] {
    const lines = source.split("\n");
    const findings: Finding[] = [];

    for (const [index, text] of lines.entries()) {
        if (/^\s*\/\//.test(text) || isSuppressed(lines, index + 1)) {
            continue;
        }

        const column = text.search(SWIFT_BARE_WAIT);

        if (column === -1) {
            continue;
        }

        findings.push({
            file,
            line: index + 1,
            column: column + 1,
            rule: SWIFT_WAIT_RULE.name,
            severity: SWIFT_WAIT_RULE.severity,
            message: SWIFT_WAIT_RULE.message,
            text: text.trim().slice(0, 120),
        });
    }

    return findings;
}

/** Test files: the literal rules stay OFF here (see pluginsDisabledFor); the spawn rule runs ONLY here. */
export function isTestFile(file: string): boolean {
    return /\.test\.tsx?$/.test(file) || /(^|\/)__tests__\//.test(file);
}

/**
 * True when the call's arguments visibly or possibly carry an `env`: an object
 * literal with an `env` property (pair or shorthand) or a spread, or any argument
 * past the first that the rule cannot see into (a variable, a call, a member).
 * The first argument is the command and never counts as options.
 */
function spawnArgsCarryEnv(args: SgNode[]): boolean {
    return args.some((arg, index) => {
        const kind = arg.kind();

        if (kind === "object") {
            return arg.children().some((child) => {
                const childKind = child.kind();

                if (childKind === "pair") {
                    return child.field("key")?.text() === "env";
                }

                return (
                    (childKind === "shorthand_property_identifier" && child.text() === "env") ||
                    childKind === "spread_element"
                );
            });
        }

        return index > 0 && !TRANSPARENT_ARG_KINDS.has(String(kind));
    });
}

/**
 * Classify one call_expression the matcher let through. Returns whether it
 * violates, and whether that verdict still depends on the file importing
 * child_process (a bare `spawn(...)` can be anything until the import says otherwise).
 */
function spawnCallVerdict(node: SgNode): { violates: boolean; needsChildProcessImport: boolean } {
    const callee = node.field("function")?.text() ?? "";
    const isBun = BUN_SPAWN_CALLEES.has(callee);
    const isBare = CHILD_PROCESS_CALLEES.has(callee);

    if (!isBun && !isBare) {
        return { violates: false, needsChildProcessImport: false };
    }

    // The `arguments` node's named children are the arguments; the parens and commas are anonymous.
    const args = (node.field("arguments")?.children() ?? []).filter((child) => child.isNamed());

    return { violates: !spawnArgsCarryEnv(args), needsChildProcessImport: isBare };
}

function langFor(file: string): Lang | null {
    if (file.endsWith(".tsx") || file.endsWith(".jsx")) {
        return Lang.Tsx;
    }

    if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) {
        return Lang.TypeScript;
    }

    if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
        return Lang.JavaScript;
    }

    return null;
}

/**
 * Suppression: `// lint-rules-ignore: reason` on the line above, or trailing on
 * the same line.
 *
 * NOT `biome-ignore lint/plugin`, which is what the GritQL rules used. Once the
 * plugins are gone biome owns no `lint/plugin` rule, so every one of those
 * comments becomes a `suppressions/unused` error — biome reports a suppression
 * that suppresses nothing. This marker lives outside biome's namespace, so the
 * two never argue about it.
 */
const SUPPRESSION = /lint-rules-ignore\b/;

function isSuppressed(lines: string[], lineNumber: number): boolean {
    return SUPPRESSION.test(lines[lineNumber - 1] ?? "") || SUPPRESSION.test(lines[lineNumber - 2] ?? "");
}

/**
 * biome.json turns plugins OFF for these via an override (`"plugins": []`), so
 * the GritQL rules never ran on them. Honour that, or the replacement condemns
 * hundreds of lines the originals deliberately allowed — test files legitimately
 * hardcode `/tmp` paths and call prompt backends directly.
 */
export function pluginsDisabledFor(file: string): boolean {
    return /\.test\.tsx?$/.test(file) || /(^|\/)__tests__\//.test(file) || /\.data\.ts$/.test(file);
}

export function checkSource(file: string, source: string): Finding[] {
    if (file.endsWith(".swift")) {
        return checkSwiftSource(file, source);
    }

    const lang = langFor(file);

    if (lang === null) {
        return [];
    }

    const testFile = isTestFile(file);

    if (pluginsDisabledFor(file) && !testFile) {
        return [];
    }

    const root = parse(lang, source).root();
    const lines = source.split("\n");
    const findings: Finding[] = [];

    const record = (node: SgNode, rule: { name: string; severity: Severity; message: string }): void => {
        const { line, column } = node.range().start;
        const lineNumber = line + 1;

        if (isSuppressed(lines, lineNumber)) {
            return;
        }

        findings.push({
            file,
            line: lineNumber,
            column: column + 1,
            rule: rule.name,
            severity: rule.severity,
            message: rule.message,
            text: node.text().split("\n")[0].slice(0, 120),
        });
    };

    if (testFile) {
        // Test files get exactly one rule. The literal rules below stay off for them.
        const importsChildProcess = CHILD_PROCESS_IMPORT.test(source);

        for (const node of root.findAll(SPAWN_CALL_MATCHER)) {
            const verdict = spawnCallVerdict(node);

            if (verdict.violates && (!verdict.needsChildProcessImport || importsChildProcess)) {
                record(node, SPAWN_ENV_RULE);
            }
        }

        return findings;
    }

    // ONE walk for every literal rule. The GritQL version paid for a separate
    // whole-tree match per rule, which is most of why it cost 9 seconds.
    for (const node of root.findAll({ rule: { any: LITERAL_KINDS.map((kind) => ({ kind })) } })) {
        const text = node.text();

        for (const rule of RULES) {
            if (!rule.matcher && ruleApplies(rule, file) && rule.test(text, node)) {
                record(node, rule);
            }
        }
    }

    for (const rule of RULES) {
        if (!rule.matcher || !ruleApplies(rule, file)) {
            continue;
        }

        for (const node of root.findAll(rule.matcher)) {
            if (rule.test(node.text(), node)) {
                record(node, rule);
            }
        }
    }

    recordBusyWaitFindings(root, record);
    recordProcessToolSpawns(root.findAll(PROCESS_TOOL_CALL_MATCHER), () => file, record);

    recordHandJoinedStorage(root.findAll({ rule: { pattern: "$FN($$$ARGS)" } }), () => file, record);

    for (const node of root.findAll({ rule: { pattern: "$OBJ.$METHOD($$$ARGS)" } })) {
        const object = node.getMatch("OBJ")?.text();
        const method = node.getMatch("METHOD")?.text();

        if (object && method && PROMPT_BACKENDS.has(object) && PROMPT_METHODS.has(method)) {
            record(node, PROMPT_BACKEND_RULE);
            continue;
        }

        // `mock.module(...)` is a member call too, so it rides the same walk.
        if (object === "mock" && method === "module") {
            const specifier = node.getMultipleMatches("ARGS")[0]?.text();

            if (specifier && MOCKED_PROMPT_MODULE.test(specifier)) {
                record(node, MOCK_MODULE_RULE);
            }
        }
    }

    return findings;
}

/**
 * The file set Biome itself lints, read from `files.includes` in biome.json so
 * the two cannot drift. `git ls-files` supplies the candidates, which also
 * keeps ignored and untracked files out.
 */
/**
 * Restrict to files changed against `base`.
 *
 * Every rule here is per-file and syntactic: a literal is a violation or it is
 * not, regardless of what any other file does. So unlike a typecheck, scoping
 * to the diff cannot hide a violation the branch introduced. A push to the
 * default branch still runs the whole tree.
 */
function changedFiles(base: string): Set<string> | null {
    // Prefer the merge base, but fall back to diffing the ref directly. CI
    // checks out at depth 1 and fetches only the PR's base commit, so there is
    // no shared history for `merge-base` to walk — and GitHub's
    // `pull_request.base.sha` already IS the merge base.
    const merged = Bun.spawnSync(["git", "merge-base", base, "HEAD"]);
    const from = merged.exitCode === 0 ? merged.stdout.toString().trim() : base;
    const diff = Bun.spawnSync(["git", "diff", "--name-only", "-z", from, "HEAD"]);

    if (diff.exitCode !== 0) {
        // Every failure degrades to a full scan. A changed-file optimisation
        // that silently checks NOTHING is worse than a slow one.
        console.warn(`lint-rules: cannot diff against ${base}; scanning everything`);
        return null;
    }

    const changed = new Set(diff.stdout.toString().split("\0").filter(Boolean));
    const ruleInputs = new Set(["biome.json", "scripts/ci/lint-rules.ts", "scripts/ci/lint-changed.sh"]);
    if ([...changed].some((file) => ruleInputs.has(file))) {
        return null;
    }

    return changed;
}

async function targetFiles(): Promise<string[]> {
    const config = SafeJSON.parse(await Bun.file("biome.json").text()) as {
        files?: { includes?: string[] };
    };
    const excludes = (config.files?.includes ?? [])
        .filter((pattern) => pattern.startsWith("!"))
        .map((pattern) =>
            pattern
                .slice(1)
                .replace(/\/?\*\*$/, "")
                .replace(/\/$/, "")
        );

    // Must match every extension `langFor` can parse, or a tracked file with one
    // of the missing ones silently bypasses all six rules.
    const listed = Bun.spawnSync([
        "git",
        "ls-files",
        "-z",
        "*.ts",
        "*.tsx",
        "*.mts",
        "*.cts",
        "*.js",
        "*.jsx",
        "*.mjs",
        "*.cjs",
        "*.swift",
    ]);
    const files = listed.stdout.toString().split("\0").filter(Boolean);

    const included = files.filter(
        (file) => !excludes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
    );

    const changedIndex = process.argv.indexOf("--changed");

    if (changedIndex === -1) {
        return included;
    }

    const changed = changedFiles(process.argv[changedIndex + 1] ?? "origin/master");

    return changed === null ? included : included.filter((file) => changed.has(file));
}

function render(finding: Finding): string {
    const where = `${finding.file}:${finding.line}:${finding.column}`;
    return `${finding.severity === "error" ? "✖" : "▲"} ${where} ${finding.rule}\n    ${finding.message}\n    ${finding.text}`;
}

/**
 * Scan the whole file set through `findInFiles`, which parses and matches in
 * Rust worker threads.
 *
 * Reading and parsing each file from JS instead cost 3.1s locally and about 26s
 * on the 4-core CI runner, which was most of that step's budget. This does the
 * same work in ~0.4s because none of it happens on this thread. Only the files
 * that actually matched get read back here, and only to check for a suppression
 * comment.
 */
/** Every `no-process-tool-spawn` finding in `files`: the live list of call sites. */
/**
 * The process-tool rule alone. Only its pass runs: every pass parses each file again, and all of them took 13.5 s of
 * a 20 s test timeout on the CI runner (2026-10-15), where this one pass is a sixth of the work.
 */
export async function scanProcessToolSpawns(files: string[]): Promise<Finding[]> {
    return (await scanAll(files, { processToolOnly: true })).filter(
        (finding) => finding.rule === PROCESS_TOOL_SPAWN_RULE.name
    );
}

async function scanAll(files: string[], options: { processToolOnly?: boolean } = {}): Promise<Finding[]> {
    const byLang = new Map<Lang, string[]>();
    const testsByLang = new Map<Lang, string[]>();

    for (const file of files) {
        const lang = langFor(file);

        if (lang === null) {
            continue;
        }

        if (isTestFile(file)) {
            testsByLang.set(lang, [...(testsByLang.get(lang) ?? []), file]);
            continue;
        }

        if (pluginsDisabledFor(file)) {
            continue;
        }

        byLang.set(lang, [...(byLang.get(lang) ?? []), file]);
    }

    // Suppression is deliberately NOT applied here: it needs the source lines,
    // and reading every file back would put the cost straight back. Only the
    // files that matched get read, once, at the end.
    const unfiltered: Finding[] = [];
    /** Bare `spawn(...)` findings that still need the file's imports to confirm they are child_process calls. */
    const needsImportCheck = new Set<Finding>();

    const push = (node: SgNode, rule: { name: string; severity: Severity; message: string }): Finding => {
        const { line, column } = node.range().start;
        const finding: Finding = {
            file: node.getRoot().filename(),
            line: line + 1,
            column: column + 1,
            rule: rule.name,
            severity: rule.severity,
            message: rule.message,
            text: node.text().split("\n")[0].slice(0, 120),
        };
        unfiltered.push(finding);
        return finding;
    };

    const guard = (handle: (nodes: SgNode[]) => void) => (err: Error | null, nodes: SgNode[]) => {
        if (err) {
            throw err;
        }

        handle(nodes);
    };

    for (const [lang, paths] of byLang) {
        const processToolPass = findInFiles(
            lang,
            { paths, matcher: PROCESS_TOOL_CALL_MATCHER },
            guard((nodes) => {
                recordProcessToolSpawns(nodes, (node) => node.getRoot().filename(), push);
            })
        );

        if (options.processToolOnly) {
            await processToolPass;
            continue;
        }

        await Promise.all([
            findInFiles(
                lang,
                { paths, matcher: { rule: { any: LITERAL_KINDS.map((kind) => ({ kind })) } } },
                guard((nodes) => {
                    for (const node of nodes) {
                        const text = node.text();

                        for (const rule of RULES) {
                            if (
                                !rule.matcher &&
                                ruleApplies(rule, node.getRoot().filename()) &&
                                rule.test(text, node)
                            ) {
                                push(node, rule);
                            }
                        }
                    }
                })
            ),
            ...RULES.flatMap((rule) => {
                const matcher = rule.matcher;
                const scoped = paths.filter((path) => ruleApplies(rule, path));

                if (!matcher || scoped.length === 0) {
                    return [];
                }

                return [
                    findInFiles(
                        lang,
                        { paths: scoped, matcher },
                        guard((nodes) => {
                            for (const node of nodes) {
                                if (rule.test(node.text(), node)) {
                                    push(node, rule);
                                }
                            }
                        })
                    ),
                ];
            }),
            findInFiles(
                lang,
                { paths, matcher: INTERVAL_CALL_MATCHER },
                guard((nodes) => {
                    recordIntervalFindings(nodes, push);
                })
            ),
            findInFiles(
                lang,
                { paths, matcher: SLEEP_SYNC_IN_LOOP_MATCHER },
                guard((nodes) => {
                    recordSleepSyncFindings(nodes, push);
                })
            ),
            processToolPass,
            findInFiles(
                lang,
                { paths, matcher: { rule: { pattern: "$FN($$$ARGS)" } } },
                guard((nodes) => {
                    recordHandJoinedStorage(nodes, (node) => node.getRoot().filename(), push);
                })
            ),
            findInFiles(
                lang,
                { paths, matcher: { rule: { pattern: "$OBJ.$METHOD($$$ARGS)" } } },
                guard((nodes) => {
                    for (const node of nodes) {
                        const object = node.getMatch("OBJ")?.text();
                        const method = node.getMatch("METHOD")?.text();

                        if (object && method && PROMPT_BACKENDS.has(object) && PROMPT_METHODS.has(method)) {
                            push(node, PROMPT_BACKEND_RULE);
                            continue;
                        }

                        if (object === "mock" && method === "module") {
                            const specifier = node.getMultipleMatches("ARGS")[0]?.text();

                            if (specifier && MOCKED_PROMPT_MODULE.test(specifier)) {
                                push(node, MOCK_MODULE_RULE);
                            }
                        }
                    }
                })
            ),
        ]);
    }

    // Test files and Swift sources carry other rules only.
    for (const [lang, paths] of options.processToolOnly ? [] : testsByLang) {
        await findInFiles(
            lang,
            { paths, matcher: SPAWN_CALL_MATCHER },
            guard((nodes) => {
                for (const node of nodes) {
                    const verdict = spawnCallVerdict(node);

                    if (!verdict.violates) {
                        continue;
                    }

                    const finding = push(node, SPAWN_ENV_RULE);

                    if (verdict.needsChildProcessImport) {
                        needsImportCheck.add(finding);
                    }
                }
            })
        );
    }

    for (const file of options.processToolOnly ? [] : files) {
        if (file.endsWith(".swift")) {
            unfiltered.push(...checkSwiftSource(file, await Bun.file(file).text()));
        }
    }

    const sources = new Map<string, string[]>();

    for (const file of new Set(unfiltered.map((finding) => finding.file))) {
        sources.set(file, (await Bun.file(file).text()).split("\n"));
    }

    return unfiltered.filter((finding) => {
        const lines = sources.get(finding.file) ?? [];

        if (needsImportCheck.has(finding) && !CHILD_PROCESS_IMPORT.test(lines.join("\n"))) {
            return false;
        }

        return !isSuppressed(lines, finding.line);
    });
}

if (import.meta.main) {
    // Phase timings are printed because the only way this stayed fast was
    // measuring it. Local numbers do not predict the CI runner: the first
    // serial version was 3.1s here and about 26s there.
    // performance.now() at this point IS the time spent booting Bun and loading
    // the native @ast-grep module, before any of our work starts.
    const boot = Math.round(performance.now());
    const started = Date.now();
    const files = await targetFiles();
    const listed = Date.now();

    const findings = await scanAll(files);
    const scanned = Date.now();

    for (const finding of findings) {
        console.log(render(finding));
    }

    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.length - errors;

    const timing = `boot ${boot}ms, list ${listed - started}ms, scan ${scanned - listed}ms`;

    if (findings.length === 0) {
        console.log(`lint-rules: OK (${files.length} files, 15 repo rules) [${timing}]`);
    } else {
        console.log(`\nlint-rules: ${errors} error(s), ${warnings} warning(s) across ${files.length} files`);
    }

    process.exit(errors > 0 ? 1 : 0);
}
