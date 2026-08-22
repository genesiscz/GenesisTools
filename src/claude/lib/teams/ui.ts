import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";
import { profiler } from "@genesiscz/utils/profile";
import { tableSelect } from "@genesiscz/utils/prompts/clack/table-select";
import { renderTree, type TreeNode } from "@genesiscz/utils/prompts/p/tree";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";
import { discoverTeam, discoverTeams } from "./discover";
import { buildToolsCcTeammateCommand, isLiveSidechain, launchTeammate, pickDefaultAccount } from "./launch";
import { formatStatusBadge, readProcessEnvKeys } from "./status";
import type { TeamMemberView, TeamView } from "./types";

const prof = profiler.scope("teams");

/** Terminal-safe single-line truncation. */
function ellipsize(text: string, max = 88): string {
    const plain = stripAnsi(text);
    if (plain.length <= max) {
        return text;
    }

    // Prefer truncating the plain form; details are mostly dim anyway
    return `${plain.slice(0, Math.max(0, max - 1))}…`;
}

function ageLabel(mtimeMs: number): string {
    const sec = Math.max(0, (Date.now() - mtimeMs) / 1000);
    if (sec < 60) {
        return `${Math.floor(sec)}s`;
    }

    if (sec < 3600) {
        return `${Math.floor(sec / 60)}m`;
    }

    if (sec < 86400) {
        return `${Math.floor(sec / 3600)}h`;
    }

    return `${Math.floor(sec / 86400)}d`;
}

function colorStatus(status: TeamMemberView["status"], label: string): string {
    switch (status) {
        case "running":
            return pc.green(label);
        case "not-logged-in":
            return pc.red(label);
        case "dead":
            return pc.dim(label);
        case "idle":
            return pc.yellow(label);
        default:
            return pc.dim(label);
    }
}

/** In-process mates write under the lead session. A new `--agent-id` spawn re-invokes. */
function isInProcessMate(t: TeamMemberView): boolean {
    return t.backend === "in-process" || Boolean(t.transcript?.sidechain);
}

function inProcessSpawnWarning(t: TeamMemberView): string | undefined {
    if (!isInProcessMate(t)) {
        return undefined;
    }

    if (isLiveSidechain(t.transcript)) {
        return "in-process still live: attach/split starts a new session and re-invokes the assignment";
    }

    return "in-process: attach/split does not restore the last tool call (new session, or lead resume)";
}

function teamSelectHint(all: boolean | undefined, teams: TeamView[]): string {
    const scope = all ? "(all projects)" : "(this project)";
    if (teams.some((t) => t.teammates.some((m) => isInProcessMate(m)))) {
        return `${scope} in-process attach re-invokes`;
    }

    return scope;
}

export function renderTeamsTree(teams: TeamView[]): string[] {
    if (teams.length === 0) {
        return [pc.dim("(no agent teams found)")];
    }

    const lines: string[] = [];
    for (const team of teams) {
        const liveCount = team.teammates.filter((t) => t.live).length;
        const liveTag = liveCount > 0 ? pc.green(`${liveCount} live`) : pc.dim("none live");
        const tmux = team.tmuxSession ? pc.cyan(team.tmuxSession) : pc.dim("no-tmux");
        const cwd = team.cwd ? pc.dim(collapsePath(team.cwd)) : "";
        lines.push(
            `${pc.bold(pc.cyan(team.teamName))}  ${liveTag}  ${tmux}  ${pc.dim(ageLabel(team.mtimeMs))}  ${cwd}`
        );

        const nodes: TreeNode[] = team.teammates.map((t) => {
            const badge = colorStatus(t.status, formatStatusBadge(t.status));
            const model = t.member.model ? pc.magenta(t.member.model) : pc.dim("?");
            const backend = pc.dim(t.backend);
            const children: TreeNode[] = [];

            if (t.activity) {
                children.push({ text: pc.dim(ellipsize(t.activity, 96)) });
            }

            if (t.live) {
                children.push({
                    text: pc.dim(
                        `pid ${t.live.pid}` +
                            (t.live.tmuxPaneId ? `  pane ${t.live.tmuxPaneId}` : "") +
                            (t.live.account ? `  acct ${t.live.account}` : "")
                    ),
                });
            }

            if (t.transcript && !t.transcript.hasLeadAssignment && t.member.prompt) {
                children.push({
                    text: pc.yellow("missing lead assignment: attach injects it"),
                });
            }

            const spawnWarn = inProcessSpawnWarning(t);
            if (spawnWarn) {
                children.push({ text: pc.yellow(spawnWarn) });
            }

            return {
                text: `${badge} ${pc.white(t.member.name)}  ${model}  ${backend}`,
                children,
            };
        });

        if (team.lead) {
            const leadBadge = colorStatus(team.lead.status, formatStatusBadge(team.lead.status));
            nodes.unshift({
                text: `${leadBadge} ${pc.bold("team-lead")}  ${pc.dim(team.leadSessionId?.slice(0, 8) ?? "")}`,
            });
        }

        for (const line of renderTree(nodes)) {
            lines.push(line);
        }

        lines.push("");
    }

    return lines;
}

