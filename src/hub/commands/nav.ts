import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createBuildProgressDisplay } from "@app/macos/lib/permissions/swift-progress";
import { agentSessionIds } from "@genesiscz/utils/agent/host";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { hubDbPath, openHubDb } from "../lib/data-db";
import { readNav, recordNav, setNavKeep } from "../lib/navigation/store";
import { navTargetProblem, navTitle, parseNavInput, resolveNavWorktree } from "../lib/navigation/target";
import {
    isNavActor,
    NAV_ACTORS,
    type NavActor,
    type NavEntry,
    type NavTarget,
    normalizeTarget,
} from "../lib/navigation/types";
import { HUB_MODES, HUB_TABS, hubPrintUrl, openHub } from "../lib/open";

const { log } = logger.scoped("hub:nav");

function positiveInt(value: string): number {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new InvalidArgumentError("a whole number above 0");
    }

    return parsed;
}

function isFolder(path: string): boolean {
    try {
        return statSync(resolve(path)).isDirectory();
    } catch (error) {
        log.debug({ path, error }, "hub nav: not a folder");
        return false;
    }
}

/** The one log line per navigation, in the day log (`~/.genesis-tools/logs/<date>.log`). */
function logNavigation(entry: NavEntry, via: string): void {
    // Debug: the day log keeps every level, and an agent's terminal does not need the block.
    log.debug(
        { via, actor: entry.actor, target: entry.target, note: entry.note, from: entry.from, id: entry.id },
        `hub nav: ${entry.actor} → ${entry.title}${entry.note ? ` (${entry.note})` : ""}`
    );
}

/** The calling agent's own session, so an agent need not pass `--from`. */
function callerSession(): string | undefined {
    return agentSessionIds(env.getProcessEnv())[0]?.id;
}

function actorFlag(value: string | undefined, fallback: NavActor): NavActor | null {
    if (value === undefined) {
        return fallback;
    }

    if (isNavActor(value)) {
        return value;
    }

    out.log.error(suggestEnumFlag(toolCommand("hub nav open"), "--actor", NAV_ACTORS, { given: value }));
    return null;
}

interface NavOpenFlags {
    pr?: string;
    commit?: string;
    repo?: string;
    worktree?: string;
    session?: string;
    agent?: string;
    mode?: string;
    tab?: string;
    reveal?: string;
    actor?: string;
    note?: string;
    from?: string;
    printUrl?: boolean;
    activate: boolean;
    build: boolean;
}

function flagTarget(flags: NavOpenFlags): NavTarget {
    return normalizeTarget({
        pr: flags.pr,
        commit: flags.commit,
        repo: flags.repo ? (/^\.{1,2}(?:[/\\]|$)/.test(flags.repo) ? resolve(flags.repo) : flags.repo) : undefined,
        worktree: flags.worktree ? resolveNavWorktree(flags.worktree) : undefined,
        session: flags.session,
        agent: flags.agent,
        mode: flags.mode,
        tab: flags.tab,
        reveal: flags.reveal,
    });
}

async function navOpen(input: string | undefined, flags: NavOpenFlags): Promise<void> {
    const parsed = parseNavInput(input ?? "", isFolder);

    if ("error" in parsed) {
        out.log.error(parsed.error);
        process.exitCode = 1;
        return;
    }

    const target: NavTarget = { ...parsed.target, ...flagTarget(flags) };
    const problem = navTargetProblem(target);

    if (problem) {
        out.log.error(problem);
        process.exitCode = 1;
        return;
    }

    if (target.mode !== undefined && !(HUB_MODES as readonly string[]).includes(target.mode)) {
        out.log.error(suggestEnumFlag(toolCommand("hub nav open"), "--mode", HUB_MODES, { given: target.mode }));
        process.exitCode = 1;
        return;
    }

    if (target.tab !== undefined && !(HUB_TABS as readonly string[]).includes(target.tab)) {
        out.log.error(suggestEnumFlag(toolCommand("hub nav open"), "--tab", HUB_TABS, { given: target.tab }));
        process.exitCode = 1;
        return;
    }

    const from = flags.from ?? parsed.from ?? callerSession();
    // An agent's shell names its session in the environment; anything else that asked is a link.
    const actor = actorFlag(flags.actor ?? parsed.actor, from ? "agent" : "link");

    if (actor === null) {
        process.exitCode = 1;
        return;
    }

    const note = flags.note ?? parsed.note;
    const mode = HUB_MODES.find((value) => value === target.mode);
    const tab = HUB_TABS.find((value) => value === target.tab);
    const link = {
        mode,
        session: target.session,
        agent: target.agent,
        pr: target.pr,
        reveal: target.reveal,
        repo: target.repo,
        commit: target.commit,
        tab,
        worktree: target.worktree,
        actor,
        note,
        from,
    };

    if (flags.printUrl) {
        out.println(hubPrintUrl(link));
        return;
    }

    const entry: NavEntry = { id: crypto.randomUUID(), at: Date.now(), actor, title: navTitle(target), target };

    if (note) {
        entry.note = note;
    }

    if (from) {
        entry.from = from;
    }

    const db = openHubDb();

    try {
        recordNav(db, entry);
    } finally {
        db.close();
    }

    logNavigation(entry, "cli");
    const progress = createBuildProgressDisplay({
        step: (message) => out.log.step(message),
        spinner: () => out.spinner(),
    });

    try {
        const opened = await openHub({
            ...link,
            nav: entry.id,
            activate: flags.activate,
            build: flags.build,
            onStep: progress.onStep,
            onProgress: progress.onProgress,
        });
        progress.finish();
        out.log.success(
            `Hub opened on ${entry.title}${opened.built ? " (app rebuilt first)" : ""}; recorded as ${actor}`
        );
    } catch (error) {
        progress.finish();
        out.log.error(
            `Recorded ${entry.title}, but the hub did not open: ${error instanceof Error ? error.message : error}`
        );
        process.exitCode = 1;
    }
}

