// The /tmp row: what this session keeps on disk and the free space on the system disk, every `mods.tmpUsage.minutes`.
// The session's share is its scratch folder (`/tmp/cc/<project>/<session>`), Claude Code's task output for it
// (`/tmp/claude-<uid>/<project folder>/<session>`), and the git worktrees it made: one its subagents got
// (`isolation: "worktree"`, named in their `.meta.json`), one under its scratch folder's `worktrees/`, or one locked
// to it (`hooks/worktree-lock.ts` in the genesis-tools plugin). A worktree held 3.6 GB where the scratch folder held
// 392 MB (2026-10-23), so a row that counted the folder alone read ten times too small. All of /tmp/cc is not
// measured: `du` over it took 75 s and 38 s of system CPU at 67 GB, too much for a band; `du` over one worktree took
// 2 s. A press on the row opens the Session files sidebar. Each reading goes to `mods-log/tmp.jsonl`.
import type { ElementTable, RenderElement } from "claude-code";
import type { SessionWorktree, TmpReading, TmpUsage } from "../types";
import { sessionDirOf } from "./agents-band";
import { genesisProbe } from "./genesis";
import { liveAgo } from "./live";
import { bareDescription } from "./model-label";
import { type Feature, type Host, isRecord, logMod, paceAfter, settingsOf } from "./shared";
import { cliLacks } from "./shared-run";
import { actionButton, type Kit, line, type Pressable, plural, pressed, sidebarFrame } from "./sidebar";

let usage: TmpUsage = null;
let measuring: Promise<void> | undefined;
const LOW_FREE_KB = 10 * 1024 * 1024;
export const TMP_PANE = "mods-tmp";

/**
 * A shell command that moves a folder by more than an edit does: a package install or removal, a build, a worktree or
 * branch move, a clean, a recursive removal or move, an archive extraction. No age can cover these: a walk at 12:00:00
 * and `bun install` at 12:00:05 would show a size gigabytes too small for the whole age.
 */
const CHANGES_SIZE = new RegExp(
    [
        String.raw`\b(?:bun|npm|pnpm|yarn)\s+(?:install|i|ci|add|remove|rm|uninstall|update|upgrade)\b`,
        String.raw`\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\b`,
        String.raw`\b(?:next|vite|expo|metro|swift|cargo)\s+build\b`,
        String.raw`\bpod\s+install\b`,
        String.raw`(?:^|[;&|(]\s*)(?:(?:tsc|tsgo)\b(?![^;&|]*--noEmit)|xcodebuild\b|make\b)`,
        String.raw`\bgit\s+(?:-C\s+\S+\s+)?(?:worktree\s+(?:add|remove|prune)|clone|checkout|switch|clean|stash\s+pop)\b`,
        String.raw`\btools\s+rm\b`,
        String.raw`\brm\s+-\w*[rR]`,
        String.raw`(?:^|[;&|(]\s*)mv\s`,
        String.raw`\btar\s+-?\w*x|\b(?:unzip|ditto)\b`,
    ].join("|")
);

export function changesSize(command: string): boolean {
    return CHANGES_SIZE.test(command);
}

/** How long after the last size-changing command the walk waits, so five installs in a row cost one walk. */
const TRIGGER_DEBOUNCE_MS = 10_000;
/** Folders a size-changing command touched, with when the last such command ended; walked once the debounce passed. */
const staleSince = new Map<string, number>();
let staleDueAt = 0;
/** Folders the next reading walks whatever their pace says: accept only a size measured after this time. */
const forcedSince = new Map<string, number>();
/** Folders waiting for or inside a triggered walk: the sidebar says "measuring…" instead of an old size. */
const walking = new Set<string>();
/** When each folder's size was measured. `isBound`: a shared answer at most that old, not an exact time. */
const sizeAges = new Map<string, { at: number; isBound: boolean }>();

/** Marks folders a size-changing command ran in; each new mark moves the walk 10 s further out. */
export function markSizeStale(paths: readonly string[], at = Date.now()): void {
    for (const path of paths) {
        staleSince.set(path, at);
        walking.add(path);
    }

    staleDueAt = at + TRIGGER_DEBOUNCE_MS;
}

