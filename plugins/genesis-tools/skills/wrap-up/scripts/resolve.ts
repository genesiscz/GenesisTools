#!/usr/bin/env bun

/**
 * wrap-up target resolver.
 *
 * Owns the deterministic half of "where does the wrap-up doc live?":
 *   - resolve : match the current project/branch/worktree against the registry,
 *               print the obsidian dir + the derived doc path (or found:false).
 *               Context comes from the shell cwd unless --project/--branch/--cwd
 *               pin it, and is always echoed back with `warnings` naming every
 *               reason the top match may be the wrong doc.
 *   - entries : list every registered target for a project (the redirect menu).
 *   - register: append/update a registry entry after the user confirms a target.
 *               The entry is pinned to the current branch unless --branch or
 *               --all-branches says otherwise.
 *   - here    : print ONLY the YOU-ARE-HERE block of a wrap-up file (cheap read).
 *   - log     : atomically append a log section AND rewrite the YOU-ARE-HERE block,
 *               auto-stamping the datetime and auto-generating the before→after
 *               snapshot from the outgoing header. stdin carries two parts split by
 *               sentinel lines: @@HERE@@ (new state bullets) then @@LOG@@ (log body).
 *               Prints { logged:true, file, stamp, lines, linesAdded, linesModified }
 *               so the caller can Read the rewritten header and the new section.
 *
 * The registry lives at ~/.claude/handoff-registry.json:
 *   { "entries": [ { projectDir, branch?, worktreeDir?, obsidianDir, docPath? }, ... ] }
 * A missing/empty `branch` means the entry matches any branch in that project.
 *
 * Shared plugin config (optional) lives at ~/.genesis-tools/plugins/config.json:
 *   { "wrap-up": { "registryPath"?, "vaultDir"?, "docDir"? } }
 *   - registryPath: overrides the registry location.
 *   - docDir: fallback doc directory when the registry has no match — absolute,
 *     or relative to the project toplevel (e.g. ".claude/wrapups").
 *   - vaultDir: vault root; fallback target becomes <vaultDir>/<projectName>.
 *   Resolution order: registry match > docDir > vaultDir > found:false.
 */