export function printTeamsList(teams: TeamView[]): void {
    for (const line of renderTeamsTree(teams)) {
        out.println(line);
    }
}

export async function runTeamsInteractive(opts: { all?: boolean; account?: string }): Promise<void> {
    if (!isInteractive()) {
        throw new Error("Interactive mode requires a TTY. Use --json or run without a pipe.");
    }

    for (;;) {
        const teams = prof.measure("ui-discover-list", () => discoverTeams({ all: opts.all }));
        if (prof.enabled) {
            prof.summary("interactive list");
        }

        if (teams.length === 0) {
            out.println(pc.dim("No agent teams found."));
            out.println(
                pc.dim(
                    opts.all
                        ? "Spawn teammates from a Claude Code session first."
                        : "Try --all, or cd into the project that owns the team."
                )
            );
            return;
        }

        // Compact one-line summary only — full tree is noisy under the table picker
        // (was double-rendering and looking broken). Detail zone carries mate status.
        out.println(
            pc.dim(
                `${teams.length} team(s)` +
                    (opts.all ? " · all projects" : " · this project") +
                    " · ↑↓ select · enter · ↻ refresh"
            )
        );

        const teamPick = await tableSelect({
            message: "Select team",
            hint: teamSelectHint(opts.all, teams),
            columns: [
                { label: "TEAM", minWidth: 16 },
                { label: "LIVE", minWidth: 4, align: "right" },
                { label: "N", minWidth: 2, align: "right" },
                { label: "TMUX", minWidth: 12 },
                { label: "AGE", minWidth: 4, align: "right" },
            ],
            rows: [
                ...teams.map((t) => {
                    const live = t.teammates.filter((m) => m.live).length;
                    const authFail = t.teammates.filter((m) => m.status === "not-logged-in").length;
                    return {
                        value: t.teamName,
                        badge: authFail > 0 ? pc.red("●") : live > 0 ? pc.green("●") : pc.dim("○"),
                        cells: [
                            t.teamName,
                            String(live),
                            String(t.teammates.length),
                            ellipsize(t.tmuxSession ?? "—", 18),
                            ageLabel(t.mtimeMs),
                        ],
                        detail: [
                            ellipsize(t.cwd ? pc.dim(collapsePath(t.cwd)) : pc.dim("(no cwd)"), 100),
                            ...t.teammates
                                .slice(0, 6)
                                .map((m) =>
                                    ellipsize(
                                        `${colorStatus(m.status, formatStatusBadge(m.status))} ${m.member.name}  ${pc.dim(m.activity)}`,
                                        100
                                    )
                                ),
                            t.teammates.length > 6 ? pc.dim(`… +${t.teammates.length - 6} more`) : "",
                            t.teammates.some((m) => isInProcessMate(m))
                                ? pc.yellow("in-process attach re-invokes: it does not restore the last tool call")
                                : "",
                        ].filter(Boolean),
                    };
                }),
                {
                    value: "__refresh__",
                    badge: pc.cyan("↻"),
                    cells: [pc.cyan("↻ refresh"), "", "", "", ""],
                    detail: [pc.dim("Re-scan teams + live processes")],
                },
                {
                    value: "__quit__",
                    badge: pc.dim("×"),
                    cells: [pc.dim("quit"), "", "", "", ""],
                    detail: [],
                },
            ],
        });

        if (!teamPick || teamPick === "__quit__") {
            return;
        }

        if (teamPick === "__refresh__") {
            out.println("");
            continue;
        }

        const stay = await runTeamDetail(teamPick, opts.account);
        if (stay === "quit") {
            return;
        }

        out.println("");
    }
}

