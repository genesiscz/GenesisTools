import { resolve } from "node:path";
import { out } from "@genesiscz/utils/logger";
import { appendRmLedger, callerAgentName, isAskAction, type RmProfile, saveRmConfig } from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { minutesOption, requirePerson, runContext } from "../lib/run";

interface ProfileFlags {
    agent?: string;
    session?: string;
    project?: string;
    cwd?: string;
    askAction?: string;
    asideUnsaved?: boolean;
    sessionScratch?: boolean;
    ownFiles?: boolean;
    gracePreset?: number;
    graceOther?: number;
    disablePreset?: string[];
    root?: string[];
    protect?: string[];
    note?: string;
}

function describeMatch(profile: RmProfile): string {
    const { agent, session, project, cwd } = profile.match;
    return (
        [
            agent && `agent ${agent}`,
            session && `session ${session}`,
            project && `project ${project}`,
            cwd && `in ${cwd}`,
        ]
            .filter(Boolean)
            .join(", ") || "everyone"
    );
}

interface PolicyView {
    askAction?: string;
    asideUnsaved?: boolean;
    allowSessionScratch?: boolean;
    allowOwnFiles?: boolean;
    grace?: { presetMinutes?: number; otherMinutes?: number };
    disabledPresets?: string[];
    protect?: string[];
    roots?: Array<string | { path: string }>;
}

function describePolicy(config: PolicyView): string[] {
    const lines: string[] = [];

    if (config.askAction) {
        lines.push(`needs the user: ${config.askAction === "aside" ? "move aside" : "leave in place"}`);
    }

    if (config.asideUnsaved !== undefined) {
        lines.push(`unsaved work aside too: ${config.asideUnsaved ? "yes" : "no"}`);
    }

    if (config.allowSessionScratch !== undefined) {
        lines.push(`own scratch without asking: ${config.allowSessionScratch ? "yes" : "no"}`);
    }

    if (config.allowOwnFiles !== undefined) {
        lines.push(`own files without asking: ${config.allowOwnFiles ? "yes" : "no"}`);
    }

    if (config.grace) {
        lines.push(
            `grace: presets ${config.grace.presetMinutes ?? "-"} min, others ${config.grace.otherMinutes ?? "-"} min`
        );
    }

    if (config.disabledPresets?.length) {
        lines.push(`presets off: ${config.disabledPresets.join(", ")}`);
    }

    if (config.protect?.length) {
        lines.push(`protected: ${config.protect.join(", ")}`);
    }

    const roots = config.roots?.map((r) => (typeof r === "string" ? r : r.path)) ?? [];

    if (roots.length > 0) {
        lines.push(`trusted roots: ${roots.join(", ")}`);
    }

    return lines;
}

