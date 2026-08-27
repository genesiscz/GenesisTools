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
 * by src/repo-map, src/indexer. Matching happens in Rust, and a literal is
 * found by KIND rather than by guessing at its parents, so the context
 * enumeration disappears along with its cost.
 *
 * Full measurements and the decision record live in the author's notes, out of repo.
 */

import { findInFiles, Lang, parse, type SgNode } from "@ast-grep/napi";
import { SafeJSON } from "@genesiscz/utils/json";

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
    /** Given the node's source text, does it violate? */
    test: (text: string) => boolean;
}

/**
 * `/tmp` does not exist on Windows. The GritQL original matched the literal
 * SOURCE including quotes, hence the leading quote class; kept here so the
 * semantics stay recognisably the same rule.
 */
const HARDCODED_TMP = /^["'`]\/tmp\/.+/s;
const HARDCODED_USER_PATH = /^["'`]\/Users\/[^/]+\//s;
/** A literal that IS a `.genesis-tools` path segment, or a template that builds one from homedir(). */
const GENESIS_TOOLS_LITERAL = /^["'`]\.genesis-tools/s;
const HOMEDIR_GENESIS_TOOLS_TEMPLATE = /\$\{\s*homedir\(\)\s*\}\/\.genesis-tools/s;

const HOMEDIR_MESSAGE =
    "`homedir()` bypasses the GENESIS_TOOLS_HOME test sandbox. Use `env.tools.getHome()` from " +
    "@genesiscz/utils/env — it falls back to homedir(), so production is unchanged.";

const LITERAL_KINDS = ["string", "template_string"];

const RULES: Rule[] = [
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
];

/** Shared so `checkSource` (one file) and `scanAll` (whole repo) cannot drift. */
const HOMEDIR_RULE = { name: "no-homedir-genesis-tools", severity: "error" as const, message: HOMEDIR_MESSAGE };

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
    const lang = langFor(file);

    if (lang === null || pluginsDisabledFor(file)) {
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

    // ONE walk for every literal rule. The GritQL version paid for a separate
    // whole-tree match per rule, which is most of why it cost 9 seconds.
    for (const node of root.findAll({ rule: { any: LITERAL_KINDS.map((kind) => ({ kind })) } })) {
        const text = node.text();

        for (const rule of RULES) {
            if (rule.test(text)) {
                record(node, rule);
            }
        }

        if (HOMEDIR_GENESIS_TOOLS_TEMPLATE.test(text)) {
            record(node, HOMEDIR_RULE);
        }
    }

    // The `.genesis-tools` rule is about REACHING that directory through
    // `homedir()`, not about the literal. `join(env.tools.getHome(),
    // ".genesis-tools", …)` is the sanctioned form and appears 158 times, so a
    // rule that only looked at the literal would condemn the correct code.
    for (const node of root.findAll({ rule: { pattern: "$FN(homedir(), $$$ARGS)" } })) {
        // Start-anchored per argument, exactly as the GritQL rule was. A loose
        // `includes(".genesis-tools")` also matches the LaunchAgent plist names
        // (`com.genesis-tools.daemon.plist`), which are not the data directory.
        const violating = node.getMultipleMatches("ARGS").some((arg) => GENESIS_TOOLS_LITERAL.test(arg.text()));

        if (violating) {
            record(node, HOMEDIR_RULE);
        }
    }

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

    return new Set(diff.stdout.toString().split("\0").filter(Boolean));
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
async function scanAll(files: string[]): Promise<Finding[]> {
    const byLang = new Map<Lang, string[]>();

    for (const file of files) {
        const lang = langFor(file);

        if (lang === null || pluginsDisabledFor(file)) {
            continue;
        }

        byLang.set(lang, [...(byLang.get(lang) ?? []), file]);
    }

    // Suppression is deliberately NOT applied here: it needs the source lines,
    // and reading every file back would put the cost straight back. Only the
    // files that matched get read, once, at the end.
    const unfiltered: Finding[] = [];

    const push = (node: SgNode, rule: { name: string; severity: Severity; message: string }): void => {
        const { line, column } = node.range().start;
        unfiltered.push({
            file: node.getRoot().filename(),
            line: line + 1,
            column: column + 1,
            rule: rule.name,
            severity: rule.severity,
            message: rule.message,
            text: node.text().split("\n")[0].slice(0, 120),
        });
    };

    const guard = (handle: (nodes: SgNode[]) => void) => (err: Error | null, nodes: SgNode[]) => {
        if (err) {
            throw err;
        }

        handle(nodes);
    };

    for (const [lang, paths] of byLang) {
        await Promise.all([
            findInFiles(
                lang,
                { paths, matcher: { rule: { any: LITERAL_KINDS.map((kind) => ({ kind })) } } },
                guard((nodes) => {
                    for (const node of nodes) {
                        const text = node.text();

                        for (const rule of RULES) {
                            if (rule.test(text)) {
                                push(node, rule);
                            }
                        }

                        if (HOMEDIR_GENESIS_TOOLS_TEMPLATE.test(text)) {
                            push(node, HOMEDIR_RULE);
                        }
                    }
                })
            ),
            findInFiles(
                lang,
                { paths, matcher: { rule: { pattern: "$FN(homedir(), $$$ARGS)" } } },
                guard((nodes) => {
                    for (const node of nodes) {
                        if (node.getMultipleMatches("ARGS").some((arg) => GENESIS_TOOLS_LITERAL.test(arg.text()))) {
                            push(node, HOMEDIR_RULE);
                        }
                    }
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

    const sources = new Map<string, string[]>();

    for (const file of new Set(unfiltered.map((finding) => finding.file))) {
        sources.set(file, (await Bun.file(file).text()).split("\n"));
    }

    return unfiltered.filter((finding) => !isSuppressed(sources.get(finding.file) ?? [], finding.line));
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
        console.log(`lint-rules: OK (${files.length} files, 6 repo rules) [${timing}]`);
    } else {
        console.log(`\nlint-rules: ${errors} error(s), ${warnings} warning(s) across ${files.length} files`);
    }

    process.exit(errors > 0 ? 1 : 0);
}
