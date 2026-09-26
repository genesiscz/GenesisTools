import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readCachedSessionCwd } from "@genesiscz/utils/agent-sessions/cached-title";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { noPaneMatched } from "./fix-threads";
import { repoFacts } from "./repo";

// The hub's prompt library: `~/.genesis-tools/hub/prompts.json`. A prompt is a text with named
// variables (`{{branch}}`, `{{pr}}`, `{{file}}`); sending renders it and types it into a session's
// cmux pane through `tools claude cmux send`, the path every other hub send takes. Written by
// `tools hub prompts add|remove` and by each send (its use count, for "most used" ordering).

const log = logger.child({ component: "hub/prompts" });

export interface SavedPrompt {
    name: string;
    text: string;
    description: string | null;
    uses: number;
    lastUsedAt: string | null;
    createdAt: string;
}

export interface PromptsFile {
    version: 1;
    prompts: SavedPrompt[];
}

/** A prompt as listed: its variables, in the order they first appear. */
export interface ListedPrompt extends SavedPrompt {
    variables: string[];
}

export type PromptErrorCode = "not-found" | "ambiguous" | "bad-input" | "missing-vars" | "send-failed";

export class HubPromptError extends Error {
    constructor(
        readonly code: PromptErrorCode,
        message: string,
        readonly missing: string[] = []
    ) {
        super(message);
        this.name = "HubPromptError";
    }
}

const VARIABLE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
const NAME = /^[A-Za-z0-9][\w .:-]{0,63}$/;
/** cmux reads these escapes as keys (Enter, Tab): a text holding one cannot be typed as it is. */
const CMUX_ESCAPE = /\\[nrt]/;
const SEND_TIMEOUT_MS = 30_000;

/** Shown until the first `add`; then they live in the file like any other prompt. */
export function defaultPrompts(now = new Date()): SavedPrompt[] {
    const createdAt = now.toISOString();
    const make = (name: string, text: string, description: string): SavedPrompt => ({
        name,
        text,
        description,
        uses: 0,
        lastUsedAt: null,
        createdAt,
    });
    return [
        make(
            "fix-review",
            "Read every unresolved, non-outdated review thread on PR {{pr}} ({{branch}}) from every reviewer, fix what is right, answer what is not, then push.",
            "Work through a PR's open review threads"
        ),
        make(
            "rebase",
            "Rebase {{branch}} onto its base branch, resolve the conflicts, run the tests and tell me what changed.",
            "Rebase the session's branch"
        ),
        make(
            "explain-file",
            "Explain {{file}}: what it does, who calls it and what would break if it changed. Quote the lines you rely on.",
            "Explain one file"
        ),
    ];
}

export function promptsPath(dir = new Storage("hub").getBaseDir()): string {
    return join(dir, "prompts.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePrompt(raw: unknown): SavedPrompt | null {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.text !== "string") {
        return null;
    }

    return {
        name: raw.name,
        text: raw.text,
        description: typeof raw.description === "string" ? raw.description : null,
        uses: typeof raw.uses === "number" && Number.isFinite(raw.uses) ? Math.max(0, Math.floor(raw.uses)) : 0,
        lastUsedAt: typeof raw.lastUsedAt === "string" ? raw.lastUsedAt : null,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    };
}

export function readPrompts(path = promptsPath()): PromptsFile {
    if (!existsSync(path)) {
        return { version: 1, prompts: defaultPrompts() };
    }

    try {
        const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
        const list = isRecord(raw) && Array.isArray(raw.prompts) ? raw.prompts : [];
        return { version: 1, prompts: list.map(normalizePrompt).filter((prompt) => prompt !== null) };
    } catch (err) {
        log.warn({ err, path }, "prompts file unreadable; showing the defaults");
        return { version: 1, prompts: defaultPrompts() };
    }
}