import { chmod, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

// lint-rules-ignore: standalone script without access to @genesiscz/utils/env
const PLUGIN_CONFIG = join(homedir(), ".genesis-tools", "plugins", "config.json");
const HERE_START = "<!-- YOU-ARE-HERE:START -->";
const HERE_END = "<!-- YOU-ARE-HERE:END -->";

export interface Entry {
    projectDir: string;
    branch?: string;
    worktreeDir?: string;
    obsidianDir: string;
    docPath?: string;
}
interface Registry {
    entries: Entry[];
}

interface WrapUpConfig {
    registryPath?: string;
    vaultDir?: string;
    docDir?: string;
}

// One resolve invocation reads this on both the registry-path lookup and the
// docDir fallback; caching keeps it to a single read and stops a corrupt config
// from printing the same warning twice.
let pluginConfigCache: WrapUpConfig | undefined;

async function loadPluginConfig(): Promise<WrapUpConfig> {
    if (pluginConfigCache) {
        return pluginConfigCache;
    }

    const cfg = await readPluginConfig();
    pluginConfigCache = cfg;
    return cfg;
}

async function readPluginConfig(): Promise<WrapUpConfig> {
    const f = Bun.file(PLUGIN_CONFIG);
    if (!(await f.exists())) {
        return {};
    }

    try {
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        const parsed = JSON.parse(await f.text());
        return typeof parsed?.["wrap-up"] === "object" && parsed["wrap-up"] !== null ? parsed["wrap-up"] : {};
    } catch (err) {
        // Falling back to {} silently would make a corrupt config look like an
        // absent one and quietly demote the wrap-up to a different target tier.
        console.error(`wrap-up: ignoring unreadable plugin config ${PLUGIN_CONFIG}: ${String(err)}`);
        return {};
    }
}

export function expandHome(p: string): string {
    return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function registryPath(): Promise<string> {
    const cfg = await loadPluginConfig();
    return expandHome(cfg.registryPath ?? join(homedir(), ".claude", "handoff-registry.json"));
}

export async function sh(cmd: string[]): Promise<string> {
    try {
        const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        const code = await p.exited;
        if (code !== 0) {
            // Callers deliberately fall back (cwd / empty branch) so this stays
            // non-fatal, but a swallowed failure is indistinguishable from a
            // legitimately empty result — say which one happened.
            console.error(`wrap-up: \`${cmd.join(" ")}\` exited ${code}${err.trim() ? `: ${err.trim()}` : ""}`);
            // Discard whatever landed on stdout: a failed `git rev-parse` can
            // still print, and passing that through would be taken for a real
            // toplevel or branch name.
            return "";
        }

        return out.trim();
    } catch (err) {
        // Bun.spawn throws outright when the binary is missing from $PATH, which
        // would crash the whole command instead of taking the documented
        // no-git fallback. Degrade to "" like a non-zero exit does.
        console.error(`wrap-up: \`${cmd.join(" ")}\` could not run: ${String(err)}`);
        return "";
    }
}

async function loadRegistry(): Promise<Registry> {
    const path = await registryPath();
    const f = Bun.file(path);
    if (!(await f.exists())) {
        return { entries: [] };
    }

    try {
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        const parsed = JSON.parse(await f.text());
        return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
    } catch (err) {
        // A malformed registry must not masquerade as an empty one — that would
        // silently drop every registered target and resolve to found:false.
        console.error(`wrap-up: ignoring unreadable registry ${path}: ${String(err)}`);
        return { entries: [] };
    }
}

// Write via temp file + rename so an interrupted write can never leave a
// truncated file behind. Both targets are append-only records whose partial
// loss is unrecoverable: the registry holds every project's wrap-up target,
// and the wrap-up doc's log is the only permanent session history.
export async function writeAtomic(path: string, body: string): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const existed = await Bun.file(path).exists();
    try {
        await Bun.write(tmp, body);
        if (existed) {
            // rename() swaps in a brand-new inode created under the current
            // umask, so a private 0600 registry or wrap-up doc would silently
            // widen to 0644. Carry the destination's mode over to the temp file.
            const { mode } = await stat(path);
            await chmod(tmp, mode & 0o777);
        }

        await rename(tmp, path);
    } catch (err) {
        // Never leave the half-written temp file next to the real one.
        await rm(tmp, { force: true });
        throw err;
    }
}

async function saveRegistry(reg: Registry): Promise<void> {
    // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
    await writeAtomic(await registryPath(), `${JSON.stringify(reg, null, 2)}\n`);
}

export function slug(s: string): string {
    return (
        s
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "main"
    );
}

export function derivedDocPath(entry: Entry, branch: string): string {
    if (entry.docPath) {
        return entry.docPath;
    }

    const project = basename(entry.projectDir);
    return join(entry.obsidianDir, `${project}-${slug(branch)}.wrapup.md`);
}

export interface Ctx {
    toplevel: string;
    branch: string;
    cwd: string;
    /** The main checkout, when `toplevel` is a linked worktree. Empty otherwise. */
    mainProject?: string;
}

/**
 * First porcelain `worktree ` line is the main checkout. Empty / same-path
 * means we ARE the main checkout (or git said nothing).
 */
export function parsePorcelainMain(text: string, toplevel: string): string {
    const first = text.split("\n")[0] ?? "";
    const main = first.startsWith("worktree ") ? first.slice("worktree ".length).trim() : "";
    return main && main !== toplevel ? main : "";
}

/**
 * `git worktree list` prints the main checkout first. A linked worktree can live
 * anywhere — a sibling directory as often as a nested one — so without this a
 * sibling worktree path-matches nothing and every project-level entry is missed.
 */
async function mainCheckout(toplevel: string): Promise<string> {
    return parsePorcelainMain(await sh(["git", "-C", toplevel, "worktree", "list", "--porcelain"]), toplevel);
}

/**
 * Everything below keys off this context, so getting it from the ambient shell
 * alone is how a wrap-up lands in another project's vault folder: the agent's
 * shell cwd persists across calls and is not necessarily the repo the session
 * worked in. `--project` / `--branch` / `--cwd` let the caller pin it, and the
 * pinned values are echoed back in every `resolve` result so a wrong one is
 * visible instead of silent.
 */
async function gitContext(args: Record<string, string> = {}): Promise<Ctx> {
    const pinnedProject = args.project ? expandHome(args.project) : "";
    // A pinned project implies its own cwd: keeping the ambient one would let a
    // stale directory still path-match a foreign registry entry.
    const cwd = args.cwd ? expandHome(args.cwd) : pinnedProject || process.cwd();
    // Normalize whatever was pinned to the checkout root. --project is routinely
    // given a subdirectory or a worktree path, and echoing that raw path back as
    // "project" is how a wrong target survives review.
    const toplevel = (await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"])) || pinnedProject || cwd;
    const branch = args.branch || (await sh(["git", "-C", toplevel, "rev-parse", "--abbrev-ref", "HEAD"]));
    return { toplevel, branch: branch || "", cwd, mainProject: await mainCheckout(toplevel) };
}

export function matches(entry: Entry, ctx: Ctx): number {
    // Higher score = more specific match. 0 = no match.
    // Do not prefix-match cwd against another repository: a nested git checkout
    // at /parent/child would otherwise steal the parent's wrap-up. Same-repo
    // subdirectories still match because gitContext sets toplevel to the root.
    const paths = [entry.worktreeDir, entry.projectDir].filter(Boolean) as string[];
    const direct = paths.some((p) => ctx.toplevel === p || ctx.cwd === p);
    // From a linked worktree, an entry registered against the main checkout is
    // still this project's entry — a sibling worktree shares no path prefix with
    // it, so without this the correct target resolves to found:false.
    const viaMain = !direct && Boolean(ctx.mainProject) && paths.some((p) => p === ctx.mainProject);
    if (!direct && !viaMain) {
        return 0;
    }

    if (entry.branch && entry.branch !== ctx.branch) {
        return 0;
    }

    let score = 1;
    if (entry.worktreeDir && (ctx.toplevel === entry.worktreeDir || ctx.cwd.startsWith(`${entry.worktreeDir}/`))) {
        score += 2;
    }

    if (entry.branch) {
        score += 1;
    }

    return score;
}

export interface Ranked {
    entry: Entry;
    score: number;
}

/**
 * Rank the matching entries, most specific first. Equal specificity is broken by
 * registration order, newest first: `register` appends, so the later entry is the
 * one the user set up most recently, and a months-old catch-all must not outrank it.
 */
export function rankEntries(entries: Entry[], ctx: Ctx): Ranked[] {
    return entries
        .map((entry, index) => ({ entry, score: matches(entry, ctx), index }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .map(({ entry, score }) => ({ entry, score }));
}

/**
 * The failure this skill actually hits is a confident wrong answer, not a missing
 * one. These warnings name every reason the top match may not be the target the
 * session wants, so the caller can stop and confirm instead of appending a session
 * log to an unrelated project's doc.
 */
export function resolutionWarnings({
    entry,
    ctx,
    alternatives,
    docExists,
}: {
    entry: Entry;
    ctx: Ctx;
    alternatives: Ranked[];
    docExists: boolean;
}): string[] {
    const warnings: string[] = [];
    if (!entry.branch) {
        warnings.push(
            `matched a project-wide entry (no branch pinned): it claims EVERY branch of ${basename(entry.projectDir)}, not just "${ctx.branch}" — confirm this is the right doc before writing`
        );
    }

    if (!entry.branch && entry.docPath) {
        warnings.push(
            `that entry also pins docPath, so every branch of this project appends into the same file (${entry.docPath})`
        );
    }

    if (alternatives.length) {
        warnings.push(
            `${alternatives.length} other registry entr${alternatives.length === 1 ? "y" : "ies"} also match — see "alternatives"`
        );
    }

    if (!docExists) {
        warnings.push("docPath does not exist yet — create it from the SKILL.md template before calling `log`");
    }

    return warnings;
}

function registerHint(ctx: Ctx, obsidianDir = "<dir>"): string {
    const worktree = ctx.mainProject ? ` --worktree "${ctx.toplevel}"` : "";
    const project = ctx.mainProject || ctx.toplevel;
    return `bun "${import.meta.path}" register --obsidian "${obsidianDir}" --project "${project}" --branch "${ctx.branch}"${worktree}`;
}

function entriesHint(ctx: Ctx): string {
    return `bun "${import.meta.path}" entries --project "${ctx.toplevel}"`;
}

/**
 * The guide half of this script. A caller that only gets a path has to invent the
 * procedure; spelling out the next commands is what keeps a doubtful match from
 * being written anyway, and it replaces the habit of registering a catch-all
 * entry just to make the question go away.
 */
export function nextSteps({
    found,
    exact,
    docExists,
    docPath,
    registerCmd,
    entriesCmd,
}: {
    found: boolean;
    exact: boolean;
    docExists: boolean;
    docPath: string;
    registerCmd: string;
    entriesCmd: string;
}): string[] {
    if (!found) {
        return [
            "1. Tier 1 wins if it applies: a vault folder this session already read or wrote for this project IS the target, no lookup needed.",
            `2. Otherwise see what is already registered for this project: ${entriesCmd}`,
            "3. Infer the vault layout with one or two `ls` calls, then ask the user to confirm the directory (AskUserQuestion).",
            `4. Pin the confirmed directory so it is never asked again: ${registerCmd}`,
            "5. Create the doc from the SKILL.md template, then append with `log`.",
        ];
    }

    const steps: string[] = [];
    if (!exact) {
        steps.push(
            `1. Do not write yet. No entry claims this branch specifically, so show the user this docPath plus "alternatives" and let them confirm (AskUserQuestion). Full list: ${entriesCmd}`,
            `2. Once confirmed, pin it to this branch — do NOT register a catch-all: ${registerCmd}`
        );
    }

    steps.push(
        docExists
            ? `${steps.length + 1}. Read the current state cheaply with \`here "${docPath}"\`, then append this session with \`log "${docPath}"\`.`
            : `${steps.length + 1}. Create "${docPath}" from the SKILL.md template (header + first log section), then use \`log\` for every later session.`
    );

    return steps;
}

export interface RegistryIssue {
    kind: "catch-all" | "shared-doc" | "missing-project" | "missing-worktree" | "missing-vault-dir";
    entry: Entry;
    detail: string;
    fix: string;
}

/**
 * Read-only audit of the registry. Every issue here has already cost a session:
 * branch-less entries hijack unrelated branches, and entries pointing at deleted
 * worktrees resolve to a checkout that no longer exists.
 */
export function auditRegistry(entries: Entry[], exists: (path: string) => boolean): RegistryIssue[] {
    const issues: RegistryIssue[] = [];
    for (const entry of entries) {
        const pin = `register --obsidian "${entry.obsidianDir}" --project "${entry.projectDir}" --branch "<branch this doc belongs to>"`;
        if (!entry.branch) {
            issues.push({
                kind: "catch-all",
                entry,
                detail: `no branch pinned: this entry claims every branch of ${basename(entry.projectDir)}`,
                fix: `re-register it against the branch it was written for: ${pin}`,
            });
        }

        if (!entry.branch && entry.docPath) {
            issues.push({
                kind: "shared-doc",
                entry,
                detail: `every branch of ${basename(entry.projectDir)} appends into ${entry.docPath}`,
                fix: "drop docPath (so each branch derives its own file), or pin the entry to one branch",
            });
        }

        if (!exists(entry.projectDir)) {
            issues.push({
                kind: "missing-project",
                entry,
                detail: `projectDir no longer exists: ${entry.projectDir}`,
                fix: "delete this entry from the registry file by hand",
            });
        }

        if (entry.worktreeDir && !exists(entry.worktreeDir)) {
            issues.push({
                kind: "missing-worktree",
                entry,
                detail: `worktreeDir no longer exists: ${entry.worktreeDir}`,
                fix: "delete this entry, or re-register it without --worktree",
            });
        }

        if (!exists(entry.obsidianDir)) {
            issues.push({
                kind: "missing-vault-dir",
                entry,
                detail: `obsidianDir does not exist: ${entry.obsidianDir}`,
                fix: "create the directory, or re-register the entry against the real vault folder",
            });
        }
    }

    return issues;
}

async function cmdResolve(args: Record<string, string> = {}) {
    const ctx = await gitContext(args);
    const reg = await loadRegistry();
    const ranked = rankEntries(reg.entries, ctx);

    if (ranked.length === 0) {
        // Fallback tier: shared plugin config. docDir (absolute or project-relative)
        // wins over vaultDir/<projectName>; both land as a synthetic non-registered
        // entry so the doc path derivation stays uniform.
        const cfg = await loadPluginConfig();
        const docDir = cfg.docDir
            ? isAbsolute(expandHome(cfg.docDir))
                ? expandHome(cfg.docDir)
                : join(ctx.toplevel, cfg.docDir)
            : cfg.vaultDir
              ? join(expandHome(cfg.vaultDir), basename(ctx.toplevel))
              : null;

        if (docDir) {
            const entry: Entry = { projectDir: ctx.toplevel, obsidianDir: docDir };
            const docPath = derivedDocPath(entry, ctx.branch);
            console.log(
                // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
                JSON.stringify(
                    {
                        found: true,
                        source: "config",
                        // The config fallback derives a per-branch filename, so it is
                        // branch-exact by construction.
                        exact: true,
                        obsidianDir: docDir,
                        docPath,
                        docExists: await Bun.file(docPath).exists(),
                        project: ctx.toplevel,
                        branch: ctx.branch,
                        cwd: ctx.cwd,
                        worktreeOf: ctx.mainProject || null,
                        worktree: null,
                        alternatives: [],
                        warnings: [],
                        registerHint: registerHint(ctx, docDir),
                        nextSteps: nextSteps({
                            found: true,
                            exact: true,
                            docExists: await Bun.file(docPath).exists(),
                            docPath,
                            registerCmd: registerHint(ctx, docDir),
                            entriesCmd: entriesHint(ctx),
                        }),
                    },
                    null,
                    2
                )
            );
            return;
        }

        console.log(
            // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
            JSON.stringify(
                {
                    found: false,
                    project: ctx.toplevel,
                    branch: ctx.branch,
                    cwd: ctx.cwd,
                    worktreeOf: ctx.mainProject || null,
                    registerHint: registerHint(ctx),
                    nextSteps: nextSteps({
                        found: false,
                        exact: false,
                        docExists: false,
                        docPath: "",
                        registerCmd: registerHint(ctx),
                        entriesCmd: entriesHint(ctx),
                    }),
                },
                null,
                2
            )
        );
        return;
    }

    const { entry } = ranked[0];
    const docPath = derivedDocPath(entry, ctx.branch);
    const docExists = await Bun.file(docPath).exists();
    const alternatives = ranked.slice(1);
    const exact = Boolean(entry.branch) && entry.branch === ctx.branch;
    // Only pre-fill the resolved directory once it is trustworthy: pre-filling a
    // doubtful match turns "confirm this" into a one-key rubber stamp of the
    // wrong target.
    const hint = registerHint(ctx, exact ? entry.obsidianDir : "<dir the user confirms>");
    console.log(
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        JSON.stringify(
            {
                found: true,
                source: "registry",
                exact,
                obsidianDir: entry.obsidianDir,
                docPath,
                docExists,
                project: ctx.toplevel,
                branch: ctx.branch,
                cwd: ctx.cwd,
                worktreeOf: ctx.mainProject || null,
                worktree: entry.worktreeDir ?? null,
                matchedEntry: entry,
                alternatives: alternatives.map(({ entry: alt, score }) => ({
                    obsidianDir: alt.obsidianDir,
                    docPath: derivedDocPath(alt, ctx.branch),
                    branch: alt.branch ?? null,
                    worktreeDir: alt.worktreeDir ?? null,
                    score,
                })),
                warnings: resolutionWarnings({ entry, ctx, alternatives, docExists }),
                registerHint: hint,
                nextSteps: nextSteps({
                    found: true,
                    exact,
                    docExists,
                    docPath,
                    registerCmd: hint,
                    entriesCmd: entriesHint(ctx),
                }),
            },
            null,
            2
        )
    );
}

/** Read-only registry audit: names every entry that can resolve wrong, and how
 * to fix it. Never mutates — a diagnostic that repairs would hide the cause. */
async function cmdDoctor() {
    const reg = await loadRegistry();
    const paths = new Set<string>();
    for (const e of reg.entries) {
        paths.add(e.projectDir);
        paths.add(e.obsidianDir);
        if (e.worktreeDir) {
            paths.add(e.worktreeDir);
        }
    }

    const present = new Set<string>();
    await Promise.all(
        [...paths].map(async (p) => {
            // Bun.file().exists() is false for directories, so stat instead.
            const ok = await stat(p).then(
                (info) => info.isDirectory(),
                () => false
            );
            if (ok) {
                present.add(p);
            }
        })
    );

    const issues = auditRegistry(reg.entries, (p) => present.has(p));
    console.log(
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        JSON.stringify(
            {
                registry: await registryPath(),
                entries: reg.entries.length,
                healthy: issues.length === 0,
                issues,
            },
            null,
            2
        )
    );
}

/** Every registry entry for this project, branch-matching or not — the menu to
 * offer the user when the top match is wrong or missing. */
async function cmdEntries(args: Record<string, string> = {}) {
    const ctx = await gitContext(args);
    const reg = await loadRegistry();
    const roots = [ctx.toplevel, ctx.mainProject].filter((p): p is string => Boolean(p));
    const forProject = reg.entries.filter(
        (e) => roots.includes(e.projectDir) || (e.worktreeDir !== undefined && roots.includes(e.worktreeDir))
    );

    console.log(
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        JSON.stringify(
            {
                project: ctx.toplevel,
                branch: ctx.branch,
                cwd: ctx.cwd,
                registry: await registryPath(),
                entries: forProject.map((e) => ({
                    obsidianDir: e.obsidianDir,
                    // Derive with the entry's OWN branch: showing a non-matching
                    // entry under the current branch's filename invents a path
                    // that entry would never produce.
                    docPath: derivedDocPath(e, e.branch || ctx.branch),
                    branch: e.branch ?? null,
                    worktreeDir: e.worktreeDir ?? null,
                    matchesCurrent: matches(e, ctx) > 0,
                })),
            },
            null,
            2
        )
    );
}

export function entryBranch(args: Record<string, string>, ctxBranch: string): string {
    // A branch-less entry claims every branch of the project forever, which is
    // how an old session's doc keeps winning months later. Pin the current branch
    // by default; `--all-branches` is the explicit opt-in to the catch-all.
    if (args.branch) {
        return args.branch;
    }

    return "all-branches" in args ? "" : ctxBranch;
}

async function cmdRegister(args: Record<string, string>) {
    const ctx = await gitContext(args);
    const branch = entryBranch(args, ctx.branch);
    const entry: Entry = {
        projectDir: ctx.toplevel,
        obsidianDir: expandHome(args.obsidian ?? ""),
        ...(branch ? { branch } : {}),
        ...(args.worktree ? { worktreeDir: expandHome(args.worktree) } : {}),
        ...(args.doc ? { docPath: expandHome(args.doc) } : {}),
    };

    if (!entry.obsidianDir) {
        console.error("register: --obsidian <dir> is required");
        process.exit(1);
    }

    if (!entry.branch) {
        // The catch-all is the single biggest source of wrong wrap-up targets, so
        // creating one says out loud what it will do to every future branch.
        console.error(
            [
                `wrap-up: registering a CATCH-ALL entry for ${entry.projectDir}.`,
                `  It will claim EVERY branch of that project, forever, including branches that do not exist yet.`,
                `  Prefer one entry per branch: drop --all-branches and the current branch is pinned for you.`,
                entry.docPath
                    ? `  With docPath set, every branch will also append into the same file: ${entry.docPath}`
                    : "",
            ]
                .filter(Boolean)
                .join("\n")
        );
    }

    const reg = await loadRegistry();
    // De-dupe on (projectDir, branch, worktreeDir).
    reg.entries = reg.entries.filter(
        (x) =>
            !(
                x.projectDir === entry.projectDir &&
                (x.branch ?? "") === (entry.branch ?? "") &&
                (x.worktreeDir ?? "") === (entry.worktreeDir ?? "")
            )
    );
    reg.entries.push(entry);
    await saveRegistry(reg);
    console.log(
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        JSON.stringify(
            { registered: entry, registry: await registryPath(), docPath: derivedDocPath(entry, ctx.branch) },
            null,
            2
        )
    );
}

async function cmdHere(file: string) {
    if (!file) {
        console.error("here: pass the wrap-up file path");
        process.exit(1);
    }

    const text = await Bun.file(file).text();
    const start = text.indexOf(HERE_START);
    const end = text.indexOf(HERE_END);
    if (start === -1 || end === -1) {
        console.error("here: no YOU-ARE-HERE block found");
        process.exit(1);
    }

    console.log(text.slice(start, end + HERE_END.length));
}

function nowStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function innerBlock(full: string): string {
    return full.replace(HERE_START, "").replace(HERE_END, "").trim();
}

export function blockquote(s: string): string {
    return s
        .split("\n")
        .map((l) => (l.length ? `> ${l}` : ">"))
        .join("\n");
}

const LOG_USAGE = `
Expected: pipe ONE heredoc split by two sentinel lines — @@HERE@@ (new state
bullets) then @@LOG@@ (the log-section body you author). Example:

  bun resolve.ts log "<docPath>" <<'WRAPUP'
  @@HERE@@
  - **Branch / worktree:** <branch> @ <abs path>
  - **State:** <what's done / mid-flight>
  - **Next:** <immediate next action>
  - **Verify:** <command that proves state>
  - **Read to resume:** <how much of the log to read>
  @@LOG@@
  ## <YYYY-MM-DD HH:MM> — <topic>  (commits <sha>, …)

  ### Goal & context
  ...
  WRAPUP

The script auto-stamps the datetime, rewrites the YOU-ARE-HERE block in place,
and auto-generates the "Header before → after" snapshot — don't write those.`;

function failLog(problem: string): never {
    console.error(`log: ${problem}\n${LOG_USAGE}`);
    process.exit(1);
}

export type SentinelSplit = { ok: true; hereBody: string; logBody: string } | { ok: false; problem: string };

export function splitSentinels(raw: string): SentinelSplit {
    const stdin = raw.trim();
    if (!stdin) {
        return { ok: false, problem: "nothing on stdin — you must pipe the @@HERE@@ / @@LOG@@ heredoc in" };
    }

    const hIdx = stdin.indexOf("@@HERE@@");
    const lIdx = stdin.indexOf("@@LOG@@");
    const missing = [hIdx === -1 && "@@HERE@@", lIdx === -1 && "@@LOG@@"].filter(Boolean);
    if (missing.length) {
        return { ok: false, problem: `stdin is missing sentinel line(s): ${missing.join(" and ")}` };
    }

    if (lIdx < hIdx) {
        return { ok: false, problem: "@@LOG@@ appears before @@HERE@@ — order must be @@HERE@@ first, then @@LOG@@" };
    }

    const hereBody = stdin.slice(hIdx + "@@HERE@@".length, lIdx).trim();
    const logBody = stdin.slice(lIdx + "@@LOG@@".length).trim();
    if (!hereBody && !logBody) {
        return { ok: false, problem: "both the @@HERE@@ and @@LOG@@ sections are empty" };
    }

    if (!hereBody) {
        return {
            ok: false,
            problem: "the @@HERE@@ section is empty — it needs the new 'You are here' state bullets",
        };
    }

    if (!logBody) {
        return {
            ok: false,
            problem: "the @@LOG@@ section is empty — it needs the log-section body (## datetime header + forensics)",
        };
    }

    return { ok: true, hereBody, logBody };
}

export type LineSpan = {
    count: number;
    lineFirst: number;
    lineLast: number;
    heading: string;
};

export type LogBuild =
    | { ok: true; body: string; lines: number; linesAdded: LineSpan; linesModified: LineSpan }
    | { ok: false; problem: string };

function lineAt(text: string, index: number): number {
    let line = 1;
    const limit = Math.min(Math.max(index, 0), text.length);
    for (let i = 0; i < limit; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
        }
    }

    return line;
}

function lineCount(text: string): number {
    if (text.length === 0) {
        return 0;
    }

    let n = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            n++;
        }
    }

    return text.endsWith("\n") ? n : n + 1;
}

function headingOf(block: string): string {
    for (const line of block.split("\n")) {
        if (line.startsWith("## ")) {
            return line;
        }
    }

    for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
            return trimmed;
        }
    }

    return "";
}