/** Moves the marks whose debounce has passed to the next reading. True when there is a walk to run. */
export function takeDueStale(now = Date.now()): boolean {
    if (staleSince.size === 0 || now < staleDueAt) {
        return false;
    }

    for (const [path, since] of staleSince) {
        forcedSince.set(path, since);
    }

    staleSince.clear();

    return true;
}

/** `12m ago`, `≤30m ago` for a shared answer, `measuring…` while a triggered walk is due; undefined before a reading. */
export function sizeAgeText(path: string, now = Date.now()): string | undefined {
    if (walking.has(path)) {
        return "measuring…";
    }

    const age = sizeAges.get(path);

    if (!age) {
        return undefined;
    }

    const text = liveAgo(age.at, { unit: "minute", now });

    return age.isBound ? `≤${text}` : text;
}

async function kbOf(host: Host, argv: string[], column: number): Promise<number | null> {
    const done = await host.run(argv, { timeoutMs: 60_000 }).catch(() => undefined);
    const lines = done?.stdout.trim().split("\n") ?? [];
    const token = lines[lines.length - 1]?.trim().split(/\s+/)[column] ?? "";
    const value = Number(token);

    return done?.exitCode === 0 && /^\d+$/.test(token) && Number.isFinite(value) ? value : null;
}

/** `du -sk <path>`, leaving out every folder named in `skip` (a basename mask, `du -I`). */
async function folderKb(host: Host, path: string, skip: readonly string[] = []): Promise<number | null> {
    const masks = skip.flatMap((name) => ["-I", name]);

    return (await host.exists(path)) ? kbOf(host, ["du", "-sk", ...masks, path], 0) : 0;
}

/**
 * A folder of this session's own (scratch, task output), walked again after 5 minutes (ten times the walk's length
 * when that is longer), or about 10 s after a command that changes its size (`markSizeStale`). Its mtime does not
 * trigger a walk: a scratch folder that collects logs changes it on every write, and on 2026-10-28 that made 27 walks
 * of one 1.4 GB scratch folder in 30 minutes (31 s). The worktrees inside it are left out (`skip`): the worktree rule
 * measures them.
 */
async function pacedKb(host: Host, path: string, skip: readonly string[] = []): Promise<number | null> {
    if (!(await host.exists(path))) {
        return 0;
    }

    const held = folderKbs.get(path);
    const startedAt = Date.now();
    const mark = skip.join("\n");

    if (held && held.mark === mark && startedAt < held.nextAt && !forcedSince.has(path)) {
        return held.kb;
    }

    const kb = await folderKb(host, path, skip);
    folderKbs.set(path, { kb, mark, nextAt: paceAfter(SESSION_FOLDER_EVERY_MS, startedAt) });
    forcedSince.delete(path);
    walking.delete(path);
    sizeAges.set(path, { at: startedAt, isBound: false });

    return kb;
}

/**
 * `tools du size <path> --max-cache-age <s>`: the size another caller measured within the age, or a new walk.
 * `walked`: the answer took over a second, so it was this walk's (a shared answer takes about 140 ms).
 */
async function sharedKb(host: Host, path: string, maxAgeS: number): Promise<{ kb: number | null; walked: boolean }> {
    const startedAt = Date.now();
    const kb = await sharedKbOnly(host, path, maxAgeS);

    return { kb, walked: Date.now() - startedAt > 1_000 };
}

/**
 * The probe of a CLI that turned out to have no `tools du size`: the session walks with `du` until the probe is read
 * again (a new probe can be a newer CLI).
 */
let duSizeMissingIn: object | undefined;

async function sharedKbOnly(host: Host, path: string, maxAgeS: number): Promise<number | null> {
    const done = await host
        .run(["tools", "du", "size", path, "--max-cache-age", String(maxAgeS)], { timeoutMs: 120_000 })
        .catch(() => undefined);

    if (cliLacks(done)) {
        duSizeMissingIn = await genesisProbe(host);
        await logMod(host, "tmp", { event: "du-size-unsupported", stderr: done?.stderr.slice(-200) });

        return folderKb(host, path);
    }

    try {
        const sizes: unknown = done?.exitCode === 0 ? JSON.parse(done.stdout) : undefined;
        const kb = isRecord(sizes) ? sizes[path] : undefined;

        return typeof kb === "number" ? kb : null;
    } catch {
        return null;
    }
}

