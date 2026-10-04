import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { defineTransclusion, TransclusionError } from "../registry";
import { codeBlock } from "./shared";

const MAX_TIMEOUT_MS = 30_000;

/** Read-only git subcommands. Anything that can write, fetch or run a program is not listed. */
export const CMD_GIT_SUBCOMMANDS = [
    "log",
    "show",
    "status",
    "diff",
    "blame",
    "rev-parse",
    "ls-files",
    "shortlog",
    "describe",
    "merge-base",
] as const;

/**
 * Git flags that write a file or run an external program. Global options such as `-c` and `-C` never
 * reach git: the word after `git` must be an allowlisted subcommand.
 */
const GIT_FORBIDDEN_FLAG = /^(?:--output|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--config)/;

/**
 * Read-only `tools` verbs, matched on their leading words, each with the only flags it may take. A
 * verb with a writing flag (`git merged --prune`) is read-only only without it, so every other dash
 * argument is refused rather than a list of bad ones kept.
 */
export const CMD_TOOLS_VERBS: readonly { words: readonly string[]; flags: readonly string[] }[] = [
    {
        words: ["ts", "skeleton"],
        flags: [
            "--exported",
            "--top-level",
            "--types",
            "--include-names",
            "--include-hash",
            "--include-locals",
            "--function-context",
            "--exact-tokens",
            "--tests",
            "--ignore",
            "--format",
            "--md",
            "--json",
            "--json-compact",
            "--toon",
        ],
    },
    { words: ["git", "base"], flags: ["-b", "--base", "--offline", "--json", "-C", "--cwd"] },
    {
        words: ["git", "merged"],
        flags: ["-b", "--base", "--pr", "--json", "--all", "-d", "--stale-days", "-C", "--cwd"],
    },
    { words: ["question", "list"], flags: ["--type", "--all-sessions", "--session", "--status", "--json"] },
    { words: ["question", "tokens"], flags: ["--format", "--cwd"] },
];

/**
 * Splits a command line into argv the way a shell would for plain words and quotes, and refuses
 * everything that would need a shell: pipes, redirects, `;`, `&`, `$`, backticks, subshells.
 */
export function splitCommandLine(line: string): string[] {
    const argv: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let started = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (quote) {
            if (char === quote) {
                quote = null;
            } else if (char === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) {
                current += line[++i];
            } else {
                current += char;
            }

            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }

        if (/\s/.test(char)) {
            if (started) {
                argv.push(current);
                current = "";
                started = false;
            }

            continue;
        }

        if ("|&;<>$`()\\".includes(char)) {
            throw new TransclusionError(
                `cmd runs one command without a shell; "${char}" is not allowed outside quotes`
            );
        }

        current += char;
        started = true;
    }

    if (quote) {
        throw new TransclusionError(`cmd: unterminated ${quote} quote`);
    }

    if (started) {
        argv.push(current);
    }

    return argv;
}

/** Throws with the allowed set when the argv is not an allowlisted read-only command. */
export function checkAllowed(argv: string[]): void {
    const allowedGit = CMD_GIT_SUBCOMMANDS.map((sub) => `git ${sub}`).join(", ");
    const allowedTools = CMD_TOOLS_VERBS.map((verb) => `tools ${verb.words.join(" ")}`).join(", ");
    const allowed = `allowed: ${allowedGit}, ${allowedTools}`;

    if (argv[0] === "git") {
        const sub = argv[1] ?? "";

        if (!(CMD_GIT_SUBCOMMANDS as readonly string[]).includes(sub)) {
            throw new TransclusionError(`cmd: "git ${sub}" is not on the read-only list (${allowed})`);
        }

        const bad = argv.slice(2).find((arg) => GIT_FORBIDDEN_FLAG.test(arg));

        if (bad) {
            throw new TransclusionError(`cmd: git flag "${bad}" can write files or run programs, so it is refused`);
        }

        return;
    }

    if (argv[0] === "tools") {
        const verb = CMD_TOOLS_VERBS.find((entry) => entry.words.every((word, index) => argv[index + 1] === word));

        if (!verb) {
            throw new TransclusionError(
                `cmd: "tools ${argv.slice(1, 3).join(" ")}" is not on the read-only list (${allowed})`
            );
        }

        const bad = argv
            .slice(verb.words.length + 1)
            .find((arg) => arg.startsWith("-") && !verb.flags.includes(arg.split("=")[0] ?? arg));

        if (bad) {
            throw new TransclusionError(
                `cmd: "tools ${verb.words.join(" ")}" does not take "${bad}" here (read-only flags: ${verb.flags.join(" ")})`
            );
        }

        return;
    }

    throw new TransclusionError(`cmd: "${argv[0] ?? ""}" is not allowed (${allowed})`);
}

export const cmdTransclusion = defineTransclusion({
    name: "cmd",
    description:
        "The output of one allowlisted read-only command (git log/show/status/diff/blame/rev-parse/ls-files/" +
        `shortlog/describe/merge-base, ${toolCommand("ts skeleton")}, ${toolCommand("git base")}|merged, ${toolCommand("question list")}|tokens). ` +
        "No shell, a timeout, and the exit code is shown.",
    params: [
        { name: "run", type: "string", required: true, description: "The command line, e.g. git log --oneline -5." },
        { name: "cwd", type: "path", description: "Run it here instead of the caller's cwd." },
        {
            name: "timeout",
            type: "int",
            default: 10_000,
            description: `Milliseconds, at most ${MAX_TIMEOUT_MS} and never past the token's own deadline.`,
        },
    ],
    examples: [
        '{{cmd run="git log --oneline -5"}}',
        `{{cmd run="${toolCommand("ts skeleton")} src/utils/transclude/engine.ts"}}`,
    ],
    action: "substitute",
    async resolve(params, ctx) {
        const line = params.string("run");
        const argv = splitCommandLine(line);
        checkAllowed(argv);
        // Never past the token's own deadline: the engine aborts there anyway.
        const timeoutMs = Math.max(
            1,
            Math.min(Math.max(100, params.int("timeout")), MAX_TIMEOUT_MS, ctx.deadline - Date.now())
        );
        const finalArgv =
            argv[0] === "git" && ["diff", "show", "log"].includes(argv[1])
                ? ["git", "--no-pager", argv[1], "--no-ext-diff", "--no-textconv", ...argv.slice(2)]
                : argv[0] === "git"
                  ? ["git", "--no-pager", ...argv.slice(1)]
                  : argv;
        const cwd = params.optionalString("cwd") ?? ctx.cwd;
        const result = await ctx.run(finalArgv, {
            cwd,
            signal: ctx.signal,
            timeoutMs,
            env: { GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
        });

        if (result.code === 127 && !result.stdout) {
            throw new TransclusionError(`cmd could not start "${argv[0]}": ${result.stderr.trim()}`);
        }

        if (result.code === 124) {
            throw new TransclusionError(`cmd timed out after ${timeoutMs} ms: ${line}`);
        }

        const parts = [
            codeBlock({
                text: result.stdout.trimEnd() || "(no output)",
                lang: "text",
                title: `\`$ ${line}\` · exit ${result.code}${result.truncated ? " · output cut at 5 MB" : ""}`,
            }),
        ];

        if (result.stderr.trim()) {
            parts.push(codeBlock({ text: result.stderr.trimEnd(), lang: "text", title: "stderr:" }));
        }

        return {
            markdown: parts.join("\n"),
            meta: { argv: finalArgv, exit: result.code, cwd },
            block: true,
            source: `$ ${line} (exit ${result.code})`,
        };
    },
});
