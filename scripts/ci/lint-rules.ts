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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findInFiles, Lang, type NapiConfig, parse, type SgNode } from "@ast-grep/napi";
import { SafeJSON } from "@genesiscz/utils/json";
import { AGENT_PROCESS_MATCH_RATCHET, HARNESS_BRANCH_RATCHET, HOOK_PAYLOAD_READ_RATCHET } from "./harness-ratchet";
import { EFFORT_LIST_RATCHET, MODEL_ID_LITERAL_RATCHET, MODEL_PRICE_TABLE_RATCHET } from "./model-facts-ratchet";
import { NATIVE_HOME_CLAUDE_RATCHET, NATIVE_HOME_CODEX_GROK_RATCHET } from "./native-home-ratchet";
import { PROXY_PROVIDER_BRANCH_RATCHET } from "./proxy-provider-ratchet";
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
    /**
     * Per file, how many findings still pass while the file is migrated. One more fails every finding of the file,
     * because any of them can be the new one (a ratchet: a count only ever goes down).
     */
    allowedCounts?: ReadonlyMap<string, number>;
}

function ruleApplies(rule: Rule, file: string, ratchets = true): boolean {
    return (
        (rule.onlyIn?.test(file) ?? true) && !rule.allowedIn?.test(file) && !(ratchets && rule.allowedFiles?.has(file))
    );
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

// ─── The ratchet rules of 2026-10-25 (❓ DECISION 22 b) ────────────────────────────────────────────────────────────────
// no-transcript-format-outside-readers, no-hand-built-claude-home, no-hand-built-codex-grok-home,
// no-model-id-literal-outside-catalog, no-model-price-table, no-effort-vocabulary-list, no-harness-name-branch,
// no-hook-payload-read, no-agent-name-in-command-match. Their lists of files that still break them live in
// scripts/ci/{transcript-format,native-home,model-facts,harness}-ratchet.ts and may only shrink.
// The job that empties those lists is handoff h_2ehgo4gz, named "lint-ratchets-migration": read it with the
// genesis-tools MCP tool handoff_get { name: "lint-ratchets-migration" }. It says, rule by rule, which owner each
// violation moves into, the commit and verification rules, and where the report goes.
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

/** `~/.claude…`, `.claude/projects|sessions|settings.json|…`, `.claude.json`: a path into Claude's own home. */
const CLAUDE_HOME_LITERAL =
    /^["'`](?:~[/\\]\.claude(?:\.json|[/\\]|["'`])|(?:[^\s"'`]*[/\\])?\.claude(?:\.json["'`]|[/\\](?:projects|sessions|settings\.json|statusline|helpers|teams|\.credentials\.json)(?:[/\\"'`]|$)))/;
const CLAUDE_CONFIG_DIR_LITERAL = /^["'`]CLAUDE_CONFIG_DIR["'`]$/;
const BARE_CLAUDE_SEGMENT = /^["'`](?:[^\s"'`]*[/\\])?\.claude["'`]$/;
const CODEX_GROK_HOME_LITERAL =
    /^["'`](?:~[/\\]\.(?:codex|grok)[/\\"'`]|(?:[^\s"'`]*[/\\])?\.(?:codex|grok)[/\\](?:sessions|archived_sessions|config\.toml|auth\.json)(?:[/\\"'`]|$))/;
const BARE_CODEX_GROK_SEGMENT = /^["'`](?:[^\s"'`]*[/\\])?\.(?:codex|grok)["'`]$/;
const CODEX_GROK_ENV_LITERAL = /^["'`](?:CODEX_HOME|GROK_HOME)["'`]$/;
/** A call argument that is the user's home: a bare `.claude` segment joined to it is the agent's home. */
const HOME_ARGUMENT = /homedir\(\)|getHome\(\)|\bhome(?:Dir)?\b|\.HOME\b/;
const NATIVE_HOME_TESTS =
    /(?:^|\/)__tests__\/|^src\/utils\/agent-sessions\/testing\/|^plugins\/|\.test\.tsx?$|test-utils\.ts$/;

/** A template's own home interpolation, or the nearest enclosing call's home argument (five levels up at most). */
function hasHomeSource(node: SgNode): boolean {
    if (
        node.kind() === "template_string" &&
        node.children().some((child) => child.kind() === "template_substitution" && HOME_ARGUMENT.test(child.text()))
    ) {
        return true;
    }

    let up = node.parent();

    for (let depth = 0; up && depth < 5; depth++) {
        if (up.kind() === "call_expression") {
            return HOME_ARGUMENT.test(up.field("arguments")?.text() ?? "");
        }

        up = up.parent();
    }

    return false;
}

export function buildsClaudeHome(text: string, node: SgNode): boolean {
    return (
        CLAUDE_HOME_LITERAL.test(text) ||
        CLAUDE_CONFIG_DIR_LITERAL.test(text) ||
        (BARE_CLAUDE_SEGMENT.test(text) && hasHomeSource(node))
    );
}

export function buildsCodexGrokHome(text: string, node: SgNode): boolean {
    return (
        CODEX_GROK_HOME_LITERAL.test(text) ||
        CODEX_GROK_ENV_LITERAL.test(text) ||
        (BARE_CODEX_GROK_SEGMENT.test(text) && hasHomeSource(node))
    );
}

/** A whole literal that is a model id: `claude-opus-5-5`, `anthropic/claude-sonnet-5.5`, `gpt-6-sol:xhigh`, `grok-4.7`, `o3`. */
const MODEL_ID_LITERAL =
    /^(["'`])(?:(?:[\w.@-]+\/)*(?:claude-(?:opus|sonnet|haiku|fable)-[\w.-]+|gpt-(?!3-encoder)\d[\w.-]*|grok-(?:code-)?\d[\w.-]*|o[134])(?:\[1m\])?(?::(?:minimal|low|medium|high|xhigh|max))?)\1$/;
/** The catalog and the lists models.md names as owners; tests and fixtures carry ids on purpose. */
const MODEL_FACT_OWNERS =
    /(^|\/)(src\/utils\/ai\/catalog\/|src\/utils\/ai\/anthropic\/|src\/utils\/ai\/openai\/sub-models|src\/utils\/ai\/grok\/models|src\/ai-proxy\/lib\/(billing|translators)\/|src\/ai-proxy\/lib\/reasoning-effort-vocab|src\/claude\/lib\/models|scripts\/ai\/)|^plugins\/|\.test\.tsx?$|(^|\/)(testing|fixtures?|__fixtures__)\//;
/** `opus: { input: 15, …`: a price row keyed by a Claude family. */
const FAMILY_PRICE_ENTRY = /^["']?(?:opus|sonnet|haiku|fable)["']?\s*:\s*\{\s*input\s*:\s*\d/;
const EFFORT = "(?:minimal|none|low|medium|high|xhigh|max|ultra)";
/** An array or union made only of three or more effort words, one of them `xhigh`. */
const EFFORT_LIST = new RegExp(
    `^(?:\\[(?=[^\\]]*xhigh)\\s*(?:(["'])${EFFORT}\\1\\s*,?\\s*){3,}\\]|(?=[\\s\\S]*xhigh)(?:(["'])${EFFORT}\\2\\s*\\|\\s*){2,}(["'])${EFFORT}\\3)$`
);

/** A literal passed to `toolCommand(...)`: a usage example in help text, not a model choice. */
function isToolCommandArgument(node: SgNode): boolean {
    const args = node.parent();

    return args?.kind() === "arguments" && args.parent()?.field("function")?.text() === "toolCommand";
}

export function namesModelId(text: string, node: SgNode): boolean {
    return MODEL_ID_LITERAL.test(text) && !isToolCommandArgument(node);
}

export function isFamilyPriceEntry(text: string): boolean {
    return FAMILY_PRICE_ENTRY.test(text);
}

export function isEffortList(text: string): boolean {
    return EFFORT_LIST.test(text);
}

/** Harness branching, hook payload reads and agent process matching (Haiku survey, HarnessBranching.haiku.md). */
const AGENT_HARNESS_LITERAL = /^(["'`])(?:claude|codex|grok)\1$/;
const AGENT_HARNESS_WORD = /claude|codex|grok/i;
const COMPARE_OPS = new Set(["===", "!==", "==", "!="]);
const AGENT_OPERAND = /harness|provider|alias|kind|agent|backend|source|resolved|target|basename|argv0|^base$|\.base$/i;
const AGENT_SUBJECT = /command|cmd|argv|\bargs\b|\bcomm\b|process|\bproc\b/i;
const AGENT_SESSION_OWNERS =
    /(?:^|\/)src\/(?:utils\/process\/|utils\/claude\/peer-message\.ts$|codex\/lib\/process-scan\.ts$|grok\/lib\/process-scan\.ts$|claude\/lib\/active-sessions\.ts$)/;
/**
 * What a literal is compared with: the other side of `===`, `!==`, `==` or `!=`, or the value a `case` literal is
 * switched on. Undefined when the literal is not compared at all.
 */
function comparedOperand(node: SgNode, text: string): string | undefined {
    const parent = node.parent();

    if (parent?.kind() === "switch_case") {
        return parent.parent()?.parent()?.field("value")?.text() ?? "";
    }

    if (parent?.kind() !== "binary_expression" || !COMPARE_OPS.has(parent.field("operator")?.text() ?? "")) {
        return undefined;
    }

    const other = parent.field("right")?.text() === text ? parent.field("left") : parent.field("right");

    return other?.text() ?? "";
}

/**
 * The ai-proxy's own provider names (`AiProxyProviderType`, 2026-10-28): a comparison against one picks provider
 * behaviour at a call site, which belongs in the provider's `ProviderDefinition`. `openai` and `openrouter` are
 * also plugin ids and wire-format names, so those two count only against an operand that names a provider.
 */
const PROXY_ONLY_PROVIDER_LITERAL =
    /^(["'`])(?:grok-subscription|github-copilot-subscription|anthropic-subscription|openai-subscription|xai-api-key)\1$/;
const PROXY_SHARED_PROVIDER_LITERAL = /^(["'`])(?:openai|openrouter)\1$/;
const PROXY_PROVIDER_OPERAND = /provider/i;
const AGENT_HARNESS_OWNERS =
    /(?:^|\/)src\/(?:utils\/agent-sessions\/|utils\/ai\/providers\/|utils\/providers\/session-paths\.ts$|agents\/lib\/hooks\/(?:payload|config)\.ts$|utils\/process\/|utils\/claude\/peer-message\.ts$|codex\/lib\/process-scan\.ts$|grok\/lib\/process-scan\.ts$|claude\/lib\/active-sessions\.ts$)/;
const AGENT_PAYLOAD_SNAKE_FIELDS =
    "transcript_path|hook_event_name|tool_input|tool_response|last_assistant_message|stop_hook_active";
const AGENT_PAYLOAD_CAMEL_FIELDS =
    "hookEventName|toolInput|toolResponse|transcriptPath|lastAssistantMessage|stopHookActive";
const AGENT_PAYLOAD_SNAKE_FIELD = new RegExp(`^(?:${AGENT_PAYLOAD_SNAKE_FIELDS})$`);
const AGENT_PAYLOAD_CAMEL_FIELD = new RegExp(`^(?:${AGENT_PAYLOAD_CAMEL_FIELDS})$`);
const AGENT_PAYLOAD_MEMBER = `\\.(?:${AGENT_PAYLOAD_SNAKE_FIELDS}|${AGENT_PAYLOAD_CAMEL_FIELDS})$`;

function isRawPayload(node: SgNode | null | undefined): boolean {
    if (node?.kind() === "identifier") {
        return node.text() === "raw";
    }

    if (node?.kind() === "member_expression") {
        return node.field("property")?.text() === "raw";
    }

    const index = node?.kind() === "subscript_expression" ? node.field("index") : undefined;
    return index?.kind() === "string" && unquote(index) === "raw";
}

function readsHookPayload(node: SgNode): boolean {
    const fieldMatches = (key: string, raw: boolean) =>
        AGENT_PAYLOAD_SNAKE_FIELD.test(key) || (raw && AGENT_PAYLOAD_CAMEL_FIELD.test(key));

    if (node.kind() === "member_expression") {
        return fieldMatches(node.field("property")?.text() ?? "", isRawPayload(node.field("object")));
    }

    if (node.kind() === "subscript_expression") {
        const index = node.field("index");
        return index?.kind() === "string" && fieldMatches(unquote(index), isRawPayload(node.field("object")));
    }

    const parent = node.parent();
    const raw =
        isRawPayload(parent?.field("value") ?? parent?.field("right")) ||
        (parent?.kind() === "pair_pattern" && parent.field("key")?.text() === "raw");

    return node.children().some((child) => {
        let key = child;

        if (child.kind() === "pair_pattern") {
            key = child.field("key") ?? child;
        } else if (child.kind() === "object_assignment_pattern") {
            key = child.field("left") ?? child;
        } else if (child.kind() !== "shorthand_property_identifier_pattern") {
            return false;
        }

        if (key.kind() === "computed_property_name") {
            const literal = key.children().find((part) => part.kind() === "string");
            return literal !== undefined && fieldMatches(unquote(literal), raw);
        }

        return fieldMatches(key.kind() === "string" ? unquote(key) : key.text(), raw);
    });
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
    {
        name: "no-hand-built-claude-home",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "A path built by hand into Claude's home (~/.claude, CLAUDE_CONFIG_DIR, ~/.claude.json, the sessions " +
            "registry). Use nativeHome('claude') or nativeSessionRoots('claude') from " +
            "@genesiscz/utils/providers/session-paths (they honour CLAUDE_CONFIG_DIR), claudeSessionsDir() from " +
            "@genesiscz/utils/claude/peer-message, or getClaudeJsonAccount() from @genesiscz/utils/claude/auth. " +
            "scripts/ci/native-home-ratchet.ts lists the files not migrated yet.",
        test: buildsClaudeHome,
        allowedIn: new RegExp(
            `(?:^|/)(?:src/utils/claude/(?:projects|auth|executable|peer-message)\\.ts|src/utils/providers/session-paths\\.ts|src/utils/env/[^/]+\\.ts|src/agents/lib/hooks/(?:install|mods)\\.ts|src/mcp-manager/utils/harnesses\\.ts|src/ai-spend/lib/drivers/test-env\\.ts)$|${NATIVE_HOME_TESTS.source}`
        ),
        allowedFiles: NATIVE_HOME_CLAUDE_RATCHET,
    },
    {
        name: "no-hand-built-codex-grok-home",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "A path built by hand into the Codex or Grok home (~/.codex, ~/.grok, CODEX_HOME, GROK_HOME, their " +
            "sessions). Use nativeHome('codex' | 'grok') or nativeSessionRoots(kind) from " +
            "@genesiscz/utils/providers/session-paths (they honour the overrides and CODEX_HOME's comma list). " +
            "scripts/ci/native-home-ratchet.ts lists the files not migrated yet.",
        test: buildsCodexGrokHome,
        allowedIn: new RegExp(
            `(?:^|/)(?:src/utils/providers/session-paths\\.ts|src/utils/env/[^/]+\\.ts|src/utils/grok/worker-paths\\.ts|src/utils/codex/worker-paths\\.ts|src/utils/agent-sessions/grok-sessions\\.ts|src/utils/agent-sessions/readers/[^/]+\\.ts|src/utils/ai/grok/paths\\.ts|src/agents/lib/hooks/codex\\.ts|src/mcp-manager/utils/harnesses\\.ts|src/ai-spend/lib/drivers/test-env\\.ts)$|${NATIVE_HOME_TESTS.source}`
        ),
        allowedFiles: NATIVE_HOME_CODEX_GROK_RATCHET,
    },
    {
        name: "no-model-id-literal-outside-catalog",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "A model id written into code goes stale at the next release. Take it from the catalog: byId(id, provider) " +
            "from @genesiscz/utils/ai/catalog, or a family alias through resolveAnthropicSubModel() " +
            "(.claude/rules/models.md). scripts/ci/model-facts-ratchet.ts lists the files not migrated yet.",
        test: namesModelId,
        allowedIn: MODEL_FACT_OWNERS,
        allowedFiles: MODEL_ID_LITERAL_RATCHET,
    },
    {
        name: "no-model-price-table",
        severity: "error",
        kinds: ["pair"],
        matcher: { rule: { kind: "pair" } },
        message:
            "A price per model is a catalog fact, not a table here. Read it with effectivePricing() or pricingFor() " +
            "from @genesiscz/utils/ai/catalog (.claude/rules/models.md). scripts/ci/model-facts-ratchet.ts lists the " +
            "files not migrated yet.",
        test: (text) => isFamilyPriceEntry(text),
        allowedIn: /(^|\/)(src\/utils\/ai\/catalog\/|src\/ai-proxy\/lib\/billing\/)|\.test\.tsx?$/,
        allowedFiles: MODEL_PRICE_TABLE_RATCHET,
    },
    {
        name: "no-effort-vocabulary-list",
        severity: "error",
        kinds: ["array", "union_type"],
        matcher: { rule: { any: [{ kind: "array" }, { kind: "union_type" }] } },
        message:
            "A list of reasoning-effort values is a model fact. Use REASONING_EFFORTS or effortRange(from, to) from " +
            "@genesiscz/utils/ai/catalog/efforts and filter it per provider. scripts/ci/model-facts-ratchet.ts lists " +
            "the files not migrated yet.",
        test: (text) => isEffortList(text),
        // `union_type` exists only in the TypeScript grammars; the JavaScript scan would refuse the matcher.
        onlyIn: /\.tsx?$/,
        allowedIn:
            /(^|\/)(src\/utils\/ai\/catalog\/|src\/utils\/ai\/anthropic\/models|src\/ai-proxy\/lib\/reasoning-effort-vocab)|\.test\.tsx?$/,
        allowedFiles: EFFORT_LIST_RATCHET,
    },
    {
        name: "no-harness-name-branch",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "A harness-name branch belongs in a ProviderPlugin or NativeSessionReader member, not in its caller. " +
            "Use the provider interface and implement the difference in its owner. " +
            "scripts/ci/harness-ratchet.ts lists the callers not migrated yet.",
        onlyIn: /^(?:src|scripts)\//,
        allowedIn: AGENT_HARNESS_OWNERS,
        allowedFiles: HARNESS_BRANCH_RATCHET,
        test: (text, node) => {
            if (!AGENT_HARNESS_LITERAL.test(text)) {
                return false;
            }

            const operand = comparedOperand(node, text);

            return operand !== undefined && AGENT_OPERAND.test(operand);
        },
    },
    {
        name: "no-proxy-provider-branch",
        severity: "error",
        kinds: LITERAL_KINDS,
        message:
            "An ai-proxy provider-name branch belongs in a ProviderDefinition member " +
            "(src/ai-proxy/lib/providers/definition.ts) or in the ProxyProvider, not in its caller. " +
            "scripts/ci/proxy-provider-ratchet.ts lists how many comparisons each unmigrated file may keep.",
        onlyIn: /^src\/ai-proxy\//,
        allowedIn: /^src\/ai-proxy\/lib\/providers\//,
        allowedCounts: PROXY_PROVIDER_BRANCH_RATCHET,
        test: (text, node) => {
            const proxyOnly = PROXY_ONLY_PROVIDER_LITERAL.test(text);

            if (!proxyOnly && !PROXY_SHARED_PROVIDER_LITERAL.test(text)) {
                return false;
            }

            const operand = comparedOperand(node, text);

            return operand !== undefined && (proxyOnly || PROXY_PROVIDER_OPERAND.test(operand));
        },
    },
    {
        name: "no-hook-payload-read",
        severity: "error",
        kinds: ["member_expression", "subscript_expression", "object_pattern"],
        matcher: {
            rule: {
                any: [
                    { kind: "member_expression", regex: AGENT_PAYLOAD_MEMBER },
                    { kind: "subscript_expression", has: { field: "index", kind: "string" } },
                    { kind: "object_pattern" },
                ],
            },
        },
        message:
            "Read hook payload fields through HookPayload in src/agents/lib/hooks/payload.ts. " +
            "Add a typed field there instead of reading or destructuring the raw payload in a caller. " +
            "scripts/ci/harness-ratchet.ts lists the callers not migrated yet.",
        onlyIn: /^(?:src|scripts)\//,
        allowedIn: /(?:^|\/)src\/agents\/lib\/hooks\/payload\.ts$/,
        allowedFiles: HOOK_PAYLOAD_READ_RATCHET,
        test: (_text, node) => readsHookPayload(node),
    },
    {
        name: "no-agent-name-in-command-match",
        severity: "error",
        kinds: ["call_expression"],
        matcher: {
            rule: {
                kind: "call_expression",
                has: { field: "function", regex: "\\.(?:test|match|search|includes|startsWith|endsWith)$" },
            },
        },
        message:
            "Identify agent processes through src/utils/process/classify.ts instead of matching agent names " +
            "against command lines in a caller. scripts/ci/harness-ratchet.ts lists the callers not migrated yet.",
        onlyIn: /^(?:src|scripts)\//,
        allowedIn: AGENT_SESSION_OWNERS,
        allowedFiles: AGENT_PROCESS_MATCH_RATCHET,
        test: (_text, node) => {
            const fn = node.field("function");

            if (fn?.kind() !== "member_expression") {
                return false;
            }

            const method = fn.field("property")?.text() ?? "";
            const object = fn.field("object");
            const args = (node.field("arguments")?.children() ?? []).filter((child) => child.isNamed());

            if (method === "test" || method === "match" || method === "search") {
                const regex = method === "test" ? object : args[0];
                const subject = method === "test" ? args[0] : object;

                return (
                    regex?.kind() === "regex" &&
                    AGENT_HARNESS_WORD.test(regex.text()) &&
                    AGENT_SUBJECT.test(subject?.text() ?? "")
                );
            }

            if (!AGENT_HARNESS_LITERAL.test(args[0]?.text() ?? "")) {
                return false;
            }

            return AGENT_SUBJECT.test(object?.text() ?? "");
        },
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

const SWIFT_CLICK_COUNT_RULE = {
    name: "swift-current-event-click-count",
    severity: "error" as const,
    message:
        "`NSEvent.clickCount` raises an Objective-C exception for any event that is not a mouse click, and " +
        "`NSApp.currentEvent` inside a button action can be a key or system event. One raise made a whole Genesis " +
        "Markdown window ignore every click (2026-10-23). Use `MouseClick.current` or `MouseClick.count(of:)`, or " +
        "`// lint-rules-ignore: <why the event is always a mouse event>`.",
};
const SWIFT_CURRENT_EVENT_CLICK_COUNT = /currentEvent\s*[?!]?\s*\.clickCount/;

const SWIFT_ENTRY_MACRO_RULE = {
    name: "swift-no-entry-macro",
    severity: "error" as const,
    message:
        "`@Entry` is a SwiftUI macro: its plugin (SwiftUIMacros) ships only with Xcode, so the app stops building on " +
        "a Mac with only the Command Line Tools (#564). Write a `private struct <Name>Key: EnvironmentKey` and a " +
        "computed `EnvironmentValues` property with `get`/`set`, as `Style/MotionEnvironment.swift` does.",
};
const SWIFT_ENTRY_MACRO = /@Entry\b/;

const SWIFT_LINE_RULES = [
    { rule: SWIFT_WAIT_RULE, pattern: SWIFT_BARE_WAIT },
    { rule: SWIFT_CLICK_COUNT_RULE, pattern: SWIFT_CURRENT_EVENT_CLICK_COUNT },
    { rule: SWIFT_ENTRY_MACRO_RULE, pattern: SWIFT_ENTRY_MACRO },
];

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

interface SwiftLintString {
    end: string;
    hashes: string;
    interpolationDepth: number;
}

/** Blank Swift comments, strings and hash-delimited regexes without moving code's line or column offsets. */
function maskSwiftNonCode(source: string): string {
    const masked = source.split("");
    let index = 0;
    let blockDepth = 0;
    let regexEnd = "";
    const strings: SwiftLintString[] = [];

    const blank = (end: number) => {
        while (index < end) {
            if (source[index] !== "\n" && source[index] !== "\r") {
                masked[index] = " ";
            }

            index++;
        }
    };

    while (index < source.length) {
        const string = strings.at(-1);

        if (blockDepth > 0) {
            if (source.startsWith("/*", index)) {
                blockDepth++;
                blank(index + 2);
            } else if (source.startsWith("*/", index)) {
                blockDepth--;
                blank(index + 2);
            } else {
                blank(index + 1);
            }
        } else if (regexEnd) {
            if (source[index] === "\\") {
                blank(Math.min(index + 2, source.length));
            } else if (source.startsWith(regexEnd, index)) {
                blank(index + regexEnd.length);
                regexEnd = "";
            } else {
                blank(index + 1);
            }
        } else if (string?.interpolationDepth === 0) {
            if (source.startsWith(string.end, index)) {
                blank(index + string.end.length);
                strings.pop();
            } else if (source.startsWith(`\\${string.hashes}(`, index)) {
                blank(index + string.hashes.length + 2);
                string.interpolationDepth = 1;
            } else if (source.startsWith(`\\${string.hashes}`, index)) {
                blank(Math.min(index + string.hashes.length + 2, source.length));
            } else {
                blank(index + 1);
            }
        } else if (source.startsWith("//", index)) {
            const newline = source.indexOf("\n", index);
            blank(newline === -1 ? source.length : newline);
        } else if (source.startsWith("/*", index)) {
            blockDepth = 1;
            blank(index + 2);
        } else if (source[index] === '"' || source[index] === "#") {
            const regexOpening = /^(#+)\//.exec(source.slice(index));
            const opening = /^(#*)("{3}|")/.exec(source.slice(index));

            if (regexOpening) {
                regexEnd = `/${regexOpening[1]}`;
                blank(index + regexOpening[0].length);
            } else if (opening) {
                strings.push({ end: opening[2] + opening[1], hashes: opening[1], interpolationDepth: 0 });
                blank(index + opening[0].length);
            } else {
                index++;
            }
        } else if (string && source[index] === "(") {
            string.interpolationDepth++;
            index++;
        } else if (string && source[index] === ")") {
            string.interpolationDepth--;
            blank(index + 1);
        } else {
            index++;
        }
    }

    return masked.join("");
}

/** Swift has no grammar in the ast-grep napi package, so its rules are line regexes. */
export function checkSwiftSource(file: string, source: string): Finding[] {
    const lines = source.split("\n");
    const codeLines = maskSwiftNonCode(source).split("\n");
    const findings: Finding[] = [];

    for (const [index, text] of lines.entries()) {
        if (/^\s*\/\//.test(text) || isSuppressed(lines, index + 1)) {
            continue;
        }

        for (const { rule, pattern } of SWIFT_LINE_RULES) {
            const column = (rule === SWIFT_ENTRY_MACRO_RULE ? codeLines[index] : text).search(pattern);

            if (column === -1) {
                continue;
            }

            findings.push({
                file,
                line: index + 1,
                column: column + 1,
                rule: rule.name,
                severity: rule.severity,
                message: rule.message,
                text: text.trim().slice(0, 120),
            });
        }
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

/**
 * `ratchets: false` reports a file a ratchet still lets through: the test that keeps each ratchet list honest asks it
 * whether a listed file still offends.
 */
export function checkSource(file: string, source: string, { ratchets = true }: { ratchets?: boolean } = {}): Finding[] {
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
            if (!rule.matcher && ruleApplies(rule, file, ratchets) && rule.test(text, node)) {
                record(node, rule);
            }
        }
    }

    for (const rule of RULES) {
        if (!rule.matcher || !ruleApplies(rule, file, ratchets)) {
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

    return ratchets ? withinCountRatchets(findings) : findings;
}

/** The per-file counts of every rule that has them, by rule name. */
const COUNT_RATCHETS: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map(
    RULES.flatMap((rule) => (rule.allowedCounts ? [[rule.name, rule.allowedCounts] as const] : []))
);

/**
 * Drops the findings a per-file count still allows. A file over its count keeps every finding, each saying the
 * count, because any of them can be the new one.
 */
export function withinCountRatchets(
    findings: Finding[],
    counts: ReadonlyMap<string, ReadonlyMap<string, number>> = COUNT_RATCHETS
): Finding[] {
    const perFile = new Map<string, number>();

    for (const finding of findings) {
        const key = `${finding.rule}\0${finding.file}`;
        perFile.set(key, (perFile.get(key) ?? 0) + 1);
    }

    return findings.flatMap((finding) => {
        const allowed = counts.get(finding.rule)?.get(finding.file);

        if (allowed === undefined) {
            return [finding];
        }

        const found = perFile.get(`${finding.rule}\0${finding.file}`) ?? 0;

        if (found <= allowed) {
            return [];
        }

        return [{ ...finding, message: `${finding.message} (${found} in this file; the ratchet allows ${allowed}.)` }];
    });
}

/**
 * The file set Biome itself lints, read from `files.includes` in biome.json so
 * the two cannot drift. `git ls-files` supplies the candidates, which also
 * keeps ignored and untracked files out.
 */
/**
 * Restrict to files changed against `base`.
 *
 * Source rules are per-file and syntactic. Changes to a rule or an exemption
 * list rescan the whole tree because they can expose unchanged offenders.
 * Established exemption lists are also compared with the base before scoping.
 */
const RATCHET_INPUTS = [
    "scripts/ci/harness-ratchet.ts",
    "scripts/ci/model-facts-ratchet.ts",
    "scripts/ci/native-home-ratchet.ts",
    "scripts/ci/proxy-provider-ratchet.ts",
    "scripts/ci/tool-command-ratchet.ts",
    "scripts/ci/transcript-format-ratchet.ts",
];

/** The named entries of an array literal, comments left out. */
function arrayEntries(array: SgNode): SgNode[] {
    return array.children().filter((child) => child.isNamed() && child.kind() !== "comment");
}

/**
 * Read data, never execute a historical module. A list is `new Set([...paths])` (a file only leaves) or
 * `new Map([[path, count], ...])` (a count only goes down); null stands for "listed" in a Set. Any other shape fails
 * closed.
 */
function ratchetLists(source: string): Map<string, Map<string, number | null>> {
    const root = parse(Lang.TypeScript, source).root();
    const lists = new Map<string, Map<string, number | null>>();

    for (const node of root.findAll({ rule: { kind: "variable_declarator" } })) {
        const name = node.field("name")?.text() ?? "";

        if (!name.endsWith("_RATCHET")) {
            continue;
        }

        const value = node.field("value");
        const args =
            value
                ?.field("arguments")
                ?.children()
                .filter((child) => child.isNamed()) ?? [];
        const array = args[0];
        const collection = value?.field("constructor")?.text();

        if (value?.kind() !== "new_expression" || array?.kind() !== "array") {
            throw new Error(`lint-rules: ${name} must be a literal new Set([...]) or new Map([...])`);
        }

        if (collection === "Set") {
            const entries = arrayEntries(array);

            if (entries.some((entry) => entry.kind() !== "string")) {
                throw new Error(`lint-rules: ${name} must contain only literal paths`);
            }

            lists.set(name, new Map(entries.map((entry) => [unquote(entry), null])));
            continue;
        }

        if (collection !== "Map") {
            throw new Error(`lint-rules: ${name} must be a literal new Set([...]) or new Map([...])`);
        }

        const counts = new Map<string, number | null>();

        for (const entry of arrayEntries(array)) {
            const pair = entry.kind() === "array" ? arrayEntries(entry) : [];

            if (pair.length !== 2 || pair[0].kind() !== "string" || pair[1].kind() !== "number") {
                throw new Error(`lint-rules: ${name} must contain only literal [path, count] pairs`);
            }

            counts.set(unquote(pair[0]), Number(pair[1].text()));
        }

        lists.set(name, counts);
    }

    return lists;
}

/**
 * A list's first introduction establishes its baseline; an established list may only lose entries, and a count may
 * only go down.
 */
export function ratchetAdditions(baseSource: string, headSource: string): string[] {
    const base = ratchetLists(baseSource);
    const additions: string[] = [];

    for (const [name, entries] of ratchetLists(headSource)) {
        const previous = base.get(name);

        if (!previous) {
            continue;
        }

        for (const [file, count] of entries) {
            const before = previous.get(file);

            if (!previous.has(file)) {
                additions.push(`${name}: ${file}`);
            } else if (count !== null && typeof before === "number" && count > before) {
                additions.push(`${name}: ${file} (${before} → ${count})`);
            }
        }
    }

    return additions;
}

function checkRatchetGrowth({ from, cwd, changed }: { from: string; cwd: string; changed: ReadonlySet<string> }): void {
    const inputs = RATCHET_INPUTS.filter((file) => changed.has(file));

    if (inputs.length === 0) {
        return;
    }

    const listed = Bun.spawnSync(["git", "ls-tree", "--name-only", from, "--", ...inputs], { cwd });

    if (listed.exitCode !== 0) {
        throw new Error(`lint-rules: cannot read ratchet baseline: ${listed.stderr.toString()}`);
    }

    for (const file of listed.stdout.toString().trim().split("\n").filter(Boolean)) {
        if (!existsSync(join(cwd, file))) {
            continue;
        }

        const previous = Bun.spawnSync(["git", "show", "--no-textconv", "--no-ext-diff", `${from}:${file}`], { cwd });

        if (previous.exitCode !== 0) {
            throw new Error(`lint-rules: cannot read ${from}:${file}: ${previous.stderr.toString()}`);
        }

        const additions = ratchetAdditions(previous.stdout.toString(), readFileSync(join(cwd, file), "utf8"));

        if (additions.length > 0) {
            throw new Error(`lint-rules: ratchet lists may only shrink (${file})\n${additions.join("\n")}`);
        }
    }
}

export function changedFiles(base: string, { cwd = process.cwd() }: { cwd?: string } = {}): Set<string> | null {
    // Prefer the merge base, but fall back to diffing the ref directly. CI
    // checks out at depth 1 and fetches only the PR's base commit, so there is
    // no shared history for `merge-base` to walk — and GitHub's
    // `pull_request.base.sha` already IS the merge base.
    const merged = Bun.spawnSync(["git", "merge-base", base, "HEAD"], { cwd });
    const from = merged.exitCode === 0 ? merged.stdout.toString().trim() : base;
    const diff = Bun.spawnSync(["git", "diff", "--no-textconv", "--no-ext-diff", "--name-only", "-z", from, "HEAD"], {
        cwd,
    });

    if (diff.exitCode !== 0) {
        // Every failure degrades to a full scan. A changed-file optimisation
        // that silently checks NOTHING is worse than a slow one.
        console.warn(`lint-rules: cannot diff against ${base}; scanning everything`);
        return null;
    }

    const changed = new Set(diff.stdout.toString().split("\0").filter(Boolean));
    checkRatchetGrowth({ from, cwd, changed });
    const ruleInputs = new Set([
        "biome.json",
        "scripts/ci/lint-rules.ts",
        "scripts/ci/lint-changed.sh",
        ...RATCHET_INPUTS,
    ]);
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

    return withinCountRatchets(
        unfiltered.filter((finding) => {
            const lines = sources.get(finding.file) ?? [];

            if (needsImportCheck.has(finding) && !CHILD_PROCESS_IMPORT.test(lines.join("\n"))) {
                return false;
            }

            return !isSuppressed(lines, finding.line);
        })
    );
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
        console.log(`lint-rules: OK (${files.length} files, 23 repo rules) [${timing}]`);
    } else {
        console.log(`\nlint-rules: ${errors} error(s), ${warnings} warning(s) across ${files.length} files`);
    }

    process.exit(errors > 0 ? 1 : 0);
}