/** A worktree's last size, the git status it was measured at, and when `du` may walk it again. */
const worktreeKb = new Map<string, { kb: number | null; status: string; nextAt: number }>();
/** The same for the session's own folders, keyed by the worktree names left out of the walk. */
const folderKbs = new Map<string, { kb: number | null; mark: string; nextAt: number }>();
const WORKTREE_EVERY_MS = 30 * 60_000;
const SESSION_FOLDER_EVERY_MS = 5 * 60_000;
/**
 * At most one size refresh of an already measured worktree per this interval in a session, and each next refresh at a
 * random point of 25 to 35 minutes: on 2026-10-27 one session walked its five worktrees back to back (6 s each)
 * because all five expired together, and that minute was the Mac's spawn storm.
 */
const REFRESH_GAP_MS = 60_000;
/** The oldest shared size a worktree whose git status changed accepts. */
const STATUS_CHANGED_MAX_AGE_S = 300;
let lastRefreshAt = 0;

function nextWorktreeAt(startedAt: number): number {
    return paceAfter(WORKTREE_EVERY_MS * (0.83 + Math.random() * 0.34), startedAt);
}

/**
 * The oldest size `tools du size` may answer for a worktree, in seconds. `tools du size` shares one answer with every
 * caller on the Mac. A changed git status asks for a walk at most 5 minutes old, never a forced one: the status is the
 * whole porcelain with its branch line, so every edit or commit in a busy worktree changes it, and on 2026-10-28
 * sessions watching the same web app worktree forced 10 full walks of it (78 s) in an hour. A walk another session made
 * in those 5 minutes already counts the change.
 */
export function worktreeMaxAgeS(held: { status: string } | undefined, status: string): number {
    return held && held.status !== status ? STATUS_CHANGED_MAX_AGE_S : WORKTREE_EVERY_MS / 1000;
}

/**
 * A worktree's size, walked again only when its git status changed or 30 minutes passed (ten times the walk's length
 * when that is longer). `du` on a 5-6 GB web app worktree took 3 to 17 s on a full disk (2026-10-27), and one session
 * walked eight of them every 5 minutes.
 */
export async function worktreeSize(host: Host, path: string, status: string): Promise<number | null> {
    await restoreWorktreeKb(host);
    const held = worktreeKb.get(path);
    const startedAt = Date.now();
    const forced = forcedSince.get(path);

    if (forced === undefined && held && held.status === status && startedAt < held.nextAt) {
        return held.kb;
    }

    // A first measure always runs; a refresh waits its turn, so a session's worktrees never walk in one burst.
    if (forced === undefined && held && startedAt - lastRefreshAt < REFRESH_GAP_MS) {
        return held.kb;
    }

    if (held) {
        lastRefreshAt = startedAt;
    }

    // After a size-changing command, only a walk made after it counts, this session's or another's.
    const maxAge =
        forced === undefined ? worktreeMaxAgeS(held, status) : Math.max(1, Math.ceil((startedAt - forced) / 1000));
    const probe = await genesisProbe(host);
    const shared =
        probe.tools && probe !== duSizeMissingIn
            ? await sharedKb(host, path, maxAge)
            : { kb: await folderKb(host, path), walked: true };
    const kb = shared.kb;
    forcedSince.delete(path);
    walking.delete(path);

    if (kb !== null) {
        sizeAges.set(
            path,
            shared.walked ? { at: startedAt, isBound: false } : { at: startedAt - maxAge * 1000, isBound: true }
        );
        worktreeKb.set(path, { kb, status, nextAt: nextWorktreeAt(startedAt) });
        await host
            .storeSet(WORKTREE_STORE_KEY, Object.fromEntries([...worktreeKb].slice(-WORKTREE_STORE_KEEP)))
            .catch(() => undefined);
    }

    return kb;
}

/**
 * The sizes survive a mods reload through the mods store. Every save of a mod file reloads all sessions, and each one
 * then measured every worktree again in the same minute (23:24 on 2026-10-27: 28 walks, 33 s).
 */
