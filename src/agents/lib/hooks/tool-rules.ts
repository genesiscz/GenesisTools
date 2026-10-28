// Shell guard rules about GenesisTools' own commands. They sit here and not in src/utils/shell/rules, because those
// modules are copied into another repo where `tools` names a different binary.

import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SHELL_RULES, type ShellMatch, type ShellRule } from "@genesiscz/utils/shell/rules";
import { commandTokenIndex, commandWord, originalSlice, splitPipeline, tokenize } from "@genesiscz/utils/shell/scan";

/** The `tools rm` verbs that let a request through, trust a folder, or change settings: a person's to run. */
const RM_USER_VERB =
    /(?:^|[\s;&|(])(?:\S*\/)?tools\s+rm\s+(?:approve|roots\s+add|config\s+set|profile\s+(?:set|remove))\b|[\\/]rm[\\/]index\.ts\s+(?:approve|roots\s+add|config\s+set|profile\s+(?:set|remove))\b/;

export const rmUserVerbs: ShellRule = {
    id: "rm-user-verbs",
    kind: "destructive",
    title: `${toolCommand("rm")} approve, roots add, config set and profile set/remove are the user's to run, never an agent's`,
    severity: "block",
    why:
        `\`${toolCommand("rm")}\` lets an agent delete presets, its own scratch and its own files; anything else becomes a request ` +
        "the USER confirms. `approve` deletes what the request names, `roots add` trusts a whole folder, and " +
        "`config set` moves the trash the drain empties, so an agent that ran them would approve itself. The verb " +
        "also asks for a typed code or a macOS dialog; this rule stops the call before it gets that far.",
    wrong: `${toolCommand("rm")} approve k7m2qd`,
    right: `${toolCommand("rm")} requests`,
    evidence:
        "Martin, 2026-10-27: agents delete their own things freely, and anything more is confirmed by the user with " +
        "a command the agent cannot run.",
    detect(scan): ShellMatch | null {
        // The scanned statements, not the raw command: quoted text is blanked there (except a body the shell runs,
        // such as bash -c '...'), so a script or a message that only mentions the verb is not blocked.
        for (const statements of scan.units) {
            for (const statement of statements) {
                const match = RM_USER_VERB.exec(statement.text);

                if (!match) {
                    continue;
                }

                const lead = match[0].length - match[0].trimStart().length;
                return { matched: match[0].trim(), index: statement.start + match.index + lead };
            }
        }

        return null;
    },
};

/** A bare `rm` (or `xargs rm`): no undo, and no check of what it deletes. */
export const rmUseToolsRm: ShellRule = {
    id: "rm-use-tools-rm",
    kind: "destructive",
    title: `rm deletes with no undo and no check of what it deletes; ${toolCommand("rm")} moves it aside first`,
    severity: "block",
    why:
        "`rm -rf` on a wrong path (an empty variable, a typo, a worktree with uncommitted work) is gone for good. " +
        `\`${toolCommand("rm")}\` refuses system folders, home and the current folder, refuses tracked or uncommitted git work ` +
        "unless the user confirms, moves what it deletes into a trash that drains in the background, and keeps a " +
        `ledger, so \`${toolCommand("rm")} restore\` can undo a mistake during the grace period.`,
    wrong: "rm -rf node_modules dist",
    right: `${toolCommand("rm")} node_modules dist`,
    evidence:
        "Martin's AGENTS.md bans rm (move aside instead), and the permission hook denied it with no replacement " +
        `until ${toolCommand("rm")} (2026-10-27).`,
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!/\brm\b/.test(statement.text)) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens);

                    if (cmd === -1) {
                        continue;
                    }

                    const word = commandWord(tokens[cmd].text);
                    const rmAt =
                        word === "rm"
                            ? cmd
                            : word === "xargs"
                              ? tokens.findIndex((t, i) => i > cmd && commandWord(t.text) === "rm")
                              : -1;

                    if (rmAt === -1) {
                        continue;
                    }

                    const start = tokens[rmAt].start;
                    const matched = originalSlice(scan, start, element.start + element.text.length);
                    const corrected = matched.replace(
                        /^(?:\S*\/)?rm((?:\s+-\S+)*)(\s+--)?\s+/,
                        `${toolCommand("rm")} `
                    );
                    const suggestion =
                        word === "rm" && corrected !== matched ? scan.command.replace(matched, corrected) : undefined;
                    return { matched, index: start, suggestion };
                }
            }
        }

        return null;
    },
};

export const GENESIS_TOOLS_RULES: readonly ShellRule[] = [rmUserVerbs, rmUseToolsRm];

/** Every rule the guard runs before custom ones: the shared registry plus GenesisTools' own. */
export const BUILT_IN_RULES: readonly ShellRule[] = [...SHELL_RULES, ...GENESIS_TOOLS_RULES];
