#!/usr/bin/env bun

/**
 * wrap-up target resolver.
 *
 * Owns the deterministic half of "where does the wrap-up doc live?":
 *   - resolve : match the current project/branch/worktree against the registry,
 *               print the obsidian dir + the derived doc path (or found:false).
 *   - register: append/update a registry entry after the user confirms a target.
 *   - here    : print ONLY the YOU-ARE-HERE block of a wrap-up file (cheap read).
 *   - log     : atomically append a log section AND rewrite the YOU-ARE-HERE block,
 *               auto-stamping the datetime and auto-generating the before→after
 *               snapshot from the outgoing header. stdin carries two parts split by
 *               sentinel lines: @@HERE@@ (new state bullets) then @@LOG@@ (log body).
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

import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const PLUGIN_CONFIG = join(homedir(), ".genesis-tools", "plugins", "config.json");
const HERE_START = "<!-- YOU-ARE-HERE:START -->";
const HERE_END = "<!-- YOU-ARE-HERE:END -->";

interface Entry {
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

async function loadPluginConfig(): Promise<WrapUpConfig> {
    const f = Bun.file(PLUGIN_CONFIG);
    if (!(await f.exists())) {
        return {};
    }

    try {
        const parsed = JSON.parse(await f.text());
        return typeof parsed?.["wrap-up"] === "object" && parsed["wrap-up"] !== null ? parsed["wrap-up"] : {};
    } catch (err) {
        // Falling back to {} silently would make a corrupt config look like an
        // absent one and quietly demote the wrap-up to a different target tier.
        console.error(`wrap-up: ignoring unreadable plugin config ${PLUGIN_CONFIG}: ${String(err)}`);
        return {};
    }
}

function expandHome(p: string): string {
    return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function registryPath(): Promise<string> {
    const cfg = await loadPluginConfig();
    return expandHome(cfg.registryPath ?? join(homedir(), ".claude", "handoff-registry.json"));
}

async function sh(cmd: string[]): Promise<string> {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
}

async function loadRegistry(): Promise<Registry> {
    const path = await registryPath();
    const f = Bun.file(path);
    if (!(await f.exists())) {
        return { entries: [] };
    }

    try {
        const parsed = JSON.parse(await f.text());
        return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
    } catch (err) {
        // A malformed registry must not masquerade as an empty one — that would
        // silently drop every registered target and resolve to found:false.
        console.error(`wrap-up: ignoring unreadable registry ${path}: ${String(err)}`);
        return { entries: [] };
    }
}

async function saveRegistry(reg: Registry): Promise<void> {
    await Bun.write(await registryPath(), `${JSON.stringify(reg, null, 2)}\n`);
}

function slug(s: string): string {
    return (
        s
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "main"
    );
}

function derivedDocPath(entry: Entry, branch: string): string {
    if (entry.docPath) {
        return entry.docPath;
    }

    const project = basename(entry.projectDir);
    return join(entry.obsidianDir, `${project}-${slug(branch)}.wrapup.md`);
}

async function gitContext() {
    const toplevel = await sh(["git", "rev-parse", "--show-toplevel"]);
    const branch = await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    // In a worktree, common-dir differs from git-dir; the "main" checkout's
    // toplevel is what a project-level entry keys on.
    const cwd = process.cwd();
    return { toplevel: toplevel || cwd, branch: branch || "", cwd };
}

function matches(entry: Entry, ctx: { toplevel: string; branch: string; cwd: string }): number {
    // Higher score = more specific match. 0 = no match.
    const paths = [entry.worktreeDir, entry.projectDir].filter(Boolean) as string[];
    const pathHit = paths.some((p) => ctx.toplevel === p || ctx.cwd === p || ctx.cwd.startsWith(`${p}/`));
    if (!pathHit) {
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

async function cmdResolve() {
    const ctx = await gitContext();
    const reg = await loadRegistry();
    const ranked = reg.entries
        .map((e) => ({ e, score: matches(e, ctx) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

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
            console.log(
                JSON.stringify(
                    {
                        found: true,
                        source: "config",
                        obsidianDir: docDir,
                        docPath: derivedDocPath(entry, ctx.branch),
                        project: ctx.toplevel,
                        branch: ctx.branch,
                        worktree: null,
                    },
                    null,
                    2
                )
            );
            return;
        }

        console.log(JSON.stringify({ found: false, project: ctx.toplevel, branch: ctx.branch, cwd: ctx.cwd }, null, 2));
        return;
    }

    const { e } = ranked[0];
    console.log(
        JSON.stringify(
            {
                found: true,
                source: "registry",
                obsidianDir: e.obsidianDir,
                docPath: derivedDocPath(e, ctx.branch),
                project: ctx.toplevel,
                branch: ctx.branch,
                worktree: e.worktreeDir ?? null,
            },
            null,
            2
        )
    );
}

async function cmdRegister(args: Record<string, string>) {
    const ctx = await gitContext();
    const entry: Entry = {
        projectDir: args.project ?? ctx.toplevel,
        obsidianDir: args.obsidian,
        ...(args.branch ? { branch: args.branch } : {}),
        ...(args.worktree ? { worktreeDir: args.worktree } : {}),
        ...(args.doc ? { docPath: args.doc } : {}),
    };

    if (!entry.obsidianDir) {
        console.error("register: --obsidian <dir> is required");
        process.exit(1);
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

function innerBlock(full: string): string {
    return full.replace(HERE_START, "").replace(HERE_END, "").trim();
}

function blockquote(s: string): string {
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

async function cmdLog(file: string) {
    if (!file) {
        failLog("no wrap-up file path given (first positional arg)");
    }

    const f = Bun.file(file);
    if (!(await f.exists())) {
        failLog(
            `file does not exist: ${file}\n  → create it from the template with Write first, then use 'log' for every session after`
        );
    }

    const stdin = (await Bun.stdin.text()).trim();
    if (!stdin) {
        failLog("nothing on stdin — you must pipe the @@HERE@@ / @@LOG@@ heredoc in");
    }

    const hIdx = stdin.indexOf("@@HERE@@");
    const lIdx = stdin.indexOf("@@LOG@@");
    const missing = [hIdx === -1 && "@@HERE@@", lIdx === -1 && "@@LOG@@"].filter(Boolean);
    if (missing.length) {
        failLog(`stdin is missing sentinel line(s): ${missing.join(" and ")}`);
    }

    if (lIdx < hIdx) {
        failLog("@@LOG@@ appears before @@HERE@@ — order must be @@HERE@@ first, then @@LOG@@");
    }

    const hereBody = stdin.slice(hIdx + "@@HERE@@".length, lIdx).trim();
    const logBody = stdin.slice(lIdx + "@@LOG@@".length).trim();
    if (!hereBody && !logBody) {
        failLog("both the @@HERE@@ and @@LOG@@ sections are empty");
    }

    if (!hereBody) {
        failLog("the @@HERE@@ section is empty — it needs the new 'You are here' state bullets");
    }

    if (!logBody) {
        failLog("the @@LOG@@ section is empty — it needs the log-section body (## datetime header + forensics)");
    }

    const text = await f.text();
    const s = text.indexOf(HERE_START);
    const e = text.indexOf(HERE_END);
    if (s === -1 || e === -1 || e < s) {
        failLog(
            `no valid ${HERE_START} … ${HERE_END} block in ${file} — is this a wrap-up file created from the template?`
        );
    }

    const oldFull = text.slice(s, e + HERE_END.length);
    const stamp = nowStamp();
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

    const body = `${rewritten.replace(/\s+$/, "")}\n\n${section}\n`;
    await Bun.write(file, body);
    console.log(JSON.stringify({ logged: file, stamp }, null, 2));
}

function parseFlags(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) {
            out[argv[i].slice(2)] = argv[i + 1] ?? "";
            i++;
        }
    }
    return out;
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
    case "resolve":
        await cmdResolve();
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
            "usage: resolve.ts <resolve | register --obsidian <dir> [--branch b] [--worktree w] [--project p] [--doc path] | here <file> | log <file>  (log reads stdin: @@HERE@@ … @@LOG@@ …)>"
        );
        process.exit(1);
}