const WORKTREE_STORE_KEY = "tmpUsage.worktreeKb";
const WORKTREE_STORE_KEEP = 40;
let worktreeKbRestored = false;

async function restoreWorktreeKb(host: Host): Promise<void> {
    if (worktreeKbRestored) {
        return;
    }

    worktreeKbRestored = true;
    const stored = await host.storeGet(WORKTREE_STORE_KEY).catch(() => undefined);

    if (!isRecord(stored)) {
        return;
    }

    for (const [path, entry] of Object.entries(stored)) {
        if (
            isRecord(entry) &&
            typeof entry.kb === "number" &&
            typeof entry.status === "string" &&
            typeof entry.nextAt === "number" &&
            !worktreeKb.has(path)
        ) {
            worktreeKb.set(path, { kb: entry.kb, status: entry.status, nextAt: entry.nextAt });
        }
    }
}

/** The main checkout's folder name, so every worktree of one repository shares its /tmp/cc project folder. */
async function projectOf(host: Host): Promise<string> {
    const cwd = await host.cwd();
    const done = await host
        .run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 5_000 })
        .catch(() => undefined);
    const common = done?.exitCode === 0 ? done.stdout.trim() : "";
    const main = common.endsWith("/.git") ? common.slice(0, -5) : cwd;

    return main.split("/").filter(Boolean).pop() ?? "unknown";
}

/** `/private/tmp/x` and `/tmp/x` are one folder; git prints the first, the scratch convention writes the second. */
export function samePath(path: string): string {
    return path.replace(/^\/private(?=\/tmp\/)/, "").replace(/\/+$/, "");
}

/** The worktrees `git worktree list --porcelain` names as locked by this session (`… session <id> …`). */
export function lockedToSession(porcelain: string, sessionId: string): string[] {
    return porcelain
        .split("\n\n")
        .map((block) => {
            const path = /^worktree (.+)$/m.exec(block)?.[1];
            const reason = /^locked (.*)$/m.exec(block)?.[1] ?? "";

            return path && reason.includes(`session ${sessionId}`) ? samePath(path) : undefined;
        })
        .filter((path): path is string => path !== undefined);
}

/** The branch and the count of changed files from `git status --porcelain --branch`. */
export function statusOf(porcelain: string): { branch: string; changes: number } {
    const lines = porcelain.split("\n").filter(Boolean);
    const head = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
    const branch = head.startsWith("HEAD (no branch)") ? "detached" : (head.split("...")[0] ?? "").trim();

    return { branch: branch || "?", changes: lines.filter((row) => !row.startsWith("## ")).length };
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

/** The session's whole share in KB: its scratch (without its worktrees), its task output and every worktree. */
export function sessionTotalKb(reading: Pick<TmpReading, "scratch" | "tasks" | "worktrees">): number | null {
    if (reading.scratch.kb === null) {
        return null;
    }

    // The scratch walk leaves its worktrees out, so every worktree counts here once.
    return reading.worktrees.reduce((sum, tree) => sum + (tree.kb ?? 0), reading.scratch.kb + (reading.tasks.kb ?? 0));
}

/** The worktrees this session's subagents got, from `<session>/subagents/*.meta.json`. */
async function subagentWorktrees(host: Host): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const dir = await sessionDirOf(host);
    const entries = dir ? await host.list(`${dir}/subagents`).catch(() => []) : [];

    for (const entry of entries) {
        if (!entry.name.endsWith(".meta.json")) {
            continue;
        }

        const meta: unknown = await host
            .read(`${dir}/subagents/${entry.name}`)
            .then((text) => JSON.parse(text))
            .catch(() => undefined);

        if (isRecord(meta) && typeof meta.worktreePath === "string") {
            const what = typeof meta.description === "string" ? bareDescription(meta.description) : "a subagent";
            found.set(samePath(meta.worktreePath), `subagent: ${what}`);
        }
    }

    return found;
}

