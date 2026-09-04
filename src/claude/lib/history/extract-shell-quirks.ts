/**
 * Extract zsh/bash shell-quirk incidents from Claude Code session JSONLs.
 *
 * Focus: Bash tool calls whose results contain zsh NOMATCH / glob-expansion
 * failures (the class of bugs that led to the CLAUDE.md "zsh quirks" section).
 *
 * Inspired by learn-from-fable's deterministic transcript parse (no model):
 * stream lines, pair tool_use ↔ tool_result, classify, emit structured findings
 * with exact jsonl path + line so another agent can jump straight to the event.
 */

import { createReadStream } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { extractProjectName, PROJECTS_DIR, resolveProjectDir } from "@genesiscz/utils/claude/projects";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { escapeShellArg } from "@genesiscz/utils/string";

// =============================================================================
// Types
// =============================================================================

export type ShellQuirkKind =
    | "nomatch-glob"
    | "unquoted-url"
    | "unquoted-brackets"
    | "bare-glob-qual-N"
    | "for-loop-abort"
    | "multi-glob-kills-command"
    | "stderr-suppressed"
    /** zsh equals-expansion: `=foo` → path of command; bare `===` → `== not found` / `==== not found` */
    | "equals-expansion"
    /** `zsh: bad pattern: …` — malformed unquoted `[…]` / `(…)` treated as glob */
    | "bad-pattern"
    /** `zsh: parse error near …` — unquoted `(`/`{`/`!` broke parsing before execution */
    | "parse-error"
    | "rule-codification"
    | "other-zsh-error";

/**
 * Orthogonal signals on one incident. `kind` names the most specific root cause,
 * but a single command is often ALSO multi-glob AND stderr-suppressed — losing
 * those made the old per-kind counts misleading.
 */
export interface ShellQuirkFacets {
    /** `2>/dev/null` present — the nomatch abort read as silent empty success */
    stderrSuppressed: boolean;
    /** ≥2 glob tokens — matched paths were lost along with the bad one */
    multiGlob: boolean;
    /** Failed glob sat in a `for … in` word list — the rest of the script aborted */
    forLoop: boolean;
}

export interface ShellQuirkFinding {
    id: string;
    kind: ShellQuirkKind;
    /** Short one-line title for TOC / headers */
    title: string;
    sessionId: string;
    project: string;
    filePath: string;
    /** 1-indexed jsonl line of the tool_result (or message) that matched */
    line: number;
    /** 1-indexed jsonl line of the paired Bash tool_use, if found */
    toolUseLine: number | null;
    uuid: string | null;
    toolUseId: string | null;
    toolUseUuid: string | null;
    timestamp: string | null;
    isSubagent: boolean;
    /** The Bash command that tripped (or null for pure discussion hits) */
    command: string | null;
    commandDescription: string | null;
    /** Exact zsh error line(s) extracted from the result */
    errorLines: string[];
    /** Failed glob / pattern after "no matches found:" */
    failedPatterns: string[];
    /** Truncated tool result body */
    resultExcerpt: string;
    /** Nearby assistant prose (misread / recovery), if any */
    assistantContext: string | null;
    /** Orthogonal signals beyond `kind` */
    facets: ShellQuirkFacets;
    /** How many identical (session, command, first error) occurrences this finding stands for */
    repeatCount: number;
    /** Copy-paste locate recipe for another agent */
    locate: {
        sed: string;
        rgToolUseId: string | null;
        rgError: string | null;
    };
}

export interface ExtractShellQuirksOptions {
    /** Root to scan (default ~/.claude/projects) */
    projectsDir?: string;
    /** Only these project leaf names / encoded dirs */
    project?: string;
    /** Include subagent jsonls (default true) */
    includeSubagents?: boolean;
    /** Max findings to keep (default unlimited) */
    limit?: number;
    /** Truncate command/result excerpts (default 1200) */
    excerptChars?: number;
    /** Also emit rule-codification hits (CLAUDE.md zsh section edits/discussion) */
    includeRuleCodification?: boolean;
    /** Prefilter via rg; set false to scan every jsonl (slow) */
    useRgPrefilter?: boolean;
    /** Collapse identical (session, command, first error) repeats into one finding with repeatCount (default true) */
    dedupe?: boolean;
    onProgress?: (processed: number, total: number, file: string) => void;
}

export interface ExtractShellQuirksResult {
    findings: ShellQuirkFinding[];
    filesScanned: number;
    filesWithHits: number;
    candidateFiles: number;
    elapsedMs: number;
}

// =============================================================================
// Patterns
// =============================================================================

/** Classic zsh NOMATCH from interactive / script shell */
const RE_ZSH_NOMATCH = /(?:^|\n)(?:zsh|\(eval\)):\d+: no matches found: ([^\n]+)/g;

/** Bare form some profiles emit without the zsh: prefix on the same line */
const RE_BARE_NOMATCH = /(?:^|\n)no matches found: ([^\n]+)/g;

/** Other zsh runtime errors that bit agents (not just NOMATCH) */
const RE_ZSH_OTHER = /(?:^|\n)(?:zsh|\(eval\)):\d+: (?!no matches found)([^\n]+)/g;

/** Discussion / rule-writing about the quirk class */
const RE_RULE_TALK =
    /zsh quirks|nobareglobqual|One bad glob kills|unmatched glob makes zsh|empty result from a globbed|bareglobqual|\(N\) DOES NOT WORK/i;