/** Read, change and write back under a lock, so the hub and a CLI call never lose each other's write. */
async function updatePrompts<T>(path: string, change: (file: PromptsFile) => T): Promise<T> {
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, async () => {
        const file = readPrompts(path);
        const result = change(file);
        atomicWriteFileSync(path, `${SafeJSON.stringify(file, null, 2)}\n`);
        return result;
    });
}

/** The variables a text uses, each once, in the order they first appear. */
export function promptVariables(text: string): string[] {
    const names: string[] = [];

    for (const match of text.matchAll(VARIABLE)) {
        if (!names.includes(match[1])) {
            names.push(match[1]);
        }
    }

    return names;
}

/** Fill every `{{name}}`; a variable without a value stays as written and is reported missing. */
export function renderPrompt(text: string, vars: Record<string, string>): { text: string; missing: string[] } {
    const missing: string[] = [];
    const rendered = text.replace(VARIABLE, (whole, name: string) => {
        const value = vars[name];

        if (value === undefined || value === "") {
            if (!missing.includes(name)) {
                missing.push(name);
            }

            return whole;
        }

        return value;
    });
    return { text: rendered, missing };
}

/** Most used first, then most recently used, then by name. */
export function sortByUse<T extends SavedPrompt>(prompts: T[]): T[] {
    return [...prompts].sort(
        (a, b) =>
            b.uses - a.uses || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") || a.name.localeCompare(b.name)
    );
}

export function listPrompts(path = promptsPath()): ListedPrompt[] {
    return sortByUse(readPrompts(path).prompts).map((prompt) => ({
        ...prompt,
        variables: promptVariables(prompt.text),
    }));
}

/** An exact name, else the only case-insensitive match, else the only prefix match. */
export function findPrompt(prompts: SavedPrompt[], name: string): SavedPrompt {
    const exact = prompts.find((prompt) => prompt.name === name);

    if (exact) {
        return exact;
    }

    const lower = name.toLowerCase();
    const folded = prompts.filter((prompt) => prompt.name.toLowerCase() === lower);
    const candidates =
        folded.length > 0 ? folded : prompts.filter((prompt) => prompt.name.toLowerCase().startsWith(lower));

    if (candidates.length === 1) {
        return candidates[0];
    }

    if (candidates.length > 1) {
        throw new HubPromptError(
            "ambiguous",
            `"${name}" matches ${candidates.map((prompt) => prompt.name).join(", ")}`
        );
    }

    throw new HubPromptError("not-found", `no saved prompt is named "${name}" (tools hub prompts list)`);
}

export async function addPrompt({
    name,
    text,
    description,
    replace = false,
    path = promptsPath(),
    now = new Date(),
}: {
    name: string;
    text: string;
    description?: string;
    replace?: boolean;
    path?: string;
    now?: Date;
}): Promise<SavedPrompt> {
    const trimmed = name.trim();

    if (!NAME.test(trimmed)) {
        throw new HubPromptError(
            "bad-input",
            "a prompt name is 1-64 letters, digits, spaces, dots, colons, dashes or underscores"
        );
    }

    if (text.trim() === "") {
        throw new HubPromptError("bad-input", "the prompt text is empty");
    }

    return updatePrompts(path, (file) => {
        const at = file.prompts.findIndex((prompt) => prompt.name === trimmed);

        if (at >= 0 && !replace) {
            throw new HubPromptError("bad-input", `"${trimmed}" exists; pass --replace to overwrite it`);
        }

        const kept = at >= 0 ? file.prompts[at] : null;
        const prompt: SavedPrompt = {
            name: trimmed,
            text,
            description: description?.trim() || kept?.description || null,
            uses: kept?.uses ?? 0,
            lastUsedAt: kept?.lastUsedAt ?? null,
            createdAt: kept?.createdAt ?? now.toISOString(),
        };

        if (at >= 0) {
            file.prompts[at] = prompt;
        } else {
            file.prompts.push(prompt);
        }

        log.info({ name: trimmed, replaced: at >= 0, variables: promptVariables(text) }, "prompt saved");
        return prompt;
    });
}

