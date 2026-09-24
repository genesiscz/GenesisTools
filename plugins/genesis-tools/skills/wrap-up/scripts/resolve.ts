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
 * The registry lives at ~/.genesis-tools/plugins/vault-registry.json, shared with the research
 * skill, and is migrated once from ~/.claude/handoff-registry.json:
 *   { "entries": [ { projectDir, branch?, worktreeDir?, obsidianDir, docPath? }, ... ] }
 * A missing/empty `branch` means the entry matches any branch in that project. An entry pins a
 * FOLDER, never a filename: `--doc <name>` picks any file inside it, and the derived
 * <project>-<branch>.wrapup.md is only the default when the caller names nothing.
 *
 * Shared plugin config lives at ~/.genesis-tools/plugins/config.json, one key per plugin:
 *   { "wrap-up": { "registryPath"?, "vaultDir"?, "docDir"? } }
 *   - registryPath: overrides the registry location.
 *   - docDir: fallback doc directory when the registry has no match — absolute,
 *     or relative to the project toplevel (e.g. ".claude/wrapups").
 *   - vaultDir: vault root; fallback target becomes <vaultDir>/<projectName>.
 *   Resolution order: registry match > docDir > vaultDir > found:false.
 */

import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
    ambientBranchWarnings,
    type Ctx,
    parsePorcelainMain,
    parsePorcelainWorktrees,
    gitContext as sharedGitContext,
    sh as sharedSh,
    type Worktree,
} from "../../../lib/git-context.ts";
// lint-rules-ignore: standalone script without access to @genesiscz/utils/env
import { expandHome, pluginSection, writeAtomic } from "../../../lib/plugin-config.ts";
import { loadProjectOverrides, resolveOverride } from "../../../lib/project-overrides.ts";
import {
    type Entry,
    forConsumer,
    loadRegistry as loadRegistryFile,
    matches,
    type Ranked,
    type Registry,
    rankEntries,
    registryPath as resolveRegistryPath,
    saveRegistry as saveRegistryFile,
} from "../../../lib/vault-registry.ts";

// Re-exported because they were this module's own helpers before the shared lib existed.
export {
    ambientBranchWarnings,
    type Ctx,
    type Entry,
    expandHome,
    matches,
    parsePorcelainMain,
    parsePorcelainWorktrees,
    type Ranked,
    rankEntries,
    type Worktree,
    writeAtomic,
};

export const sh = (cmd: string[]): Promise<string> => sharedSh(cmd, "wrap-up");

const CONSUMER = "wrap-up";
const HERE_START = "<!-- YOU-ARE-HERE:START -->";
const HERE_END = "<!-- YOU-ARE-HERE:END -->";

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

    const cfg = await pluginSection<WrapUpConfig>("wrap-up");
    pluginConfigCache = cfg;
    return cfg;
}

// The registry moved out of ~/.claude (Claude-only, while these skills are read by Codex and
// Grok too) and out of wrap-up's sole ownership: research resolves the same project-to-vault
// folders. One migration per install, before the first read or write of either path.
async function registryPath(): Promise<string> {
    return resolveRegistryPath((await loadPluginConfig()).registryPath, "wrap-up");
}

async function loadRegistry(): Promise<Registry> {
    return loadRegistryFile(await registryPath(), "wrap-up");
}