function spanFor(text: string, start: number, endExclusive: number, heading: string): LineSpan {
    const lo = Math.max(0, start);
    const hi = Math.max(lo, endExclusive);
    const lineFirst = lineAt(text, lo);
    const lineLast = lineAt(text, Math.max(lo, hi - 1));
    return {
        count: lineLast - lineFirst + 1,
        lineFirst,
        lineLast,
        heading,
    };
}

export function buildLogBody({
    text,
    hereBody,
    logBody,
    stamp,
}: {
    text: string;
    hereBody: string;
    logBody: string;
    stamp: string;
}): LogBuild {
    const s = text.indexOf(HERE_START);
    const e = text.indexOf(HERE_END);
    if (s === -1 || e === -1 || e < s) {
        return { ok: false, problem: `no valid ${HERE_START} … ${HERE_END} block` };
    }

    const oldFull = text.slice(s, e + HERE_END.length);
    const newFull = `${HERE_START}\n## You are here (${stamp})\n${hereBody}\n${HERE_END}`;
    const rewritten = text.slice(0, s) + newFull + text.slice(e + HERE_END.length);
    const section = [
        logBody,
        "",
        "### Header before → after",
        "",
        "**Before:**",
        "",
        blockquote(innerBlock(oldFull)),
        "",
        "**After:**",
        "",
        blockquote(innerBlock(newFull)),
    ].join("\n");
    const rewrittenTrimmed = rewritten.replace(/\s+$/, "");
    const body = `${rewrittenTrimmed}\n\n${section}\n`;
    const headerStart = body.indexOf(HERE_START);
    const headerEnd = body.indexOf(HERE_END);
    const addedStart = rewrittenTrimmed.length + 2;

    return {
        ok: true,
        body,
        lines: lineCount(body),
        linesModified: spanFor(body, headerStart, headerEnd + HERE_END.length, headingOf(newFull)),
        linesAdded: spanFor(body, addedStart, body.length, headingOf(section)),
    };
}

