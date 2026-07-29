import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLAUDE_DIR, encodedProjectDir, PROJECTS_DIR } from "@genesiscz/utils/claude/projects";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { listLiveTeammateProcesses, matchLeadPane, matchLiveProcess } from "./status";
import { indexProjectTranscripts } from "./transcripts";
import type { TeamConfigFile, TeamMemberConfig, TeamMemberView, TeammateTranscriptRef, TeamView } from "./types";

const prof = profiler.scope("teams");

export function teamsRoot(): string {
    return join(CLAUDE_DIR || join(homedir(), ".claude"), "teams");
}

export function readTeamConfig(teamName: string): TeamConfigFile | null {
    const path = join(teamsRoot(), teamName, "config.json");
    if (!existsSync(path)) {
        return null;
    }

    try {
        const raw = readFileSync(path, "utf8");
        return SafeJSON.parse(raw, { strict: true }) as TeamConfigFile;
    } catch (error) {
        logger.debug({ error, path }, "[teams] failed to parse team config");
        return null;
    }
}

/** List team directory names that have a config.json. */
export function listTeamNames(): string[] {
    return prof.measure("list-team-names", () => {
        const root = teamsRoot();
        if (!existsSync(root)) {
            return [];
        }

        const names: string[] = [];
        for (const ent of readdirSync(root, { withFileTypes: true })) {
            if (!ent.isDirectory()) {
                continue;
            }

            if (existsSync(join(root, ent.name, "config.json"))) {
                names.push(ent.name);
            }
        }

        return names;
    });
}

function backendOf(m: TeamMemberConfig): TeamMemberView["backend"] {
    const b = m.backendType;
    if (b === "tmux" || b === "in-process") {
        return b;
    }

    if (m.tmuxPaneId && m.tmuxPaneId !== "leader" && m.tmuxPaneId !== "in-process") {
        return "tmux";
    }

    if (m.tmuxPaneId === "in-process" || m.name === "team-lead") {
        return "in-process";
    }

    return "unknown";
}

function activityLine(view: Omit<TeamMemberView, "activity">): string {
    if (view.status === "not-logged-in") {
        return "Not logged in · needs OAuth re-attach";
    }

    if (view.transcript?.lastMessage) {
        const lm = view.transcript.lastMessage;
        const prefix = lm.isLeadAssignment ? "assign: " : lm.role === "assistant" ? "out: " : "in: ";
        const one = lm.text.replace(/\s+/g, " ").slice(0, 90);
        return prefix + one + (lm.text.length > 90 ? "…" : "");
    }

    if (view.member.prompt) {
        const one = view.member.prompt.replace(/\s+/g, " ").slice(0, 90);
        return `prompt: ${one}${view.member.prompt.length > 90 ? "…" : ""}`;
    }

    if (view.status === "running") {
        return "running (no transcript yet)";
    }

    if (view.status === "dead") {
        return "stopped";
    }

    return "—";
}

function statusOf(opts: {
    isLead: boolean;
    live?: ReturnType<typeof matchLiveProcess>;
    transcript?: TeammateTranscriptRef;
    member: TeamMemberConfig;
}): TeamMemberView["status"] {
    if (opts.isLead) {
        return opts.live ? "running" : opts.member.isActive === false ? "dead" : "unknown";
    }

    if (opts.live) {
        const last = opts.transcript?.lastMessage;
        if (last?.role === "assistant" && /not logged in/i.test(last.text)) {
            return "not-logged-in";
        }

        return "running";
    }

    if (opts.member.isActive === false) {
        return "dead";
    }

    const last = opts.transcript?.lastMessage;
    if (last?.role === "assistant" && /not logged in/i.test(last.text)) {
        return "not-logged-in";
    }

    if (opts.transcript) {
        return "dead";
    }

    return "unknown";
}

export interface DiscoverTeamsOptions {
    /** When set, only teams whose cwd/project matches this project filter. */
    projectFilter?: string;
    /** cwd used to derive current-project filter when projectFilter is undefined and all=false. */
    cwd?: string;
    all?: boolean;
    /** Include teams with no non-lead members (lead-only). Default false. */
    includeEmpty?: boolean;
    /**
     * Only load these team directory names (skip the rest). Used for detail
     * refresh so we don't re-index every project's 2GB of jsonl.
     */
    onlyTeamNames?: string[];
    /** Skip transcript indexing (live status only). */
    skipTranscripts?: boolean;
}

function buildMemberViews(
    config: TeamConfigFile,
    teamName: string,
    live: ReturnType<typeof listLiveTeammateProcesses>,
    transcriptIndex: Map<string, TeammateTranscriptRef>
): TeamMemberView[] {
    return config.members.map((member) => {
        const isLead = member.name === "team-lead" || member.agentType === "team-lead";
        const liveProc = matchLiveProcess(live, {
            teamName: config.name || teamName,
            agentName: member.name,
            agentId: member.agentId,
            isLead,
            leadSessionId: config.leadSessionId,
        });

        const transcript = isLead ? undefined : transcriptIndex.get(member.name);

        const partial = {
            member,
            isLead,
            backend: backendOf(member),
            status: statusOf({ isLead, live: liveProc, transcript, member }),
            live: liveProc,
            transcript,
        };

        return { ...partial, activity: activityLine(partial) };
    });
}

/** Resolve symlinks/`..` so `/tmp/app` and `/private/tmp/app/` compare equal. */
function realPathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch (error) {
        // A team whose cwd has since been deleted still has to compare against the
        // filter, so fall back to lexical resolution rather than dropping it.
        logger.debug({ error, path }, "[teams] realpath failed; comparing the lexically resolved path");
        return resolve(path);
    }
}