/**
 * Commands that SEARCH FOR or DISPLAY the quirk text itself (rg for the error,
 * cat of a report/CLAUDE.md carrying example errors). Their results quote old
 * incidents verbatim — counting them would double every mined error.
 */
const RE_SELF_REFERENTIAL = /no matches found|zsh quirks|nobareglobqual|not found:/;

const SHELL_TOOLS = new Set(["Bash", "bash", "Shell", "shell"]);

// =============================================================================
// Classification
// =============================================================================

/** Equals-expansion / bare `===` section dividers (the "Quote it" class). */
function isEqualsExpansion(errorLines: string[], command: string | null): boolean {
    const errs = errorLines.join("\n");
    // `echo ===` → `(eval):1: == not found` or `==== not found`
    if (/(?:^|\n)(?:zsh|\(eval\)):\d+: =+ not found\b/.test(`\n${errs}`)) {
        return true;
    }

    // `=foo` command-path expansion misfires
    if (/(?:^|\n)(?:zsh|\(eval\)):\d+: [=][^\s]+ not found\b/.test(`\n${errs}`)) {
        return true;
    }

    const cmd = command ?? "";
    // Unquoted === / == / =cmd tokens in the command itself
    if (/(?:^|[\s;|&])={2,}(?:[\s;|&]|$)/.test(cmd) || /(?:^|[\s;|&])=[A-Za-z_][\w.-]*/.test(cmd)) {
        if (/not found/.test(errs) || /no such file/i.test(errs)) {
            return true;
        }
    }

    return false;
}