/** Every worktree this session made or holds, with where it came from. Ones gone from disk are left out. */
async function worktreesOf(host: Host, scratch: string): Promise<SessionWorktree[]> {
    const from = await subagentWorktrees(host);
    const scratchTrees = await host.list(`${scratch}/worktrees`).catch(() => []);

    for (const entry of scratchTrees) {
        if (entry.kind === "dir") {
            from.set(`${scratch}/worktrees/${entry.name}`, "made in its scratch folder");
        }
    }

    const listed = await host
        .run(["git", "-C", await host.cwd(), "worktree", "list", "--porcelain"], { timeoutMs: 10_000 })
        .catch(() => undefined);
    const locked = new Set(lockedToSession(listed?.stdout ?? "", await host.sessionId()));

    for (const path of locked) {
        if (!from.has(path)) {
            from.set(path, "locked to this session");
        }
    }

    const trees: SessionWorktree[] = [];

    for (const [path, source] of from) {
        if (!(await host.exists(`${path}/.git`))) {
            continue;
        }

        const status = await host
            .run(["git", "-C", path, "status", "--porcelain", "--branch"], { timeoutMs: 10_000 })
            .catch(() => undefined);
        trees.push({
            path,
            source,
            ...(status?.exitCode === 0 ? statusOf(status.stdout) : { branch: "?", changes: 0 }),
            isLocked: locked.has(path),
            kb: await worktreeSize(host, path, status?.stdout ?? ""),
        });
    }

    return trees.sort((a, b) => (b.kb ?? 0) - (a.kb ?? 0));
}

async function measure(host: Host): Promise<void> {
    const settings = (await settingsOf(host)).tmpUsage;

    if (!settings.enabled) {
        return;
    }

    // lint-rules-ignore: /tmp/cc/<project>/<session> is the agents' scratch folder by convention, not a temp file.
    const scratch = `/tmp/cc/${await projectOf(host)}/${await host.sessionId()}`;
    const sessionDir = await sessionDirOf(host);
    const uid = (await host.run(["id", "-u"], { timeoutMs: 5_000 }).catch(() => undefined))?.stdout.trim();
    const projectFolder = sessionDir?.split("/").slice(-2, -1)[0];
    // lint-rules-ignore: Claude Code's own per-session task output folder, read only.
    const tasks = uid && projectFolder ? `/tmp/claude-${uid}/${projectFolder}/${await host.sessionId()}` : "";
    const worktrees = await worktreesOf(host, scratch);
    const inside = worktrees.filter((tree) => tree.path.startsWith(`${scratch}/`));
    const reading: TmpReading = {
        at: Date.now(),
        scratch: {
            path: scratch,
            kb: await pacedKb(
                host,
                scratch,
                inside.map((tree) => basename(tree.path))
            ),
        },
        tasks: { path: tasks, kb: tasks ? await pacedKb(host, tasks) : 0 },
        worktrees,
        freeKb: await kbOf(host, ["df", "-k", "/"], 3),
    };

    usage = reading;
    host.redraw();
    await logMod(host, "tmp", {
        folder: scratch,
        totalKb: sessionTotalKb(reading),
        scratchKb: reading.scratch.kb,
        tasksKb: reading.tasks.kb,
        worktrees: reading.worktrees.map((tree) => ({ path: tree.path, kb: tree.kb, source: tree.source })),
        freeKb: reading.freeKb,
    });
}

/** One reading at a time: a press during the timer's reading waits for that one. */
function measureOnce(host: Host): Promise<void> {
    measuring ??= measure(host).finally(() => {
        measuring = undefined;
    });

    return measuring;
}

export const tmpUsage: Feature = {
    panelOnly: true,
    async start(host) {
        const settings = (await settingsOf(host)).tmpUsage;

        host.every(settings.minutes * 60_000, () => {
            void measureOnce(host);
        });
        host.every(5_000, () => {
            if (takeDueStale()) {
                void measureOnce(host);
            }
        });
        void measureOnce(host);
    },
    async afterTool(host, e) {
        if (e.tool !== "Bash" || !changesSize(e.command) || !usage) {
            return;
        }

        // The folders the command names, else the one it ran in.
        const known = [usage.scratch.path, ...usage.worktrees.map((tree) => tree.path)];
        const text = JSON.stringify(e);
        const named = known.filter((path) => text.includes(path));
        const cwd = await host.cwd();
        const touched = named.length > 0 ? named : known.filter((path) => cwd === path || cwd.startsWith(`${path}/`));

        if (touched.length > 0) {
            markSizeStale(touched);
            host.redraw();
        }
    },
    sidebars: [{ id: TMP_PANE, title: "Session files", draw: tmpPane }],
    commands: [
        {
            name: "mod-tmp",
            description: "The Session files sidebar: this session's scratch folder, task output and worktrees, by size",
            async run(host) {
                await host.togglePane(TMP_PANE, "Session files", "command");

                return {};
            },
        },
    ],
};