function teamMatchesProjectFilter(
    config: TeamConfigFile,
    teamName: string,
    projectFilter: string,
    live: ReturnType<typeof listLiveTeammateProcesses>,
    cwd?: string
): boolean {
    const cwdFromMembers =
        config.members.find((m) => m.name === "team-lead")?.cwd ?? config.members.find((m) => m.cwd)?.cwd;
    const encodedCwd = cwdFromMembers ? encodedProjectDir(cwdFromMembers) : "";
    const filter = projectFilter;
    // Matching on basename alone made every `…/app` look like every other `…/app`;
    // compare resolved absolute paths instead.
    const samePath =
        cwd !== undefined && cwdFromMembers !== undefined && realPathOrSelf(cwdFromMembers) === realPathOrSelf(cwd);
    const matches =
        encodedCwd === filter ||
        encodedCwd.endsWith(filter) ||
        samePath ||
        teamName.includes(filter.replace(/^-/, "").slice(-12));

    if (matches) {
        return true;
    }

    return live.some(
        (p) =>
            p.teamName === teamName ||
            p.teamName === config.name ||
            (config.leadSessionId !== undefined && p.parentSessionId === config.leadSessionId)
    );
}

/**
 * Build TeamView list: configs + live processes + (one-pass) transcript index per project.
 */
export function discoverTeams(opts: DiscoverTeamsOptions = {}): TeamView[] {
    return prof.measure("discoverTeams", () => {
        const live = prof.measure("live-processes", () => listLiveTeammateProcesses());
        const cwd = opts.cwd ?? process.cwd();
        const currentEncoded = encodedProjectDir(cwd);

        let projectFilter = opts.projectFilter;
        if (!opts.all && !projectFilter) {
            projectFilter = currentEncoded;
        }

        const names = opts.onlyTeamNames ?? listTeamNames();

        // Pass 1: load configs + filter (no transcript I/O).
        type Pending = {
            teamName: string;
            configPath: string;
            config: TeamConfigFile;
            mtimeMs: number;
            cwdFromMembers?: string;
            projectDir?: string;
        };
        const pending: Pending[] = [];

        for (const teamName of names) {
            const configPath = join(teamsRoot(), teamName, "config.json");
            const config = readTeamConfig(teamName);
            if (!config?.members?.length) {
                continue;
            }

            const nonLead = config.members.filter((m) => m.name !== "team-lead" && m.agentType !== "team-lead");
            if (!opts.includeEmpty && nonLead.length === 0) {
                continue;
            }

            if (projectFilter && !opts.all && !opts.onlyTeamNames) {
                if (!teamMatchesProjectFilter(config, teamName, projectFilter, live, cwd)) {
                    continue;
                }
            }

            let mtimeMs = 0;
            try {
                mtimeMs = statSync(configPath).mtimeMs;
            } catch (error) {
                // Only drives the age column and the sort tiebreak — 0 sorts last.
                logger.debug({ error, configPath }, "[teams] could not stat team config; treating it as age 0");
            }

            const cwdFromMembers =
                config.members.find((m) => m.name === "team-lead")?.cwd ?? config.members.find((m) => m.cwd)?.cwd;
            const projectDir = cwdFromMembers ? join(PROJECTS_DIR, encodedProjectDir(cwdFromMembers)) : undefined;

            pending.push({ teamName, configPath, config, mtimeMs, cwdFromMembers, projectDir });
        }

        // Pass 2: one transcript scan per projectDir for all teams that live there.
        const projectTeamNames = new Map<string, string[]>();
        if (!opts.skipTranscripts) {
            for (const p of pending) {
                if (!p.projectDir || !existsSync(p.projectDir)) {
                    continue;
                }

                const key = p.projectDir;
                const list = projectTeamNames.get(key) ?? [];
                list.push(p.config.name || p.teamName);
                projectTeamNames.set(key, list);
            }
        }

        const projectIndexes = new Map<string, Map<string, Map<string, TeammateTranscriptRef>>>();
        for (const [projectDir, teamNameList] of projectTeamNames) {
            projectIndexes.set(projectDir, indexProjectTranscripts(projectDir, teamNameList));
        }

        // Pass 3: assemble views
        const views: TeamView[] = [];
        for (const p of pending) {
            const teamKey = p.config.name || p.teamName;
            const transcriptIndex =
                (p.projectDir && projectIndexes.get(p.projectDir)?.get(teamKey)) ||
                new Map<string, TeammateTranscriptRef>();

            const members = buildMemberViews(p.config, p.teamName, live, transcriptIndex);
            const teammates = members.filter((m) => !m.isLead);
            const lead = members.find((m) => m.isLead);
            const layout = matchLeadPane({
                teamName: teamKey,
                leadSessionId: p.config.leadSessionId,
                live,
                teammates,
            });

            views.push({
                teamName: p.teamName,
                configPath: p.configPath,
                config: p.config,
                leadSessionId: p.config.leadSessionId,
                cwd: p.cwdFromMembers,
                projectDir: p.projectDir,
                mtimeMs: p.mtimeMs,
                members,
                teammates,
                lead,
                tmuxSession: layout?.session,
                leadPaneId: layout?.leadPaneId,
            });
        }

        views.sort((a, b) => {
            const aLive = a.teammates.some((t) => t.live) || Boolean(a.lead?.live);
            const bLive = b.teammates.some((t) => t.live) || Boolean(b.lead?.live);
            if (aLive !== bLive) {
                return aLive ? -1 : 1;
            }

            return b.mtimeMs - a.mtimeMs;
        });

        return views;
    });
}

/** Refresh a single team by name (detail view). Does not scan other teams' transcripts. */
export function discoverTeam(teamName: string): TeamView | undefined {
    return discoverTeams({ all: true, onlyTeamNames: [teamName] })[0];
}