interface NavRecordFlags {
    id: string;
    actor: string;
    title: string;
    target: string;
    at?: string;
    note?: string;
    from?: string;
    keep?: number;
    replacing?: string[];
    json?: boolean;
}

/** The app's door: one entry the hub's engine made or changed. */
function navRecord(flags: NavRecordFlags): void {
    if (!isNavActor(flags.actor)) {
        out.log.error(suggestEnumFlag(toolCommand("hub nav record"), "--actor", NAV_ACTORS, { given: flags.actor }));
        process.exitCode = 1;
        return;
    }

    const target = normalizeTarget(SafeJSON.parse(flags.target, { strict: true }));
    const at = flags.at === undefined ? Date.now() : Number(flags.at);
    const entry: NavEntry = {
        id: flags.id,
        at: Number.isFinite(at) ? at : Date.now(),
        actor: flags.actor,
        title: flags.title,
        target,
    };

    if (flags.note) {
        entry.note = flags.note;
    }

    if (flags.from) {
        entry.from = flags.from;
    }

    const db = openHubDb();

    try {
        const result = recordNav(db, entry, { keep: flags.keep, replacing: flags.replacing });
        logNavigation(entry, "hub");

        if (flags.json) {
            out.result({ entry, ...result });
        }
    } finally {
        db.close();
    }
}

function navList(flags: { json?: boolean; limit?: number }): void {
    const { entries, keep } = readNav({ limit: flags.limit });

    if (flags.json) {
        out.result({ entries, keep, path: hubDbPath() });
        return;
    }

    renderCliHeader("Hub history", `${entries.length} places, newest first · ${hubDbPath()}`);
    const table = createBoxTable(["WHEN", "WHO", "PLACE", "NOTE"]);
    const tint = { user: pc.dim, agent: pc.magenta, link: pc.cyan } as const;

    for (const entry of entries) {
        table.push([
            formatRelativeTime(new Date(entry.at)),
            tint[entry.actor](entry.actor),
            truncateDisplay(entry.title, 60),
            truncateDisplay(entry.note ?? "", 60),
        ]);
    }

    out.println(table.toString());
    out.println(pc.dim(`Open one: ${toolCommand("hub nav open")} <link> --note "<why>"`));
}

export function registerNavCommands(program: Command): void {
    const nav = program
        .command("nav")
        .description(
            "The hub's navigation history: every place it showed, who took it there (user, agent, link) and why. Back, Forward and History (⌘Y) in the hub walk it"
        );

    nav.command("list")
        .description("The places, newest first")
        .option("--json", "machine-readable output: { entries, keep, path }")
        .option("--limit <n>", "at most this many", positiveInt)
        .action((flags: { json?: boolean; limit?: number }) => navList(flags));

    nav.command("open")
        .description(
            `Open the hub on a place AND record who asked and why. Agents: use this instead of ${toolCommand("hub open")}, so the person can go Back`
        )
        .argument(
            "[link-or-target]",
            "a hub link, a PR (#563, group/app!12, a PR page), a commit sha, or a checkout folder"
        )
        .option("--pr <ref>", "the PR/MR: 42, group/app#42, or its page URL")
        .option("--commit <sha>", "a commit (7 to 40 hex characters) or <from>..<to>, in --pr or in --repo")
        .option("--repo <path|owner/repo>", "with --commit and no --pr: the commit's checkout or forge project")
        .option("--worktree <path>", "open the Worktrees mode on this checkout")
        .option("--session <id>", "select this session (id or prefix)")
        .option("--agent <id>", "open this agent in the Agents mode")
        .option("--mode <mode>", HUB_MODES.join("|"))
        .option("--tab <tab>", HUB_TABS.join("|"))
        .option("--reveal <path>", "with --pr: this repo-relative file in its review")
        .option("--actor <actor>", `${NAV_ACTORS.join("|")} (default: agent inside an agent session, else link)`)
        .option("--note <text>", "why you open it; the hub's History shows it under the place")
        .option("--from <session>", "the agent session that asks (default: this shell's own agent session)")
        .option("--print-url", "print the hub link (with actor, note, from) instead of opening and recording")
        .option("--no-activate", "open behind the window in front, without taking focus")
        .option("--no-build", "never build; fail when GenesisTools.app is missing or stale")
        .action(async (input: string | undefined, flags: NavOpenFlags) => navOpen(input, flags));

    nav.command("configure")
        .description("Persist the History limit and prune the log immediately")
        .requiredOption("--keep <n>", "keep the newest n entries", positiveInt)
        .action((flags: { keep: number }) => {
            const db = openHubDb();
            try {
                setNavKeep(db, flags.keep);
            } finally {
                db.close();
            }
        });

    nav.command("record")
        .description("Store one entry (GenesisTools.app's door: every place the hub shows)")
        .requiredOption("--id <id>", "the entry id; an existing one is replaced")
        .option("--replacing <ids...>", "remove these superseded entries in the same transaction")
        .requiredOption("--actor <actor>", NAV_ACTORS.join("|"))
        .requiredOption("--title <text>", "what the place is")
        .requiredOption("--target <json>", 'the place as the hub\'s link query, JSON: {"pr":"…","commit":"…"}')
        .option("--at <ms>", "when, milliseconds since the epoch (default now)")
        .option("--note <text>", "why")
        .option("--from <session>", "the agent session that asked")
        .option(
            "--keep <n>",
            "keep the newest n entries (the hub's History setting); stored for later writers",
            positiveInt
        )
        .option("--json", "print the stored entry")
        .action((flags: NavRecordFlags) => navRecord(flags));
}
