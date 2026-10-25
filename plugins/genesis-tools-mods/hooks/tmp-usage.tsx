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
import { liveAgo } from "./live";
import { bareDescription } from "./model-label";
import { type Feature, type Host, isRecord, logMod, settingsOf } from "./shared";
import { actionButton, type Kit, line, type Pressable, plural, pressed, sidebarFrame } from "./sidebar";

let usage: TmpUsage = null;
let measuring: Promise<void> | undefined;
const LOW_FREE_KB = 10 * 1024 * 1024;
export const TMP_PANE = "mods-tmp";

async function kbOf(host: Host, argv: string[], column: number): Promise<number | null> {
    const done = await host.run(argv, { timeoutMs: 60_000 }).catch(() => undefined);
    const lines = done?.stdout.trim().split("\n") ?? [];
    const value = Number(lines[lines.length - 1]?.trim().split(/\s+/)[column]);

    return Number.isFinite(value) && lines.length > 0 ? value : null;
}

async function folderKb(host: Host, path: string): Promise<number | null> {
    return (await host.exists(path)) ? kbOf(host, ["du", "-sk", path], 0) : 0;
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

/** The session's whole share in KB: its scratch, its task output and every worktree outside the scratch folder. */
export function sessionTotalKb(reading: Pick<TmpReading, "scratch" | "tasks" | "worktrees">): number | null {
    if (reading.scratch.kb === null) {
        return null;
    }

    const inside = (path: string) => path.startsWith(`${reading.scratch.path}/`);
    const outside = reading.worktrees.filter((tree) => !inside(tree.path));

    return outside.reduce((sum, tree) => sum + (tree.kb ?? 0), reading.scratch.kb + (reading.tasks.kb ?? 0));
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
            kb: await folderKb(host, path),
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
    const reading: TmpReading = {
        at: Date.now(),
        scratch: { path: scratch, kb: await folderKb(host, scratch) },
        tasks: { path: tasks, kb: tasks ? await folderKb(host, tasks) : 0 },
        worktrees: await worktreesOf(host, scratch),
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
    async start(host) {
        const settings = (await settingsOf(host)).tmpUsage;

        host.every(settings.minutes * 60_000, () => {
            void measureOnce(host);
        });
        void measureOnce(host);
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