export function sizeText(kb: number | null): string {
    if (kb === null) {
        return "?";
    }

    if (kb < 1024) {
        return `${kb}K`;
    }

    if (kb < 1024 * 1024) {
        return `${Math.round(kb / 1024)}M`;
    }

    return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

/** `session 4.0G · 1 worktree`: what the band's button says. */
function sessionText(reading: TmpReading): string {
    const trees = reading.worktrees.length ? ` · ${plural(reading.worktrees.length, "worktree")}` : "";

    return `session ${sizeText(sessionTotalKb(reading))}${trees}`;
}

/** The band's /tmp row, or null while off or not measured yet. A press opens the Session files sidebar. */
export async function tmpRow(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    const held = usage;

    if (!held || !(await settingsOf(host)).tmpUsage.enabled) {
        return null;
    }

    const { Box, Button, Text } = ui;
    const low = held.freeKb !== null && held.freeKb < LOW_FREE_KB;

    return (
        <Box key="tmp-band" flexDirection="row" gap={1}>
            <Text dimColor>tmp:</Text>
            <Button key="tmp-open" plain onPress={() => void host.togglePane(TMP_PANE, "Session files")}>
                <Text dimColor>{sessionText(held)}</Text>
            </Button>
            <Text dimColor>·</Text>
            <Text color={low ? "red" : undefined} dimColor={!low} bold={low}>
                {`disk free ${sizeText(held.freeKb)}`}
            </Text>
        </Box>
    );
}

/** A path with the home as `~`. */
function tilde(path: string, home: string | undefined): string {
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Opens a folder in Finder and says so in the status bar. */
async function reveal(host: Host, key: string, path: string): Promise<void> {
    const run = await host.openUrl(path).catch((error: unknown) => error);
    const code = isRecord(run) && typeof run.exitCode === "number" ? run.exitCode : -1;

    await pressed(
        host,
        key,
        code === 0 ? `Opened ${path} in Finder.` : `open ${path} failed (exit ${code}).`,
        code === 0
    );
}

async function copyPath(host: Host, key: string, path: string): Promise<void> {
    const done = await host.copy(path);

    await pressed(
        host,
        key,
        done.isCopied ? `Copied ${path}` : `Copy failed: ${done.reason ?? "no clipboard"}.`,
        done.isCopied
    );
}

/** A folder line: its name as a Button that opens it in Finder, its size at the right edge. */
function folderLine(kit: Kit, key: string, label: string, path: string, kb: number | null, hint: string, host: Host) {
    const { Box, Button, Text } = kit.ui;
    const row: Pressable = { key, label, hint, onPress: () => void reveal(host, key, path) };
    kit.pressables?.push(row);

    return line(
        kit,
        key,
        <Box flexDirection="row" flexGrow={1}>
            <Box flexShrink={1} minWidth={0}>
                <Button key={key} plain onPress={row.onPress}>
                    {label}
                </Button>
            </Box>
            <Box flexGrow={1} />
            <Box flexShrink={0} marginLeft={1}>
                {sizeAgeText(path) ? <Text dimColor>{`${sizeAgeText(path)} `}</Text> : null}
                <Text bold>{sizeText(kb)}</Text>
            </Box>
        </Box>
    );
}

/** The Session files sidebar: the total, the scratch folder, the task output, then each worktree by size. */
async function tmpPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    const held = usage;
    const home = await host.env("HOME");
    const reload: Pressable = {
        key: "tmp-refresh",
        label: "refresh",
        isDim: true,
        hint: "Measure the scratch folder, the task output and every worktree again (du, about 2 s a worktree).",
        onPress: () => {
            void pressed(host, "tmp-refresh", "Measuring…", "busy")
                .then(() => measureOnce(host))
                .then(() => pressed(host, "tmp-refresh", usage ? `Measured: ${sessionText(usage)}.` : "Measured."));
        },
    };
    const lines: RenderElement[] = [
        line(
            kit,
            "tmp-head",
            <Box flexDirection="row" flexGrow={1}>
                <Box flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end">
                        <Text bold>Session files</Text>
                        <Text dimColor>
                            {held ? ` · ${sizeText(sessionTotalKb(held))} · read ${liveAgo(held.at)}` : " · measuring…"}
                        </Text>
                    </Text>
                </Box>
                <Box flexGrow={1} />
                <Box flexShrink={0}>{actionButton(kit, reload)}</Box>
            </Box>
        ),
        line(kit, "tmp-gap", null),
    ];

    if (!held) {
        return sidebarFrame(kit, <Box flexDirection="column">{lines}</Box>, lines.length);
    }

    lines.push(
        folderLine(
            kit,
            "tmp-scratch",
            "scratch folder",
            held.scratch.path,
            held.scratch.kb,
            `Show ${tilde(held.scratch.path, home)} in Finder: the session's scratch files (/tmp/cc).`,
            host
        )
    );

    if (held.tasks.path && held.tasks.kb) {
        lines.push(
            folderLine(
                kit,
                "tmp-tasks",
                "task output",
                held.tasks.path,
                held.tasks.kb,
                `Show ${held.tasks.path} in Finder: what Claude Code kept of background shells and subagents.`,
                host
            )
        );
    }

    lines.push(
        line(kit, "tmp-gap-2", null),
        line(
            kit,
            "tmp-trees",
            <Text wrap="truncate-end">
                <Text bold>Worktrees</Text>
                <Text dimColor>
                    {held.worktrees.length
                        ? ` · ${held.worktrees.length} · ${sizeText(held.worktrees.reduce((sum, tree) => sum + (tree.kb ?? 0), 0))}`
                        : " · none"}
                </Text>
            </Text>
        )
    );

    if (!held.worktrees.length) {
        lines.push(
            line(
                kit,
                "tmp-none",
                <Text dimColor wrap="truncate-end">
                    No subagent worktree, none in the scratch folder, none locked to this session.
                </Text>
            )
        );
    }

    held.worktrees.forEach((tree, index) => {
        const at = `tmp-tree-${index}`;
        const name = tree.path.slice(tree.path.lastIndexOf("/") + 1);
        const state = tree.changes ? `${plural(tree.changes, "changed file")}` : "clean";
        // The status bar holds two rows: the path goes in the copy hint, which says nothing else.
        const removal = tree.isLocked
            ? "It is locked to this session until the session ends."
            : tree.changes
              ? "It has changed files, so git worktree remove refuses it."
              : "It is clean: git worktree remove <path> frees it.";

        lines.push(
            folderLine(kit, at, name, tree.path, tree.kb, `Show it in Finder. ${removal}`, host),
            line(
                kit,
                `${at}-what`,
                <Text wrap="truncate-end">
                    <Text dimColor>{"  "}</Text>
                    <Text color={tree.changes ? "yellow" : undefined} dimColor={!tree.changes}>
                        {`${tree.branch} · ${state}${tree.isLocked ? " · locked" : ""}`}
                    </Text>
                </Text>
            ),
            line(kit, `${at}-from`, <Text dimColor wrap="truncate-end">{`  ${tree.source}`}</Text>),
            line(
                kit,
                `${at}-actions`,
                <Box paddingLeft={2} flexDirection="row" columnGap={1}>
                    {actionButton(kit, {
                        key: `${at}-copy`,
                        label: "copy path",
                        isDim: true,
                        hint: `Copy ${tilde(tree.path, home)}`,
                        onPress: () => void copyPath(host, `${at}-copy`, tree.path),
                    })}
                </Box>
            )
        );
    });

    return sidebarFrame(kit, <Box flexDirection="column">{lines}</Box>, lines.length);
}
