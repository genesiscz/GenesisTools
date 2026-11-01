// Shell guard rules about GenesisTools' own commands. They sit here and not in src/utils/shell/rules, because those
// modules are copied into another repo where `tools` names a different binary.

import { isAbsolute } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { scratchRootNames } from "@genesiscz/utils/rm/scratch-dirs";
import { SHELL_RULES, type ShellMatch, type ShellRule } from "@genesiscz/utils/shell/rules";
import {
    commandTokenIndex,
    commandWord,
    originalSlice,
    type ShellScan,
    type Span,
    splitPipeline,
    tokenize,
} from "@genesiscz/utils/shell/scan";

/**
 * The verbs that let a request through, trust a folder, change settings, or end every batch's grace period
 * (`drain --now` deletes what a person approved with "Move to the trash" and other sessions' batches at once).
 */
const RM_USER_VERBS = String.raw`(?:(?:approve|roots\s+add|config\s+set|profile\s+(?:set|remove))\b${String.raw`(?=\s+(?!--help\b|-h\b)[^\s;&|)])`}|drain\b[^;&|\n]*?\s--now\b)`;
/**
 * Root flags may stand between `rm` and the verb, and Commander still runs the verb (`tools rm -v approve x`,
 * `tools rm -- approve x`), so the rule skips them: `--reason` and `--keep` with their value, any other `-` token.
 */
const RM_ROOT_FLAGS = String.raw`(?:(?:--(?:reason|keep)(?:\s+|=)\S+|-\S+)\s+)*`;
/** The `tools rm` verbs that let a request through, trust a folder, or change settings: a person's to run. */
const RM_USER_VERB = new RegExp(
    String.raw`(?:^|[\s;&|(])(?:\S*\/)?tools\s+rm\s+${RM_ROOT_FLAGS}${RM_USER_VERBS}|[\\/]rm[\\/]index\.ts\s+${RM_ROOT_FLAGS}${RM_USER_VERBS}`
);

/** `tools rm approve <one id>` in the statement, for the suggestion: the agent's verb with the same id. */
const RM_APPROVE_ONE = /((?:^|[\s;&|(])(?:\S*\/)?tools\s+rm\s+)approve(\s+[a-z0-9]{4,12})(?=\s*(?:$|[;&|)]))/;

export const rmUserVerbs: ShellRule = {
    id: "rm-user-verbs",
    kind: "destructive",
    title: `${toolCommand("rm")} approve, roots add, config set, profile set/remove and drain --now are the user's to run, never an agent's`,
    severity: "block",
    why:
        `\`${toolCommand("rm")}\` lets an agent delete presets, its own scratch and its own files; anything else becomes a request ` +
        "the USER decides. `approve` is the person's verb: run by a person, it may take a typed code on their terminal. " +
        "`ask` is the agent's verb: it only opens the person's approval window (Touch ID through GenesisTools.app, armed " +
        "by a click, or the macOS dialog) and never approves by itself. `roots add` trusts a whole folder, `config set` " +
        "moves the trash the drain empties, and `drain --now` ends the restore window of every batch in the trash (the " +
        "ones a person approved too): those are the person's as well.",
    wrong: `${toolCommand("rm")} approve k7m2qd`,
    right: `${toolCommand("rm")} ask k7m2qd`,
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
                const one = RM_APPROVE_ONE.exec(scan.command);
                const suggestion = one ? scan.command.replace(RM_APPROVE_ONE, "$1ask$2") : undefined;
                return {
                    matched: match[0].trim(),
                    index: statement.start + match.index + lead,
                    ...(suggestion ? { suggestion } : {}),
                };
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
                    const cmd = commandTokenIndex(tokens, scan.command);

                    if (cmd === -1) {
                        continue;
                    }

                    const word = commandWord(tokens[cmd].text);
                    // `commandTokenIndex` skips wrappers with their options (`xargs -n 1 rm`, `sudo rm`), so the
                    // command word is what runs: `xargs git rm` is git.
                    const rmAt = word === "rm" ? cmd : -1;

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
                        word === "rm" && corrected !== matched
                            ? scan.command.slice(0, start) + corrected + scan.command.slice(start + matched.length)
                            : undefined;
                    return { matched, index: start, suggestion };
                }
            }
        }

        return null;
    },
};