async function saveRegistry(reg: Registry): Promise<void> {
    await saveRegistryFile(await registryPath(), reg);
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

const gitContext = (args: Record<string, string> = {}): Promise<Ctx> => sharedGitContext(args, "wrap-up");

/** One line naming the logs already in the folder, so a second one is a decision, not an accident. */
export function siblingWarning(siblingDocs: string[], dir: string): string[] {
    if (siblingDocs.length === 0) {
        return [];
    }

    return [
        `${dir} already holds ${siblingDocs.length} wrap-up file${siblingDocs.length === 1 ? "" : "s"} under other names (${siblingDocs.join(", ")}) — append to one of those with --doc <name> unless this branch genuinely needs its own log`,
    ];
}

/**
 * Wrap-up files already sitting in the resolved folder under another name.
 *
 * The derived `<project>-<branch>.wrapup.md` is only a default, and 14 of this vault's ticket
 * folders hold a log named something else, usually because a human named it or it predates the
 * convention. Creating the derived name there would quietly start a SECOND log for the same
 * work, which is worse than either name on its own.
 */
export async function existingWrapUps(dir: string, docPath: string): Promise<string[]> {
    try {
        const found: string[] = [];

        for await (const name of new Bun.Glob("*.wrapup.md").scan({ cwd: dir, onlyFiles: true })) {
            if (join(dir, name) !== docPath) {
                found.push(name);
            }
        }

        return found.sort();
    } catch {
        // A missing or unreadable folder is the "first wrap-up here" case, not an error.
        return [];
    }
}

export type DocPathSource = "pinned" | "entry" | "derived";

/**
 * Resolve the file inside the matched folder, saying where the choice came from.
 *
 * A bare `--doc notes.md` lands in the matched folder; an absolute path is taken as given.
 * Nothing about the registry forces one file per branch: the entry pins a directory, and the
 * derived `<project>-<branch>.wrapup.md` is only the default when the caller names nothing.
 */
export function resolveDocPath(
    entry: Entry,
    ctx: Ctx,
    doc?: string
): { docPath: string; docPathSource: DocPathSource } {
    if (doc) {
        const expanded = expandHome(doc);

        return {
            docPath: isAbsolute(expanded) ? expanded : join(entry.obsidianDir, expanded),
            docPathSource: "pinned",
        };
    }

    return {
        docPath: derivedDocPath(entry, ctx.branch),
        docPathSource: entry.docPath ? "entry" : "derived",
    };
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
    docPathSource = "derived",
    siblingDocs = [],
}: {
    entry: Entry;
    ctx: Ctx;
    alternatives: Ranked[];
    docExists: boolean;
    /** Where the doc path came from, so a defaulted filename is never read as a pinned one. */
    docPathSource?: DocPathSource;
    /** Other `*.wrapup.md` files already in the folder, so a second log is never started by accident. */
    siblingDocs?: string[];
}): string[] {
    const warnings: string[] = [...ambientBranchWarnings(ctx), ...siblingWarning(siblingDocs, entry.obsidianDir)];

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
        warnings.push(
            docPathSource === "derived"
                ? // The entry pins the FOLDER; this filename is only the per-branch default, and
                  // nothing says one branch means one file. Say so at the only moment it is
                  // actionable: before the file exists and the name is still free.
                  `docPath does not exist yet — create it from the SKILL.md template before calling \`log\`. The registry pins the folder, so "${basename(derivedDocPath(entry, ctx.branch))}" is only the default name for branch "${ctx.branch}": pass --doc <name> to use another file in ${entry.obsidianDir}`
                : "docPath does not exist yet — create it from the SKILL.md template before calling `log`"
        );
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
            "3. Infer the vault layout with one or two `ls` calls, then ask the user to confirm the directory (AskUserQuestion / request_user_input_async / ask_user_question, whichever your harness has).",
            `4. Pin the confirmed directory so it is never asked again: ${registerCmd}`,
            "5. Create the doc from the SKILL.md template, then append with `log`.",
        ];
    }

    const steps: string[] = [];
    if (!exact) {
        steps.push(
            `1. Do not write yet. No entry claims this branch specifically, so show the user this docPath plus "alternatives" and let them confirm (AskUserQuestion / request_user_input_async / ask_user_question, whichever your harness has). Full list: ${entriesCmd}`,
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
    // A project may declare its own folder for wrap-up, static or derived per ticket. It is
    // more specific than any registry entry, so it is asked first.
    const override = await resolveOverride({
        overrides: await loadProjectOverrides(CONSUMER),
        ctx,
        consumer: CONSUMER,
        label: CONSUMER,
    });

    if (override.kind === "failed") {
        console.log(
            JSON.stringify(
                {
                    found: false,
                    source: "resolver",
                    project: ctx.toplevel,
                    branch: ctx.branch,
                    cwd: ctx.cwd,
                    rule: override.rule ?? null,
                    resolver: { project: override.key, command: override.command },
                    warnings: [
                        ...ambientBranchWarnings(ctx),
                        `${override.error} — this project declares a resolverCommand for wrap-up, so do NOT fall back to the registry: fix the resolver or register a folder`,
                    ],
                },
                null,
                2
            )
        );
        process.exitCode = 1;

        return;
    }

    if (override.kind === "resolver" || override.kind === "dir") {
        // The MAIN checkout names the derived file, so every worktree of one project agrees on
        // it instead of each inventing a name from its own directory.
        const entry: Entry = { projectDir: ctx.mainProject || ctx.toplevel, obsidianDir: override.dir };
        const { docPath, docPathSource } = resolveDocPath(entry, ctx, args.doc);
        const docExists = await Bun.file(docPath).exists();
        const siblingDocs = docExists ? [] : await existingWrapUps(override.dir, docPath);
        const hint = registerHint(ctx, override.dir);

        console.log(
            JSON.stringify(
                {
                    found: true,
                    source: override.kind === "resolver" ? "resolver" : "override",
                    exact: true,
                    obsidianDir: override.dir,
                    docPath,
                    docPathSource,
                    docExists,
                    project: ctx.toplevel,
                    branch: ctx.branch,
                    cwd: ctx.cwd,
                    worktreeOf: ctx.mainProject || null,
                    worktree: null,
                    rule: override.rule ?? null,
                    ...(override.kind === "resolver"
                        ? { resolver: { project: override.key, command: override.command, output: override.output } }
                        : {}),
                    alternatives: [],
                    warnings: [
                        ...ambientBranchWarnings(ctx),
                        ...override.warnings,
                        ...(docExists
                            ? []
                            : [
                                  "docPath does not exist yet — create it from the SKILL.md template before calling `log`",
                              ]),
                        ...siblingWarning(siblingDocs, override.dir),
                    ],
                    registerHint: hint,
                    nextSteps: nextSteps({
                        found: true,
                        exact: true,
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

        return;
    }

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
            const { docPath, docPathSource } = resolveDocPath(entry, ctx, args.doc);
            console.log(
                JSON.stringify(
                    {
                        found: true,
                        source: "config",
                        // The config fallback derives a per-branch filename, so it is
                        // branch-exact by construction.
                        exact: true,
                        obsidianDir: docDir,
                        docPath,
                        docPathSource,
                        docExists: await Bun.file(docPath).exists(),
                        project: ctx.toplevel,
                        branch: ctx.branch,
                        cwd: ctx.cwd,
                        worktreeOf: ctx.mainProject || null,
                        worktree: null,
                        alternatives: [],
                        warnings: ambientBranchWarnings(ctx),
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

    const entry = forConsumer(ranked[0].entry, CONSUMER);
    const { docPath, docPathSource } = resolveDocPath(entry, ctx, args.doc);
    const docExists = await Bun.file(docPath).exists();
    const siblingDocs = docExists ? [] : await existingWrapUps(entry.obsidianDir, docPath);
    const alternatives = ranked.slice(1);
    const exact = Boolean(entry.branch) && entry.branch === ctx.branch;
    // Only pre-fill the resolved directory once it is trustworthy: pre-filling a
    // doubtful match turns "confirm this" into a one-key rubber stamp of the
    // wrong target.
    const hint = registerHint(ctx, exact ? entry.obsidianDir : "<dir the user confirms>");
    console.log(
        JSON.stringify(
            {
                found: true,
                source: "registry",
                exact,
                obsidianDir: entry.obsidianDir,
                docPath,
                docPathSource,
                docExists,
                project: ctx.toplevel,
                branch: ctx.branch,
                cwd: ctx.cwd,
                worktreeOf: ctx.mainProject || null,
                worktree: entry.worktreeDir ?? null,
                matchedEntry: entry,
                alternatives: alternatives.map(({ entry: raw, score }) => ({
                    obsidianDir: forConsumer(raw, CONSUMER).obsidianDir,
                    docPath: derivedDocPath(forConsumer(raw, CONSUMER), ctx.branch),
                    branch: raw.branch ?? null,
                    worktreeDir: raw.worktreeDir ?? null,
                    score,
                })),
                warnings: resolutionWarnings({ entry, ctx, alternatives, docExists, docPathSource, siblingDocs }),
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
        JSON.stringify(
            {
                project: ctx.toplevel,
                branch: ctx.branch,
                cwd: ctx.cwd,
                registry: await registryPath(),
                entries: forProject
                    .map((raw) => forConsumer(raw, CONSUMER))
                    .map((e) => ({
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