export async function removePrompt({
    name,
    path = promptsPath(),
}: {
    name: string;
    path?: string;
}): Promise<SavedPrompt> {
    return updatePrompts(path, (file) => {
        const found = findPrompt(file.prompts, name);
        file.prompts = file.prompts.filter((prompt) => prompt.name !== found.name);
        log.info({ name: found.name }, "prompt removed");
        return found;
    });
}

async function recordUse({ name, path, now }: { name: string; path: string; now: Date }): Promise<void> {
    await updatePrompts(path, (file) => {
        const found = file.prompts.find((prompt) => prompt.name === name);

        if (found) {
            found.uses += 1;
            found.lastUsedAt = now.toISOString();
        }
    });
}

/** `k=v` pairs from repeated `--var`; the first `=` splits, so a value may hold more. */
export function parseVars(pairs: string[]): Record<string, string> {
    const vars: Record<string, string> = {};

    for (const pair of pairs) {
        const at = pair.indexOf("=");

        if (at <= 0) {
            throw new HubPromptError("bad-input", `--var takes name=value, got "${pair}"`);
        }

        vars[pair.slice(0, at).trim()] = pair.slice(at + 1);
    }

    return vars;
}

/**
 * How a rendered prompt reaches the pane. One plain line is typed as it is; a text with a line break
 * or a `\n`-style escape would be cut into several submissions by cmux (it types those as Enter), so it
 * goes into a file and a one-line pointer to that file is typed instead.
 */
export function deliveryMode(text: string): "inline" | "file" {
    return text.includes("\n") || text.includes("\r") || CMUX_ESCAPE.test(text) ? "file" : "inline";
}

export interface SendPromptResult {
    name: string;
    session: string;
    /** The rendered prompt. */
    text: string;
    /** What was typed into the pane: the text, or the pointer to `file`. */
    typed: string;
    mode: "inline" | "file";
    file: string | null;
    vars: Record<string, string>;
    /** Variables filled from the session's folder (branch, pr, cwd, project, session). */
    filled: string[];
    sent: boolean;
    dryRun: boolean;
}

export interface SendPromptDeps {
    /** The session's working folder (the history index), or null. */
    cwdOf: (session: string) => string | null;
    /** Branch and PR of a checkout; the PR only when asked (a forge call behind a 60 s cache). */
    facts: (cwd: string, withPr: boolean) => Promise<{ branch: string | null; root: string | null; pr: string | null }>;
    /** Type one line into the session's cmux pane; an error message, or null when it went. */
    send: (session: string, text: string) => Promise<string | null>;
    write: (file: string, text: string) => Promise<void>;
    dir: string;
    now: () => Date;
}

const CONTEXT_VARIABLES = new Set(["branch", "pr", "cwd", "project", "session"]);

function pointerTo(file: string): string {
    return `Read ${file} and do what it says; it is a prompt I saved in the hub.`;
}

/** Writes `text` under `file`, or under `<name>-2.md`, `-3`, … when that name is taken (EEXIST). */
async function writeFresh(deps: SendPromptDeps, file: string, text: string): Promise<string> {
    for (let attempt = 1; attempt <= 50; attempt++) {
        const candidate = attempt === 1 ? file : file.replace(/\.md$/, `-${attempt}.md`);

        try {
            await deps.write(candidate, text);
            return candidate;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
                throw error;
            }

            log.debug({ candidate }, "prompt file name taken; trying the next");
        }
    }

    throw new HubPromptError("send-failed", `no free file name next to ${file}`);
}