/** A full session id as the harnesses write it: a UUID. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The agent scratch roots directly in /tmp: never loose themselves. */
const SCRATCH_ROOT_NAMES = scratchRootNames();
const TEMP_CHILD = /^(?:\/private)?\/tmp\/([^/]+)\/?$|^\$\{?TMPDIR\}?\/([^/]+)\/?$/;
const CC_SCRATCH = /^(?:\/private)?\/tmp\/cc\/[^/]+\/([^/]+)/;
const REDIRECT = /^(?:\d|&)?>>?\|?/;

/**
 * A path `tools rm` will not delete without asking: a file or folder directly in the temp root, or one under
 * `/tmp/cc/<project>/` whose session level is not a full session id.
 */
function isLooseScratch(path: string): boolean {
    const child = TEMP_CHILD.exec(path);

    if (child) {
        return !SCRATCH_ROOT_NAMES.has(child[1] ?? child[2] ?? "");
    }

    const level = CC_SCRATCH.exec(path)?.[1];
    return level !== undefined && !SESSION_UUID.test(level);
}

function unquote(arg: string): string {
    return arg.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * Where a pipeline element ends in the original command: the scanner blanks quoted text and trims the element, so a
 * trailing quoted argument lies past `element.text`, in the blanked run before the next separator.
 */
function elementEnd(scan: ShellScan, element: Span): number {
    let end = element.start + element.text.length;

    while (end < scan.cleaned.length && /\s/.test(scan.cleaned[end])) {
        end++;
    }

    return end;
}

/** The arguments of one pipeline element as typed (quotes kept), after `from`: the scanner blanks a quoted one. */
function rawArgsAfter(scan: ShellScan, from: number, end: number): Array<{ text: string; index: number }> {
    const out: Array<{ text: string; index: number }> = [];
    const re = /'[^']*'|"[^"]*"|\S+/g;
    const text = scan.command.slice(from, end);
    let m = re.exec(text);

    while (m) {
        out.push({ text: m[0], index: from + m.index });
        m = re.exec(text);
    }

    return out;
}

/** The paths one pipeline element writes: redirect targets, `-o`/`--output` values, and `tee` or `mkdir` arguments. */
function writeTargets(scan: ShellScan, element: Span): Array<{ text: string; index: number }> {
    const tokens = tokenize(element);
    const end = elementEnd(scan, element);
    const targets: Array<{ text: string; index: number }> = [];
    const cmd = commandTokenIndex(tokens, scan.command);
    const word = cmd === -1 ? "" : commandWord(tokens[cmd].text);

    for (const [i, token] of tokens.entries()) {
        const op =
            REDIRECT.exec(token.text)?.[0] ?? (token.text === "-o" || token.text === "--output" ? token.text : "");
        const attached = token.text.startsWith("--output=")
            ? token.text.slice("--output=".length)
            : token.text.slice(op.length);

        if (op === "" && !token.text.startsWith("--output=")) {
            continue;
        }

        if (attached.startsWith("&")) {
            continue;
        }

        if (attached !== "") {
            targets.push({ text: attached, index: token.start + token.text.length - attached.length });
            continue;
        }

        const [next] = rawArgsAfter(scan, token.start + token.text.length, tokens[i + 1]?.start ?? end);
        const value = next ?? rawArgsAfter(scan, token.start + token.text.length, end)[0];

        if (value) {
            targets.push(value);
        }
    }

    if (word === "tee" || word === "mkdir") {
        for (const arg of rawArgsAfter(scan, tokens[cmd].start + tokens[cmd].text.length, end)) {
            if (!arg.text.startsWith("-") && !REDIRECT.test(arg.text)) {
                targets.push(arg);
            }
        }
    }

    return targets.map((target) => ({
        text: unquote(target.text),
        index: target.index + (target.text !== unquote(target.text) ? 1 : 0),
    }));
}