async function cmdLog(file: string) {
    if (!file) {
        failLog("no wrap-up file path given (first positional arg)");
    }

    const absFile = resolve(file);
    const f = Bun.file(absFile);
    if (!(await f.exists())) {
        failLog(
            `file does not exist: ${absFile}\n  → create it from the template with Write first, then use 'log' for every session after`
        );
    }

    const split = splitSentinels(await Bun.stdin.text());
    if (!split.ok) {
        failLog(split.problem);
    }

    const stamp = nowStamp();
    const built = buildLogBody({ text: await f.text(), hereBody: split.hereBody, logBody: split.logBody, stamp });
    if (!built.ok) {
        failLog(`${built.problem} in ${absFile} — is this a wrap-up file created from the template?`);
    }

    await writeAtomic(absFile, built.body);
    console.log(
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        JSON.stringify(
            {
                logged: true,
                file: absFile,
                stamp,
                lines: built.lines,
                linesAdded: built.linesAdded,
                linesModified: built.linesModified,
            },
            null,
            2
        )
    );
}

export function parseFlags(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) {
            const next = argv[i + 1];
            // A boolean flag (--all-branches) must not swallow the flag that
            // follows it, or `--all-branches --obsidian /vault` would silently
            // drop the target directory.
            const isBoolean = next === undefined || next.startsWith("--");
            out[argv[i].slice(2)] = isBoolean ? "" : next;
            if (!isBoolean) {
                i++;
            }
        }
    }
    return out;
}