export function registerProfileCommands(program: Command): void {
    program
        .command("profiles")
        .description("settings per agent, session or project, and what applies to this caller")
        .option("--json", "print as JSON")
        .action((flags: { json?: boolean }) => {
            const ctx = runContext();

            if (flags.json) {
                out.result({
                    profiles: ctx.base.profiles,
                    applied: ctx.profiles,
                    caller: ctx.caller,
                    effective: ctx.config,
                });
                return;
            }

            if (ctx.base.profiles.length === 0) {
                out.println(
                    "No profiles. Add one with: tools rm profile set <name> --agent codex --ask-action request"
                );
            }

            for (const profile of ctx.base.profiles) {
                const on = ctx.profiles.includes(profile.name) ? pc.green(" (applies to you)") : "";
                out.println(`${pc.bold(profile.name)}${on} ${pc.dim(describeMatch(profile))}`);

                for (const line of describePolicy(profile)) {
                    out.println(`  ${line}`);
                }
            }

            const c = ctx.caller;
            out.println("");
            out.println(
                pc.bold("This caller: ") +
                    `${callerAgentName(c)}${c.sessionId ? ` session ${c.sessionId.slice(0, 8)}` : ""}` +
                    `${c.project ? `, project ${c.project}` : ""}` +
                    pc.dim(ctx.profiles.length > 0 ? ` (profiles: ${ctx.profiles.join(", ")})` : " (no profile)")
            );

            for (const line of describePolicy(ctx.config)) {
                out.println(`  ${line}`);
            }
        });

    const profile = program.command("profile").description("add, change or remove a profile (the user only)");

    profile
        .command("set")
        .description("create or replace a profile; every --agent/--session/--project/--cwd given must match")
        .argument("<name>", "the profile's name")
        .option("--agent <name>", "claude-code, codex, grok, copilot, or person")
        .option("--session <id>", "a session id or its prefix")
        .option("--project <name>", "the project folder name")
        .option("--cwd <dir>", "runs in this folder or below it")
        .option("--ask-action <action>", "aside or request: what happens to a path that needs the user")
        .option("--aside-unsaved", "also move unsaved work (untracked files, unpushed clones) aside")
        .option("--no-aside-unsaved", "keep unsaved work in place")
        .option("--session-scratch", "the session's own scratch goes without asking")
        .option("--no-session-scratch", "the session's own scratch needs the user too")
        .option("--own-files", "files the session wrote go without asking")
        .option("--no-own-files", "files the session wrote need the user too")
        .option("--grace-preset <duration>", "how long preset folders wait in the trash", minutesOption)
        .option("--grace-other <duration>", "how long everything else waits in the trash", minutesOption)
        .option("--disable-preset <ids...>", "presets this profile does not allow")
        .option("--root <dirs...>", "extra trusted roots")
        .option("--protect <paths...>", "extra paths that are never deleted")
        .option("--note <text>", "why the profile exists")
        .action(async (name: string, flags: ProfileFlags) => {
            const ctx = runContext();

            if (!flags.agent && !flags.session && !flags.project && !flags.cwd) {
                out.println(
                    pc.red(
                        "Give at least one of --agent, --session, --project, --cwd (tools rm config set changes everyone)."
                    )
                );
                process.exitCode = 1;
                return;
            }

            if (flags.askAction !== undefined && !isAskAction(flags.askAction)) {
                out.println(pc.red("--ask-action takes aside or request."));
                process.exitCode = 1;
                return;
            }

            const next: RmProfile = {
                name,
                match: {
                    agent: flags.agent,
                    session: flags.session,
                    project: flags.project,
                    cwd: flags.cwd ? resolve(flags.cwd) : undefined,
                },
                askAction: isAskAction(flags.askAction) ? flags.askAction : undefined,
                asideUnsaved: flags.asideUnsaved,
                allowSessionScratch: flags.sessionScratch,
                allowOwnFiles: flags.ownFiles,
                grace:
                    flags.gracePreset !== undefined || flags.graceOther !== undefined
                        ? { presetMinutes: flags.gracePreset, otherMinutes: flags.graceOther }
                        : undefined,
                disabledPresets: flags.disablePreset,
                roots: flags.root?.map((dir) => resolve(dir)),
                protect: flags.protect?.map((path) => resolve(path)),
                note: flags.note,
            };
            const lines = [describeMatch(next), ...describePolicy(next)];
            const answer = await requirePerson(ctx, {
                title: `Set the tools rm profile ${name}?`,
                lines,
                code: "profile",
            });

            if (!answer.approved) {
                return;
            }

            const profiles = ctx.base.profiles.filter((p) => p.name !== name);
            saveRmConfig({ ...ctx.base, profiles: [...profiles, next] });
            appendRmLedger({ action: "profile-set", reason: name, via: answer.via, caller: ctx.caller });
            out.println(pc.green(`Profile ${name} saved (applies to ${describeMatch(next)}).`));
        });

    profile
        .command("remove")
        .description("remove a profile")
        .argument("<name>", "the profile's name")
        .action(async (name: string) => {
            const ctx = runContext();

            if (!ctx.base.profiles.some((p) => p.name === name)) {
                out.println(pc.yellow(`No profile ${name}.`));
                process.exitCode = 1;
                return;
            }

            const answer = await requirePerson(ctx, {
                title: `Remove the tools rm profile ${name}?`,
                lines: [name],
                code: "profile",
            });

            if (!answer.approved) {
                return;
            }

            saveRmConfig({ ...ctx.base, profiles: ctx.base.profiles.filter((p) => p.name !== name) });
            appendRmLedger({ action: "profile-remove", reason: name, via: answer.via, caller: ctx.caller });
            out.println(`Profile ${name} removed.`);
        });
}