/** A file or folder written directly in /tmp, or under /tmp/cc without a full session id: tools rm asks for it later. */
export const tmpLooseScratch: ShellRule = {
    id: "tmp-loose-scratch",
    // The kind only decides whether a long command softens a block; this rule is a warn either way.
    kind: "misread",
    title: `write scratch to /tmp/cc/<project>/<full session id>/, so ${toolCommand("rm")} deletes it without asking`,
    severity: "warn",
    why:
        `\`${toolCommand("rm")}\` deletes inside this session's scratch folder without asking only when its name is ` +
        "the FULL session id. A file directly in /tmp, or under /tmp/cc with no session folder or with a short id, " +
        "becomes a request the user must approve later, and an agent cannot clean up after itself.",
    wrong: "curl -sS https://example.com/a.json -o /tmp/a.json",
    right: "curl -sS https://example.com/a.json -o /tmp/cc/shop/aaaaaaaa-1111-4111-8111-111111111111/a.json",
    evidence:
        "2026-11-01: 5 of 24 open rm requests were loose /tmp files, and 4 (395 MB) were scratch folders named " +
        "with the 8-character session prefix.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                for (const element of splitPipeline(statement)) {
                    const loose = writeTargets(scan, element).find((target) => isLooseScratch(target.text));

                    if (loose) {
                        return { matched: loose.text, index: loose.index };
                    }
                }
            }
        }

        return null;
    },
};

const TOOLS_RM = /(?:^|[\s;&|(])(?:\S*\/)?tools\s+rm\b|[\\/]rm[\\/]index\.ts\b/;
const IN_CC_SCRATCH = /^(?:\/private)?\/tmp\/cc\//;

/** `mv <path outside scratch> /tmp/cc/...` next to `tools rm`: moving a path into scratch skips the user. */
export const rmMvIntoScratch: ShellRule = {
    id: "rm-mv-into-scratch",
    kind: "destructive",
    title: `run ${toolCommand("rm")} on the original path; moving it into scratch skips the user`,
    severity: "warn",
    why:
        `\`${toolCommand("rm")}\` deletes inside a session's scratch without asking because the session made what is ` +
        "there. A path moved in from elsewhere was not made by the session, so deleting it there skips the user's " +
        "check that the rule table would have asked for, and the user's work can go with it.",
    wrong:
        "mv ~/Downloads/old-build /tmp/cc/shop/aaaaaaaa-1111-4111-8111-111111111111/ && " +
        `${toolCommand("rm")} /tmp/cc/shop/aaaaaaaa-1111-4111-8111-111111111111/old-build`,
    right: `${toolCommand("rm")} ~/Downloads/old-build`,
    evidence: "2026-11-01: a session moved a folder it did not make into its scratch and deleted it there.",
    detect(scan): ShellMatch | null {
        const statements = scan.units.flat();

        if (!statements.some((statement) => TOOLS_RM.test(statement.text))) {
            return null;
        }

        const cwdInScratch = scan.cwd !== undefined && IN_CC_SCRATCH.test(`${scan.cwd}/`);

        for (const statement of statements) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const cmd = commandTokenIndex(tokens, scan.command);

                if (cmd === -1 || commandWord(tokens[cmd].text) !== "mv") {
                    continue;
                }

                const end = elementEnd(scan, element);
                const args = rawArgsAfter(scan, tokens[cmd].start + tokens[cmd].text.length, end).filter(
                    (arg) => !arg.text.startsWith("-")
                );
                const destination = args.at(-1);
                const sources = args.slice(0, -1).map((arg) => unquote(arg.text));
                const outside = (path: string) =>
                    !IN_CC_SCRATCH.test(path) && (isAbsolute(path) || path.startsWith("~") || !cwdInScratch);

                if (destination && IN_CC_SCRATCH.test(unquote(destination.text)) && sources.some(outside)) {
                    const index = tokens[cmd].start;
                    return { matched: scan.command.slice(index, destination.index + destination.text.length), index };
                }
            }
        }

        return null;
    },
};

export const GENESIS_TOOLS_RULES: readonly ShellRule[] = [rmUserVerbs, rmUseToolsRm, tmpLooseScratch, rmMvIntoScratch];

/** Every rule the guard runs before custom ones: the shared registry plus GenesisTools' own. */
export const BUILT_IN_RULES: readonly ShellRule[] = [...SHELL_RULES, ...GENESIS_TOOLS_RULES];