// Guarded so the pure helpers above can be imported by tests without the CLI
// dispatcher running (and calling process.exit) on import.
if (import.meta.main) {
    const [cmd, ...rest] = process.argv.slice(2);
    switch (cmd) {
        case "resolve":
            await cmdResolve(parseFlags(rest));
            break;
        case "entries":
            await cmdEntries(parseFlags(rest));
            break;
        case "doctor":
            await cmdDoctor();
            break;
        case "register":
            await cmdRegister(parseFlags(rest));
            break;
        case "here":
            await cmdHere(rest[0]);
            break;
        case "log":
            await cmdLog(rest[0]);
            break;
        default:
            console.error(
                [
                    "usage: resolve.ts <command>",
                    "",
                    "  resolve  [--project <dir>] [--branch <b>] [--cwd <dir>]",
                    "           where does the wrap-up doc live? Pin --project to the repo the session",
                    "           actually worked in; without it the ambient shell cwd decides. Any path",
                    "           inside the checkout works (subdirectory or worktree). The result carries",
                    "           `warnings` and `nextSteps` — read them before writing anything.",
                    "  entries  [--project <dir>]   every registered target for that project",
                    "  doctor                       audit the registry for entries that resolve wrong",
                    "  register --obsidian <dir> [--project p] [--branch b | --all-branches] [--worktree w] [--doc path]",
                    "           branch defaults to the current one; --all-branches makes a catch-all",
                    "  here     <file>              print only the YOU-ARE-HERE block",
                    "  log      <file>              stdin: @@HERE@@ … @@LOG@@ …",
                ].join("\n")
            );
            process.exit(1);
    }
}