async function runTeamDetail(teamName: string, accountFlag?: string): Promise<"back" | "quit" | "refresh"> {
    // Single-team refresh only — never re-scan every project (was ~8s).
    const fresh = prof.measure("ui-discover-team", () => discoverTeam(teamName));
    if (prof.enabled) {
        prof.summary("interactive detail");
    }

    if (!fresh) {
        out.println(pc.red(`Team ${teamName} not found.`));
        return "back";
    }

    out.println("");
    out.println(
        `${pc.bold(fresh.teamName)}` +
            (fresh.tmuxSession ? `  ${pc.cyan(fresh.tmuxSession)}` : "") +
            (fresh.cwd ? `  ${pc.dim(collapsePath(fresh.cwd))}` : "")
    );
    if (fresh.config.description) {
        out.println(pc.dim(ellipsize(fresh.config.description, 100)));
    }

    if (fresh.teammates.length === 0) {
        out.println(pc.dim("No teammates on this team."));
        return "back";
    }

    const matePick = await tableSelect({
        message: `Teammates · ${fresh.teamName}`,
        hint: fresh.teammates.some((m) => isInProcessMate(m))
            ? "in-process attach re-invokes, it does not restore the last tool call"
            : "(enter to act)",
        columns: [
            { label: "NAME", minWidth: 14 },
            { label: "STATUS", minWidth: 12 },
            { label: "MODEL", minWidth: 8 },
            { label: "BACKEND", minWidth: 8 },
            { label: "ACTIVITY", minWidth: 24 },
        ],
        rows: [
            ...fresh.teammates.map((t) => ({
                value: t.member.name,
                badge: colorStatus(t.status, t.live ? "●" : "○"),
                cells: [
                    t.member.name,
                    colorStatus(t.status, t.status),
                    t.member.model ?? "—",
                    t.backend,
                    ellipsize(t.activity, 36),
                ],
                detail: buildTeammateDetail(fresh, t),
            })),
            {
                value: "__back__",
                badge: " ",
                cells: [pc.dim("← back"), "", "", "", ""],
                detail: [],
            },
        ],
    });

    if (!matePick || matePick === "__back__") {
        return "back";
    }

    const teammate = fresh.teammates.find((t) => t.member.name === matePick);
    if (!teammate) {
        return "back";
    }

    return runTeammateActions(fresh, teammate, accountFlag);
}

function buildTeammateDetail(team: TeamView, t: TeamMemberView): string[] {
    const lines: string[] = [];
    lines.push(pc.dim(`id ${t.member.agentId}`));

    if (t.live) {
        lines.push(
            pc.green(
                `live pid ${t.live.pid}${t.live.tmuxSession ? ` · ${t.live.tmuxSession}:${t.live.tmuxPaneId}` : ""}`
            )
        );
    } else {
        lines.push(pc.dim("not running"));
    }

    if (t.transcript) {
        lines.push(
            pc.dim(
                `transcript ${t.transcript.sessionId.slice(0, 8)} · ${t.transcript.messageCount} msgs` +
                    (t.transcript.hasLeadAssignment ? " · has assignment" : " · NO assignment")
            )
        );
    }

    if (t.member.prompt) {
        lines.push(pc.dim(ellipsize(`prompt: ${t.member.prompt.replace(/\s+/g, " ")}`, 96)));
    }

    if (t.transcript?.lastMessage) {
        const lm = t.transcript.lastMessage;
        const tag = lm.isLeadAssignment ? "assign" : lm.role;
        lines.push(pc.dim(ellipsize(`${tag}: ${lm.text.replace(/\s+/g, " ")}`, 96)));
    }

    if (!t.transcript?.hasLeadAssignment && t.member.prompt) {
        lines.push(pc.yellow("First assignment missing: attach/split will inject prompt"));
    }

    const spawnWarn = inProcessSpawnWarning(t);
    if (spawnWarn) {
        lines.push(pc.yellow(spawnWarn));
    }

    // Do NOT dump the full tools cc run command here — it wraps and wrecks the frame.
    // Shown on the action screen / print action instead.
    const cwd = t.member.cwd || team.cwd;
    lines.push(pc.dim(`cwd ${cwd ? collapsePath(cwd) : "—"}`));

    return lines.map((l) => ellipsize(l, 100));
}

async function resolveAccountForUi(team: TeamView, accountFlag?: string): Promise<string> {
    if (accountFlag) {
        return accountFlag;
    }

    // Lazy ps eww only for the chosen team's live pids (not during list).
    for (const m of team.teammates) {
        if (m.live?.pid) {
            const env = readProcessEnvKeys(m.live.pid, ["TOOLS_CLAUDE_ACCOUNT"]);
            if (env.TOOLS_CLAUDE_ACCOUNT) {
                return env.TOOLS_CLAUDE_ACCOUNT;
            }
        }
    }

    if (team.lead?.live?.pid) {
        const env = readProcessEnvKeys(team.lead.live.pid, ["TOOLS_CLAUDE_ACCOUNT"]);
        if (env.TOOLS_CLAUDE_ACCOUNT) {
            return env.TOOLS_CLAUDE_ACCOUNT;
        }
    }

    return pickDefaultAccount(team);
}