/** Unquoted glob-bearing tokens of a command, excluding URLs (whose `?` is a query, handled as its own kind). */
function globTokens(cmd: string): string[] {
    const tokens = cmd.match(/(?:^|[\s;|&])([^\s'"`]*[*?[][^\s'"`]*)/g) ?? [];

    return tokens.map((t) => t.trim()).filter((t) => !/https?:\/\//i.test(t));
}

function computeFacets(command: string | null): ShellQuirkFacets {
    const cmd = command ?? "";
    const forList = cmd.match(/\bfor\s+\S+\s+in\s+([^;\n]*)/);

    return {
        stderrSuppressed: /2>\s*\/dev\/null/.test(cmd) && /[*?[]/.test(cmd),
        multiGlob: globTokens(cmd).length >= 2,
        forLoop: forList != null && /[*?[]/.test(forList[1] ?? ""),
    };
}

function classifyFailedPattern(
    pattern: string,
    command: string | null,
    errorLines: string[],
    facets: ShellQuirkFacets
): ShellQuirkKind {
    const p = pattern.trim();
    const cmd = command ?? "";

    if (isEqualsExpansion(errorLines, command)) {
        return "equals-expansion";
    }

    if (/\([^#]*N\)/.test(p) || /\(#qN\)/.test(p) || /\*\(N\)/.test(cmd) || /\(#qN\)/.test(cmd)) {
        return "bare-glob-qual-N";
    }

    // URL or any token with `?` that is not quoted (query string / glob)
    if (
        /^https?:\/\//i.test(p) ||
        (/\?/.test(p) && /https?:\/\//i.test(p + cmd)) ||
        (/https?:\/\/[^\s'"]*\?[^\s'"]*/.test(cmd) && !/['"]https?:\/\/[^\s'"]*\?/.test(cmd))
    ) {
        return "unquoted-url";
    }

    // path?query without scheme (e.g. git/trees/main?recursive=true)
    if (/\?[A-Za-z_][\w=&-]*/.test(p) && !p.includes("*")) {
        return "unquoted-url";
    }

    // A `[…]` class was the glob trigger itself (no * / ? outside the class)
    if (/\[[^\]]+\]/.test(p) && !/[*?]/.test(p.replace(/\[[^\]]*\]/g, ""))) {
        return "unquoted-brackets";
    }

    if (facets.forLoop) {
        return "for-loop-abort";
    }

    if (facets.multiGlob) {
        return "multi-glob-kills-command";
    }

    if (facets.stderrSuppressed) {
        return "stderr-suppressed";
    }

    return "nomatch-glob";
}

/** Split expansion-related non-nomatch errors into their own kinds. */
function classifyOtherZsh(errorLines: string[]): ShellQuirkKind {
    const t = errorLines.join("\n");
    if (/bad pattern/.test(t)) {
        return "bad-pattern";
    }

    if (/parse error near/.test(t)) {
        return "parse-error";
    }

    return "other-zsh-error";
}

function titleFor(kind: ShellQuirkKind, failed: string[], command: string | null, errorLines: string[] = []): string {
    const pat = failed[0]
        ? truncate(failed[0], 60)
        : errorLines[0]
          ? truncate(errorLines[0], 60)
          : truncate(command ?? "?", 60);
    switch (kind) {
        case "unquoted-url":
            return `Unquoted URL / ?query treated as glob: ${pat}`;
        case "unquoted-brackets":
            return `Unquoted [brackets] treated as glob: ${pat}`;
        case "bare-glob-qual-N":
            return `*(N) / bare glob qualifier failed (nobareglobqual): ${pat}`;
        case "for-loop-abort":
            return `for-loop glob abort: ${pat}`;
        case "multi-glob-kills-command":
            return `One bad glob killed whole command: ${pat}`;
        case "stderr-suppressed":
            return `2>/dev/null hid zsh nomatch (looked empty): ${pat}`;
        case "equals-expansion":
            return `zsh equals-expansion / bare === : ${pat}`;
        case "bad-pattern":
            return `zsh bad pattern (malformed unquoted glob): ${pat}`;
        case "parse-error":
            return `zsh parse error (unquoted metachar): ${pat}`;
        case "rule-codification":
            return `zsh quirk rule written / discussed: ${pat}`;
        case "other-zsh-error":
            return `Other zsh error: ${pat}`;
        default:
            return `zsh no matches found: ${pat}`;
    }
}

/** Keep only expansion-related "other" errors (drop bare command-not-found noise). */
function isExpansionRelatedOther(errorLines: string[]): boolean {
    const t = errorLines.join("\n");
    if (/no matches found/.test(t)) {
        return true;
    }

    if (/=+ not found/.test(t)) {
        return true;
    }

    if (/bad pattern|number expected|invalid mode|unmatched|parse error near/.test(t)) {
        return true;
    }

    // bare `foo not found` where foo looks like punctuation / expansion residue
    if (/(?:zsh|\(eval\)):\d+: [^a-zA-Z0-9\s][^\n]* not found/.test(t)) {
        return true;
    }

    return false;
}

function truncate(s: string, max: number): string {
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length <= max) {
        return t;
    }

    return `${t.slice(0, max - 1)}…`;
}

function excerpt(s: string, max: number): string {
    const t = s.trim();
    if (t.length <= max) {
        return t;
    }

    return `${t.slice(0, max).trimEnd()}\n…[+${t.length - max} chars]`;
}

/**
 * Excerpt centered on the first error line. A `cat`/build dump can bury the
 * zsh error hundreds of KB in — a head-of-body excerpt then shows none of it.
 */
function excerptAroundError(body: string, firstError: string | undefined, max: number): string {
    const t = body.trim();
    const idx = firstError ? t.indexOf(firstError) : -1;
    if (idx < 0 || idx <= Math.floor(max * 0.6)) {
        return excerpt(t, max);
    }

    const start = Math.max(0, idx - Math.floor(max / 2));
    const end = Math.min(t.length, start + max);
    const head = `…[+${start} chars]\n`;
    const tail = end < t.length ? `\n…[+${t.length - end} chars]` : "";

    return `${head}${t.slice(start, end).trim()}${tail}`;
}

// =============================================================================
// Candidate discovery (rg prefilter)
// =============================================================================

// Includes `=… not found` (equals-expansion), `bad pattern`, `parse error near`, `event not found`:
// files whose ONLY incident is one of those were previously invisible to the nomatch-only prefilter.
const RG_PREFILTER = String.raw`(?:zsh|\(eval\)):\d+: (?:no matches found:|=[^\s]* not found|bad pattern|parse error near|event not found)|no matches found: |zsh quirks|nobareglobqual|One bad glob kills`;

interface RgResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

async function runRg(args: string[]): Promise<RgResult> {
    const proc = Bun.spawn([ripgrepBinary() ?? "rg", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stdout, stderr };
}

/**
 * ripgrep is an ACCELERATOR here, never a requirement. It only picks which files
 * to open; every byte of classification below is pure TypeScript. Treating it as
 * a requirement made the whole extractor throw `Executable not found in $PATH:
 * "rg"` on any machine without it — ubuntu-latest has no ripgrep, which is the
 * same blind spot that let two CI guards enforce nothing for weeks.
 */
let ripgrepPresent: boolean | undefined;

function hasRipgrep(): boolean {
    if (ripgrepPresent === undefined) {
        ripgrepPresent = ripgrepBinary() !== null;

        if (!ripgrepPresent) {
            logger.info("extractShellQuirks: no ripgrep on PATH or vendored — falling back to the in-process scan");
        }
    }

    return ripgrepPresent;
}

async function listJsonlFiles(root: string): Promise<string[]> {
    const found: string[] = [];

    for await (const file of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true, onlyFiles: true })) {
        found.push(file);
    }

    // rg walks in directory order; sorting makes the fallback's file order stable
    // instead of filesystem-dependent.
    return found.sort();
}

/**
 * `rg -l` stops reading a file at its first hit and never holds one in memory.
 * Streaming line by line keeps both properties: a session transcript is a single
 * jsonl line per message and can run to tens of megabytes, and every pattern in
 * RG_PREFILTER matches within one line, so per-line testing sees what a whole-file
 * test would.
 */
async function matchesPrefilter(file: string, prefilter: RegExp): Promise<boolean> {
    const stream = createReadStream(file, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    try {
        for await (const line of rl) {
            if (prefilter.test(line)) {
                return true;
            }
        }
    } finally {
        rl.close();
        stream.destroy();
    }

    return false;
}

/** The `rg -l --regexp RG_PREFILTER` prefilter, done in process. */
async function filterByPrefilter(files: string[]): Promise<string[]> {
    const prefilter = new RegExp(RG_PREFILTER);
    const matched: string[] = [];

    for (const file of files) {
        if (await matchesPrefilter(file, prefilter)) {
            matched.push(file);
        }
    }

    return matched;
}

function splitFileList(stdout: string): string[] {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * The search ROOT, not a post-hoc path filter. `--project Foo` used to keep any path
 * containing "Foo", so it also matched the encoded project `FooBar`, and the non-rg
 * branch ignored the filter entirely. Resolving the directory up front also stops the
 * scan from reading every other project before discarding it.
 */
function resolveScanRoot(projectsDir: string, project?: string): string {
    if (!project) {
        return projectsDir;
    }

    const resolved = resolveProjectDir(project);

    if (!resolved) {
        throw new Error(`No Claude project directory matches "${project}" under ${projectsDir}`);
    }

    return resolved;
}

async function listCandidateFiles(root: string): Promise<string[]> {
    if (!hasRipgrep()) {
        return filterByPrefilter(await listJsonlFiles(root));
    }

    const result = await runRg(["-l", "--glob", "*.jsonl", "--regexp", RG_PREFILTER, root]);

    // rg exit 1 = no matches, which is an answer, not a failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`rg prefilter failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
    }

    return splitFileList(result.stdout);
}

/** Every jsonl under the root — the unfiltered form of the scan above. */
async function listAllSessionFiles(root: string): Promise<string[]> {
    if (!hasRipgrep()) {
        return listJsonlFiles(root);
    }

    const listed = await runRg(["--files", "--glob", "*.jsonl", root]);

    if (listed.exitCode !== 0 && listed.exitCode !== 1) {
        throw new Error(`rg --files failed (exit ${listed.exitCode}): ${listed.stderr.slice(0, 500)}`);
    }

    return splitFileList(listed.stdout);
}

// =============================================================================
// Per-file scan
// =============================================================================

interface PendingToolUse {
    id: string;
    name: string;
    command: string | null;
    description: string | null;
    line: number;
    uuid: string | null;
    timestamp: string | null;
}

function textFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((b) => {
            if (!b || typeof b !== "object") {
                return "";
            }

            const block = b as { type?: string; text?: string; thinking?: string };
            if (block.type === "text") {
                return block.text ?? "";
            }

            if (block.type === "thinking") {
                return block.thinking ?? "";
            }

            return "";
        })
        .filter(Boolean)
        .join("\n");
}

function collectNomatchPatterns(text: string): { errorLines: string[]; failedPatterns: string[] } {
    const errorLines: string[] = [];
    const failedPatterns: string[] = [];
    const seen = new Set<string>();

    for (const re of [RE_ZSH_NOMATCH, RE_BARE_NOMATCH]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null = re.exec(text);
        while (m) {
            const full = m[0].replace(/^\n/, "").trim();
            const pat = (m[1] ?? "").trim();
            if (full && !seen.has(full)) {
                seen.add(full);
                errorLines.push(full);
            }

            if (pat && !failedPatterns.includes(pat)) {
                failedPatterns.push(pat);
            }

            m = re.exec(text);
        }
    }

    // Drop bare matches that are clearly NOT zsh (e.g. only appeared as prose)
    // Prefer lines that look like zsh/(eval) errors when both exist.
    const zshish = errorLines.filter((l) => /^(?:zsh|\(eval\)):/.test(l) || l.startsWith("no matches found:"));
    return {
        errorLines: zshish.length ? zshish : errorLines,
        failedPatterns,
    };
}

function collectOtherZsh(text: string): string[] {
    const out: string[] = [];
    RE_ZSH_OTHER.lastIndex = 0;
    let m: RegExpExecArray | null = RE_ZSH_OTHER.exec(text);
    while (m) {
        const full = m[0].replace(/^\n/, "").trim();
        if (full && !out.includes(full)) {
            out.push(full);
        }

        m = RE_ZSH_OTHER.exec(text);
    }

    return out;
}

function isSubagentPath(filePath: string): boolean {
    return filePath.includes("/subagents/") || /\/agent-[^/]+\.jsonl$/.test(filePath);
}

async function scanFile(
    filePath: string,
    options: { excerptChars: number; includeRuleCodification: boolean }
): Promise<ShellQuirkFinding[]> {
    const findings: ShellQuirkFinding[] = [];
    const pending = new Map<string, PendingToolUse>();
    // Recent assistant text near tool calls (for misread context)
    let lastAssistantText = "";
    let lastAssistantLine = 0;

    const project = extractProjectName(filePath) || basename(dirname(filePath));
    const sessionId = basename(filePath, ".jsonl").replace(/^agent-/, "");
    const subagent = isSubagentPath(filePath);

    const fileStream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY });

    let lineNo = 0;
    for await (const raw of rl) {
        lineNo++;
        const line = raw.trim();
        if (!line) {
            continue;
        }

        let msg: Record<string, unknown>;
        try {
            msg = SafeJSON.parse(line, { strict: true }) as Record<string, unknown>;
        } catch {
            continue;
        }

        const type = msg.type as string | undefined;
        const uuid = typeof msg.uuid === "string" ? msg.uuid : null;
        const timestamp = typeof msg.timestamp === "string" ? msg.timestamp : null;
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : sessionId;

        // --- assistant: harvest Bash tool_use + prose ---
        if (type === "assistant" || type === "A") {
            const message = msg.message as { content?: unknown } | undefined;
            const content = message?.content;
            const prose = textFromContent(content);
            if (prose) {
                lastAssistantText = prose;
                lastAssistantLine = lineNo;
            }

            if (Array.isArray(content)) {
                for (const block of content) {
                    if (!block || typeof block !== "object") {
                        continue;
                    }

                    const b = block as {
                        type?: string;
                        id?: string;
                        name?: string;
                        input?: Record<string, unknown>;
                    };
                    if (b.type !== "tool_use" || !b.id || !b.name) {
                        continue;
                    }

                    if (!SHELL_TOOLS.has(b.name)) {
                        continue;
                    }

                    const input = b.input ?? {};
                    pending.set(b.id, {
                        id: b.id,
                        name: b.name,
                        command: typeof input.command === "string" ? input.command : null,
                        description: typeof input.description === "string" ? input.description : null,
                        line: lineNo,
                        uuid,
                        timestamp,
                    });
                }
            }

            // Rule-codification: assistant discusses zsh quirks while editing CLAUDE.md etc.
            if (options.includeRuleCodification && RE_RULE_TALK.test(prose)) {
                findings.push(
                    makeFinding({
                        kind: "rule-codification",
                        title: titleFor("rule-codification", [], truncate(prose, 80)),
                        sessionId: sid,
                        project,
                        filePath,
                        line: lineNo,
                        toolUseLine: null,
                        uuid,
                        toolUseId: null,
                        toolUseUuid: null,
                        timestamp,
                        isSubagent: subagent,
                        command: null,
                        commandDescription: null,
                        errorLines: [],
                        failedPatterns: [],
                        resultExcerpt: excerpt(prose, options.excerptChars),
                        assistantContext: null,
                    })
                );
            }

            continue;
        }

        // --- user tool_result ---
        if (type === "user") {
            const message = msg.message as { content?: unknown } | undefined;
            const content = message?.content;
            if (!Array.isArray(content)) {
                continue;
            }

            // Prefer toolUseResult.stdout when present (richer / same as content)
            const toolUseResult = msg.toolUseResult as { stdout?: string; stderr?: string } | undefined;

            for (const block of content) {
                if (!block || typeof block !== "object") {
                    continue;
                }

                const b = block as {
                    type?: string;
                    tool_use_id?: string;
                    content?: unknown;
                    is_error?: boolean;
                };
                if (b.type !== "tool_result" || !b.tool_use_id) {
                    continue;
                }

                // Resolve and RETIRE the pending tool_use here, before any filtering: a
                // successful Bash call takes one of the `continue`s below, and leaving its
                // entry behind grew `pending` for the whole file on command-heavy sessions.
                const tu = pending.get(b.tool_use_id) ?? null;
                pending.delete(b.tool_use_id);
                const command = tu?.command ?? null;

                let body = "";
                if (typeof b.content === "string") {
                    body = b.content;
                } else {
                    body = textFromContent(b.content);
                }

                if (toolUseResult?.stdout) {
                    body = body || toolUseResult.stdout;
                    // Prefer the fuller of the two
                    if (toolUseResult.stdout.length > body.length) {
                        body = toolUseResult.stdout;
                    }
                }

                if (toolUseResult?.stderr) {
                    body = `${body}\n${toolUseResult.stderr}`;
                }

                if (!body) {
                    continue;
                }

                const { errorLines, failedPatterns } = collectNomatchPatterns(body);
                // Always collect other zsh lines too (equals-expansion coexists with nomatch)
                const otherZsh = collectOtherZsh(body);
                const combinedErrs = [...errorLines];
                for (const e of otherZsh) {
                    if (!combinedErrs.includes(e)) {
                        combinedErrs.push(e);
                    }
                }

                if (combinedErrs.length === 0 && failedPatterns.length === 0) {
                    continue;
                }

                // Unpaired results (Read/Grep/other tools) only count when the harness
                // flagged them as errors — otherwise they QUOTE old incidents (reading a
                // report, grepping transcripts) and would double-count every mined error.
                if (!tu && b.is_error !== true) {
                    continue;
                }

                // Same false-positive class with a paired command: rg/cat OF the quirk text itself.
                if (command && RE_SELF_REFERENTIAL.test(command)) {
                    continue;
                }

                // Skip pure oh-my-zsh startup noise when not from our Bash command
                if (!tu && combinedErrs.every((e) => e.includes("/.oh-my-zsh/") || e.includes("oh-my-zsh.sh"))) {
                    continue;
                }

                const errs = combinedErrs.length ? combinedErrs : errorLines;
                const nomatchEvidence = errorLines.length > 0 || failedPatterns.length > 0;

                // Precision: nomatch/equals can only originate from a command carrying a glob
                // char or `=`. A trigger-free command (cat notes.md) whose OUTPUT contains the
                // error text is quoted content, not an incident.
                if (command && nomatchEvidence && !/[*?[=]/.test(command)) {
                    continue;
                }

                const facets = computeFacets(command);

                let kind: ShellQuirkKind;
                // Equals-expansion (`echo ===`) wins even when nomatch is also present
                if (isEqualsExpansion(errs, command) || isEqualsExpansion([body], command)) {
                    kind = "equals-expansion";
                } else if (nomatchEvidence) {
                    kind = classifyFailedPattern(failedPatterns[0] ?? "", command, errs, facets);
                } else if (!isExpansionRelatedOther(errs)) {
                    // Drop pure "command not found: expo" etc. — not expansion quirks
                    continue;
                } else {
                    kind = classifyOtherZsh(errs);
                }

                const assistantContext =
                    lastAssistantText && lineNo - lastAssistantLine < 30 ? excerpt(lastAssistantText, 500) : null;

                findings.push(
                    makeFinding({
                        kind,
                        title: titleFor(kind, failedPatterns, command, errs),
                        sessionId: sid,
                        project,
                        filePath,
                        line: lineNo,
                        toolUseLine: tu?.line ?? null,
                        uuid,
                        toolUseId: b.tool_use_id,
                        toolUseUuid: tu?.uuid ?? null,
                        timestamp: timestamp ?? tu?.timestamp ?? null,
                        isSubagent: subagent,
                        command,
                        commandDescription: tu?.description ?? null,
                        errorLines: errs.slice(0, 12),
                        failedPatterns: failedPatterns.slice(0, 12),
                        resultExcerpt: excerptAroundError(body, errs[0], options.excerptChars),
                        assistantContext,
                        facets,
                    })
                );
            }
        }
    }

    return findings;
}

function makeFinding(
    partial: Omit<ShellQuirkFinding, "id" | "locate" | "facets" | "repeatCount"> & {
        id?: string;
        facets?: ShellQuirkFacets;
        repeatCount?: number;
    }
): ShellQuirkFinding {
    // JSON quoting is NOT shell quoting: command substitutions, backticks and $vars are all
    // still live inside double quotes, and both the path and the error line come from
    // transcript-controlled text that a user is invited to copy and run.
    const quote = escapeShellArg;
    const locate = {
        sed:
            partial.toolUseLine != null
                ? `sed -n '${partial.toolUseLine},${partial.line}p' ${quote(partial.filePath)}`
                : `sed -n '${partial.line}p' ${quote(partial.filePath)}`,
        rgToolUseId: partial.toolUseId
            ? `rg -n --heading ${quote(partial.toolUseId)} ${quote(partial.filePath)}`
            : null,
        rgError: partial.errorLines[0]
            ? `rg -n --heading ${quote(partial.errorLines[0].slice(0, 80))} ${quote(partial.filePath)}`
            : null,
    };

    return {
        ...partial,
        facets: partial.facets ?? { stderrSuppressed: false, multiGlob: false, forLoop: false },
        repeatCount: partial.repeatCount ?? 1,
        id: partial.id ?? "",
        locate,
    };
}

// =============================================================================
// Public API
// =============================================================================

export async function extractShellQuirks(options: ExtractShellQuirksOptions = {}): Promise<ExtractShellQuirksResult> {
    const p = profiler.scope("claude-history");
    const started = Date.now();
    const projectsDir = options.projectsDir ?? PROJECTS_DIR;
    const excerptChars = options.excerptChars ?? 1200;
    const includeRuleCodification = options.includeRuleCodification ?? true;
    const includeSubagents = options.includeSubagents ?? true;
    const useRg = options.useRgPrefilter ?? true;

    const scanRoot = resolveScanRoot(projectsDir, options.project);

    // Without the prefilter every jsonl under the resolved root is a candidate.
    let candidates = await p.measureAsync("quirks.candidates", () =>
        useRg ? listCandidateFiles(scanRoot) : listAllSessionFiles(scanRoot)
    );

    if (!includeSubagents) {
        candidates = candidates.filter((f) => !isSubagentPath(f));
    }

    logger.info({ candidates: candidates.length, scanRoot }, "extractShellQuirks: candidates");

    const all: ShellQuirkFinding[] = [];
    let filesWithHits = 0;
    let processed = 0;

    const scanEnd = p.start("quirks.scan");
    for (const file of candidates) {
        processed++;
        options.onProgress?.(processed, candidates.length, file);
        try {
            const hits = await scanFile(file, { excerptChars, includeRuleCodification });
            if (hits.length) {
                filesWithHits++;
                all.push(...hits);
            }
        } catch (err) {
            logger.warn({ err, file }, "extractShellQuirks: skip file");
        }

        if (options.limit && all.length >= options.limit) {
            break;
        }
    }

    scanEnd();

    // Collapse retry storms: the same failing command re-run N times in one session
    // is one lesson, not N — repeatCount keeps the true occurrence total.
    let deduped = all;
    if (options.dedupe ?? true) {
        const byKey = new Map<string, ShellQuirkFinding>();
        deduped = [];
        for (const f of all) {
            const key = `${f.sessionId}|${f.command ?? f.title}|${f.errorLines[0] ?? ""}`;
            const prior = byKey.get(key);

            if (prior) {
                prior.repeatCount++;
                continue;
            }

            byKey.set(key, f);
            deduped.push(f);
        }
    }

    // Stable sort: newest first, then file+line
    deduped.sort((a, b) => {
        const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
        const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
        if (tb !== ta) {
            return tb - ta;
        }

        if (a.filePath !== b.filePath) {
            return a.filePath.localeCompare(b.filePath);
        }

        return a.line - b.line;
    });

    const limited = options.limit ? deduped.slice(0, options.limit) : deduped;

    // Assign ids F001…
    for (let i = 0; i < limited.length; i++) {
        limited[i]!.id = `F${String(i + 1).padStart(3, "0")}`;
    }

    p.summary("extractShellQuirks");

    return {
        findings: limited,
        filesScanned: processed,
        filesWithHits,
        candidateFiles: candidates.length,
        elapsedMs: Date.now() - started,
    };
}

// =============================================================================
// Markdown render
// =============================================================================

const KIND_ORDER: ShellQuirkKind[] = [
    "equals-expansion",
    "multi-glob-kills-command",
    "nomatch-glob",
    "unquoted-url",
    "unquoted-brackets",
    "bare-glob-qual-N",
    "for-loop-abort",
    "stderr-suppressed",
    "bad-pattern",
    "parse-error",
    "other-zsh-error",
    "rule-codification",
];

export function renderShellQuirksMarkdown(
    result: ExtractShellQuirksResult,
    meta: { generatedAt: string; command: string; claudeMdNote?: string } = {
        generatedAt: new Date().toISOString(),
        command: "tools claude history extract-shell-quirks",
    }
): string {
    const { findings } = result;
    const byKind = new Map<ShellQuirkKind, { findings: number; occurrences: number }>();
    const bySession = new Map<string, number>();
    const facetTotals = { stderrSuppressed: 0, multiGlob: 0, forLoop: 0 };
    let occurrences = 0;
    for (const f of findings) {
        const k = byKind.get(f.kind) ?? { findings: 0, occurrences: 0 };
        k.findings++;
        k.occurrences += f.repeatCount;
        byKind.set(f.kind, k);
        bySession.set(f.sessionId, (bySession.get(f.sessionId) ?? 0) + f.repeatCount);
        occurrences += f.repeatCount;

        if (f.facets.stderrSuppressed) {
            facetTotals.stderrSuppressed++;
        }

        if (f.facets.multiGlob) {
            facetTotals.multiGlob++;
        }

        if (f.facets.forLoop) {
            facetTotals.forLoop++;
        }
    }

    const lines: string[] = [];
    lines.push("---");
    lines.push("tags: [claude-code, zsh, bash, shell-quirks, tool-calling, extracted]");
    lines.push("status: extracted");
    lines.push(`generated: ${meta.generatedAt}`);
    lines.push(`findings: ${findings.length}`);
    lines.push("---");
    lines.push("");
    lines.push("# Zsh / Bash shell quirks extracted from Claude sessions");
    lines.push("");
    lines.push(
        "Incidents where Claude Code **Bash/Shell tool calls** tripped on zsh 5.9 (NOMATCH, unquoted globs/URLs, bare `(N)` qualifiers, for-loop aborts). These are the live occurrences behind the rules in `~/.claude/CLAUDE.md` → **zsh quirks**."
    );
    lines.push("");
    lines.push(`- **Generated:** ${meta.generatedAt}`);
    lines.push(`- **Command:** \`${meta.command}\``);
    lines.push(
        `- **Scan:** ${result.candidateFiles} candidate files → ${result.filesScanned} scanned → ${result.filesWithHits} with hits (${result.elapsedMs} ms)`
    );
    lines.push(
        `- **Findings:** ${findings.length} (${occurrences} occurrences incl. repeats) across ${bySession.size} sessions`
    );
    lines.push("");
    if (meta.claudeMdNote) {
        lines.push(meta.claudeMdNote);
        lines.push("");
    }

    lines.push("## How to re-open any finding");
    lines.push("");
    lines.push("Every section has a **Locate** block. Prefer:");
    lines.push("");
    lines.push("```bash");
    lines.push("# exact lines of the Bash tool_use … tool_result pair");
    lines.push("sed -n '<toolUseLine>,<resultLine>p' '<jsonl-path>'");
    lines.push("");
    lines.push("# or jump by tool_use_id");
    lines.push("rg -n --heading '<tool_use_id>' '<jsonl-path>'");
    lines.push("```");
    lines.push("");
    lines.push("Line numbers are **1-indexed JSONL lines** (one message object per line).");
    lines.push("");

    lines.push("## Summary by kind");
    lines.push("");
    lines.push("| Kind | Findings | Occurrences | What it is |");
    lines.push("|---|---:|---:|---|");
    for (const kind of KIND_ORDER) {
        const n = byKind.get(kind);
        if (!n) {
            continue;
        }

        lines.push(`| \`${kind}\` | ${n.findings} | ${n.occurrences} | ${kindBlurb(kind)} |`);
    }
    lines.push("");

    lines.push("## Facets (orthogonal — one finding can carry several)");
    lines.push("");
    lines.push(
        `- \`stderr-suppressed\` ${facetTotals.stderrSuppressed} · \`multi-glob\` ${facetTotals.multiGlob} · \`for-loop\` ${facetTotals.forLoop}`
    );
    lines.push("");

    lines.push("## Summary by session (top 30)");
    lines.push("");
    const topSessions = [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    lines.push("| Session | Hits |");
    lines.push("|---|---:|");
    for (const [sid, n] of topSessions) {
        lines.push(`| \`${sid}\` | ${n} |`);
    }
    lines.push("");

    lines.push("## TOC");
    lines.push("");
    lines.push(
        `Full per-finding TOC omitted (${findings.length} entries). Jump by id: search \`### F00N\` in this file, or use the **Locate** block under each finding.`
    );
    lines.push("");
    // Compact TOC: first 40 of each kind
    for (const kind of KIND_ORDER) {
        const group = findings.filter((f) => f.kind === kind);
        if (!group.length) {
            continue;
        }

        lines.push(`### ${kind} (${group.length})`);
        lines.push("");
        for (const f of group.slice(0, 40)) {
            lines.push(
                `- **${f.id}** L${f.line}${f.repeatCount > 1 ? ` ×${f.repeatCount}` : ""} — ${escapeMd(f.title)}`
            );
        }
        if (group.length > 40) {
            lines.push(`- … +${group.length - 40} more (search kind \`${kind}\` in Findings)`);
        }
        lines.push("");
    }

    lines.push("## Findings");
    lines.push("");

    for (const f of findings) {
        lines.push(`### ${f.id} — ${f.title}`);
        lines.push("");
        lines.push(`| Field | Value |`);
        lines.push(`|---|---|`);
        lines.push(`| **Kind** | \`${f.kind}\` |`);
        if (f.repeatCount > 1) {
            lines.push(`| **Repeats** | ×${f.repeatCount} (identical command+error in this session) |`);
        }

        const facetLabels = [
            f.facets.stderrSuppressed ? "stderr-suppressed" : null,
            f.facets.multiGlob ? "multi-glob" : null,
            f.facets.forLoop ? "for-loop" : null,
        ].filter(Boolean);
        if (facetLabels.length) {
            lines.push(`| **Facets** | ${facetLabels.join(" · ")} |`);
        }

        lines.push(`| **Session** | \`${f.sessionId}\`${f.isSubagent ? " (subagent)" : ""} |`);
        lines.push(`| **Project** | ${escapeMd(f.project)} |`);
        lines.push(`| **Timestamp** | ${f.timestamp ?? "?"} |`);
        lines.push(`| **JSONL** | \`${f.filePath}\` |`);
        lines.push(
            `| **Lines** | result **L${f.line}**${f.toolUseLine != null ? ` · tool_use **L${f.toolUseLine}**` : ""} |`
        );
        if (f.toolUseId) {
            lines.push(`| **tool_use_id** | \`${f.toolUseId}\` |`);
        }
        if (f.uuid) {
            lines.push(`| **result uuid** | \`${f.uuid}\` |`);
        }
        if (f.toolUseUuid) {
            lines.push(`| **tool_use uuid** | \`${f.toolUseUuid}\` |`);
        }
        lines.push("");

        lines.push("#### Locate (for another agent)");
        lines.push("");
        lines.push("```bash");
        lines.push(f.locate.sed);
        if (f.locate.rgToolUseId) {
            lines.push(f.locate.rgToolUseId);
        }
        if (f.locate.rgError) {
            lines.push(f.locate.rgError);
        }
        lines.push("```");
        lines.push("");

        if (f.commandDescription) {
            lines.push(`**Bash description:** ${escapeMd(f.commandDescription)}`);
            lines.push("");
        }

        if (f.command) {
            lines.push("#### Command");
            lines.push("");
            lines.push("```zsh");
            lines.push(f.command);
            lines.push("```");
            lines.push("");
        }

        if (f.failedPatterns.length) {
            lines.push("#### Failed pattern(s)");
            lines.push("");
            for (const p of f.failedPatterns) {
                lines.push(`- \`${escapeTicks(p)}\``);
            }
            lines.push("");
        }

        if (f.errorLines.length) {
            lines.push("#### Error line(s)");
            lines.push("");
            lines.push("```text");
            for (const e of f.errorLines) {
                lines.push(e);
            }
            lines.push("```");
            lines.push("");
        }

        lines.push("#### Tool result excerpt");
        lines.push("");
        lines.push("```text");
        lines.push(f.resultExcerpt);
        lines.push("```");
        lines.push("");

        if (f.assistantContext) {
            lines.push("#### Nearby assistant context");
            lines.push("");
            lines.push("```text");
            lines.push(f.assistantContext);
            lines.push("```");
            lines.push("");
        }

        lines.push("---");
        lines.push("");
    }

    lines.push("## Related rules (source of truth)");
    lines.push("");
    lines.push("- `~/.claude/CLAUDE.md` — section **zsh quirks** (verified 2026-08-03 / 2026-08-04)");
    lines.push(
        "- `[[FailedBashDoNotShowStdErr]]` — separate bug: failed Bash hides stderr in fullscreen TUI (amplifies silent nomatch misreads)"
    );
    lines.push("");

    return lines.join("\n");
}

function kindBlurb(kind: ShellQuirkKind): string {
    switch (kind) {
        case "nomatch-glob":
            return "Unmatched `*`/`?` → zsh skips the whole command";
        case "unquoted-url":
            return "Unquoted `https://…?…` or `path?query` — `?` is a glob char";
        case "unquoted-brackets":
            return "Unquoted `[…]` in a path treated as glob class";
        case "bare-glob-qual-N":
            return "`*(N)` fails here (`nobareglobqual`); not a fix";
        case "for-loop-abort":
            return "`for f in nosuch*` aborts the rest of the script";
        case "multi-glob-kills-command":
            return "One missing glob aborts command including good paths";
        case "stderr-suppressed":
            return "`2>/dev/null` hides nomatch → looks like empty success";
        case "equals-expansion":
            return "`=foo` path expansion; bare `===` → `== not found` (quote it)";
        case "bad-pattern":
            return "`zsh: bad pattern:` — malformed unquoted `[…]`/`(…)`";
        case "parse-error":
            return "`zsh: parse error near` — unquoted `(`/`{`/`!` broke parsing";
        case "other-zsh-error":
            return "Other expansion-related `zsh:` / `(eval):` error on a tool call";
        case "rule-codification":
            return "Session text that wrote/discussed the CLAUDE.md zsh rules";
        default:
            return kind;
    }
}

function escapeMd(s: string): string {
    return s.replace(/[[\]]/g, "\\$&").replace(/\n/g, " ");
}

function escapeTicks(s: string): string {
    return s.replace(/`/g, "'");
}