export const realSendPromptDeps: SendPromptDeps = {
    cwdOf: (session) => readCachedSessionCwd({ sessionId: session }),
    facts: async (cwd, withPr) => {
        const facts = await repoFacts({ path: cwd, withPr });
        return { branch: facts.branch, root: facts.root, pr: facts.pr ? String(facts.pr.number) : null };
    },
    send: async (session, text) => {
        // After `--`: a line that starts with a hyphen is text, not an option.
        const run = await execTool(["claude", "cmux", "send", "--first", "--json", "--", session, text], {
            timeout: SEND_TIMEOUT_MS,
        });

        if (run.success) {
            return null;
        }

        const reason = noPaneMatched(run.stdout) ? "no cmux pane runs this session" : run.stderr || run.stdout;
        return reason.split("\n").slice(-3).join(" ").slice(0, 300) || `exit ${run.exitCode}`;
    },
    write: async (file, text) => {
        await mkdir(dirname(file), { recursive: true });
        // Exclusive: two sends in one millisecond share a name, and the second must not replace the first.
        await writeFile(file, text, { flag: "wx" });
    },
    dir: join(new Storage("hub").getBaseDir(), "prompts-sent"),
    now: () => new Date(),
};

/**
 * Render a saved prompt for one session and type it into its cmux pane. Variables come from `vars`
 * first; `branch`, `pr`, `cwd`, `project` and `session` that are still missing come from the
 * session's folder. Anything still missing stops the send with the list.
 */
export async function sendPrompt({
    name,
    session,
    vars = {},
    dryRun = false,
    path = promptsPath(),
    deps = realSendPromptDeps,
}: {
    name: string;
    session: string;
    vars?: Record<string, string>;
    dryRun?: boolean;
    path?: string;
    deps?: SendPromptDeps;
}): Promise<SendPromptResult> {
    const prompt = findPrompt(readPrompts(path).prompts, name);
    const wanted = promptVariables(prompt.text);
    const values: Record<string, string> = { ...vars };
    const filled: string[] = [];
    const needed = wanted.filter((variable) => !values[variable] && CONTEXT_VARIABLES.has(variable));

    if (needed.length > 0) {
        const context: Record<string, string | null> = { session };
        const cwd = deps.cwdOf(session);
        context.cwd = cwd;

        if (cwd && needed.some((variable) => variable !== "session" && variable !== "cwd")) {
            try {
                const facts = await deps.facts(cwd, needed.includes("pr"));
                context.branch = facts.branch;
                context.pr = facts.pr;
                context.project = facts.root ? basename(facts.root) : null;
            } catch (err) {
                log.warn(
                    { err, cwd },
                    "prompt send: the session's checkout facts failed; those variables stay missing"
                );
            }
        }

        for (const variable of needed) {
            const value = context[variable];

            if (value) {
                values[variable] = value;
                filled.push(variable);
            }
        }
    }

    const rendered = renderPrompt(prompt.text, values);

    if (rendered.missing.length > 0) {
        throw new HubPromptError(
            "missing-vars",
            `"${prompt.name}" needs ${rendered.missing.map((variable) => `--var ${variable}=…`).join(" ")}`,
            rendered.missing
        );
    }

    const mode = deliveryMode(rendered.text);
    const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
    const file = mode === "file" ? join(deps.dir, `${stamp}-${prompt.name.replace(/[^\w.-]+/g, "_")}.md`) : null;
    const typed = file ? pointerTo(file) : rendered.text;
    const result: SendPromptResult = {
        name: prompt.name,
        session,
        text: rendered.text,
        typed,
        mode,
        file,
        vars: values,
        filled,
        sent: false,
        dryRun,
    };

    if (dryRun) {
        return result;
    }

    let sentTyped = typed;

    if (file) {
        const written = await writeFresh(deps, file, `${rendered.text}\n`);

        if (written !== file) {
            result.file = written;
            sentTyped = pointerTo(written);
            result.typed = sentTyped;
        }
    }

    const error = await deps.send(session, sentTyped);
    log.info({ name: prompt.name, session, mode, filled, error }, "prompt send");

    if (error) {
        throw new HubPromptError("send-failed", error);
    }

    await recordUse({ name: prompt.name, path, now: deps.now() });
    return { ...result, sent: true };
}