function attachPlanDetail(teammate: TeamMemberView): string {
    const spawnWarn = inProcessSpawnWarning(teammate);
    if (spawnWarn) {
        return pc.yellow(spawnWarn);
    }

    const t = teammate.transcript;
    if (t?.hasLeadAssignment && t.sessionId) {
        return pc.dim(`will --resume ${t.sessionId.slice(0, 8)}`);
    }

    return pc.yellow("will inject lead assignment after boot");
}

function attachActionLabel(teammate: TeamMemberView): string {
    if (isLiveSidechain(teammate.transcript)) {
        return pc.yellow("Do not spawn: in-process still live (attach would re-invoke)");
    }

    if (isInProcessMate(teammate)) {
        return pc.yellow("Resume lead only: in-process attach does not restore last tool call");
    }

    return pc.cyan("Launch / re-attach (new window or foreground)");
}

function splitActionLabel(teammate: TeamMemberView): string {
    if (isInProcessMate(teammate)) {
        return pc.yellow("Do not split-spawn: that starts a new session and re-invokes");
    }

    return pc.cyan("Split lead tmux pane + launch with OAuth");
}

async function runTeammateActions(
    team: TeamView,
    teammate: TeamMemberView,
    accountFlag?: string
): Promise<"back" | "quit" | "refresh"> {
    const freshTeam = discoverTeam(team.teamName) ?? team;
    const freshMate = freshTeam.teammates.find((m) => m.member.name === teammate.member.name) ?? teammate;
    const account = await resolveAccountForUi(freshTeam, accountFlag);
    const cmd = buildToolsCcTeammateCommand(account, freshTeam, freshMate);

    const action = await tableSelect({
        message: `${freshMate.member.name} · ${freshTeam.teamName}`,
        hint: isInProcessMate(freshMate)
            ? `account ${account} · in-process attach re-invokes, it does not restore the last tool call`
            : `account ${account}`,
        columns: [{ label: "ACTION", minWidth: 48 }],
        rows: [
            {
                value: "focus",
                cells: [
                    freshMate.live || isLiveSidechain(freshMate.transcript)
                        ? pc.green("Focus live pane (select in tmux)")
                        : pc.dim("Focus live pane (not running)"),
                ],
                detail: [
                    freshMate.live ? pc.dim(`${freshMate.live.tmuxSession}:${freshMate.live.tmuxPaneId}`) : "",
                    isLiveSidechain(freshMate.transcript)
                        ? pc.yellow("in-process: focus the lead pane. Do not attach-spawn.")
                        : "",
                ].filter(Boolean),
            },
            {
                value: "split",
                cells: [splitActionLabel(freshMate)],
                detail: [
                    attachPlanDetail(freshMate),
                    freshTeam.tmuxSession
                        ? pc.dim(`lead tmux ${freshTeam.tmuxSession}`)
                        : pc.yellow("No lead tmux session detected"),
                    pc.dim(ellipsize(cmd, 90)),
                ],
            },
            {
                value: "attach",
                cells: [attachActionLabel(freshMate)],
                detail: [attachPlanDetail(freshMate), pc.dim(ellipsize(cmd, 90))],
            },
            {
                value: "print",
                cells: [pc.white("Print command only")],
                detail: [pc.dim(ellipsize(cmd, 90))],
            },
            {
                value: "back",
                cells: [pc.dim("← back")],
                detail: [],
            },
        ],
    });

    if (!action || action === "back") {
        return "back";
    }

    if (action === "print") {
        out.println("");
        out.println(pc.bold("Command:"));
        out.println(cmd);
        out.println("");
        return "back";
    }

    if (action === "focus" && !freshMate.live && !isLiveSidechain(freshMate.transcript)) {
        out.println(pc.yellow("Teammate is not running. Use split or attach."));
        return "back";
    }

    try {
        const result = await launchTeammate({
            team: freshTeam,
            teammate: freshMate,
            account,
            mode: action as "focus" | "attach" | "split",
        });
        const mark = result.action === "noop" ? pc.yellow("•") : pc.green("✓");
        out.println(`${mark} ${result.detail}`);
        if (result.command && action !== "focus") {
            out.println(pc.dim(result.command));
        }

        if (
            (action === "split" || action === "attach") &&
            result.action !== "noop" &&
            !freshMate.transcript?.hasLeadAssignment &&
            !freshMate.transcript?.sidechain
        ) {
            out.println(
                pc.dim("If the mate boots empty, the lead assignment is injected when missing from the transcript.")
            );
        }
    } catch (error) {
        out.println(pc.red(error instanceof Error ? error.message : String(error)));
    }

    return "back";
}
