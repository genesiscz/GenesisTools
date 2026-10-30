/**
 * The CLIs `tools zsh completions` knows, one entry each. Adding a CLI is one entry here: how to print its zsh
 * script, how to ask its version, how the script must be wired, and the hand-made rc wiring it may already have.
 */

/**
 * How the rc block makes zsh use the generated `_<cli>` file.
 *
 * - `fpath`: the file is an autoloadable function file (`#compdef <cli>` on line 1, the body ends by calling
 *   itself when autoloaded, as cobra's template does). The block puts the folder on `fpath`, marks `_<cli>`
 *   autoloaded and runs `compdef _<cli> <cli>`, so nothing of the file is read until the first Tab.
 * - `source`: the file must be sourced after compinit, because it defines helper functions and calls `compdef`
 *   itself at its end (bun's script). Autoloading it would only define the functions on the first Tab.
 */
export type CompletionWiring = "fpath" | "source";

/** A line range of the rc file, 0-based and inclusive. */
export interface LineRange {
    start: number;
    end: number;
}

/**
 * Completion wiring someone wrote by hand (or another installer wrote) for one CLI. The tool never changes such a
 * block without asking first.
 */
export interface HandWiring {
    /** Short words for the report: "the `# vitrinka-completion` marker block". */
    describe: string;
    /** Where the block sits in the rc lines, or undefined when the rc has none. */
    find(lines: readonly string[]): LineRange | undefined;
    /**
     * The lines that take the block's place when the user agrees to replace it. Absent means the block is never
     * offered for replacement (another installer owns it).
     */
    replacement?: readonly string[];
    /**
     * True when the block may stay while the tool wires the CLI too: it only adds an fpath entry or defines an
     * unused function, so the tool's later `compdef` wins without a conflict. False (the default) means a kept
     * block already wires the CLI, so the tool skips it.
     */
    coexists?: boolean;
}

export interface CompletionProvider {
    /** The command name, as `Bun.which` finds it and `compdef` maps it. The file and function are `_<cli>`. */
    cli: string;
    /** argv that prints the zsh completion script on stdout. */
    generate: readonly string[];
    /** argv that prints the version; its first line is stored, so `refresh` can say what changed. */
    version: readonly string[];
    wiring: CompletionWiring;
    /** Extra environment for the generator (bun picks the script by `$SHELL`). */
    generateEnv?: Readonly<Record<string, string>>;
    /** Hand-made wiring this CLI may already have in the rc file. */
    handWiring: readonly HandWiring[];
}

const TOOL_NOTE = "wired by tools zsh completions";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first line index at or after `from` that matches, or -1. */
function findLine(lines: readonly string[], pattern: RegExp, from = 0): number {
    for (let i = from; i < lines.length; i++) {
        if (pattern.test(lines[i] ?? "")) {
            return i;
        }
    }

    return -1;
}

/** One line `eval "$(<cli> completion zsh)"` or `source <(<cli> completion zsh)`: the startup cost this tool removes. */
function evalGeneratorLine(cli: string): HandWiring {
    const name = escapeRegExp(cli);
    const pattern = new RegExp(
        `^\\s*[^#]*(eval\\s+"?\\$\\(\\s*${name}\\s+(completion|completions)\\b[^)]*\\)"?|source\\s+<\\(\\s*${name}\\s+(completion|completions)\\b[^)]*\\))`
    );

    return {
        describe: `an \`eval "$(${cli} completion zsh)"\` line (runs ${cli} on every shell start)`,
        find(lines) {
            const index = findLine(lines, pattern);
            return index === -1 ? undefined : { start: index, end: index };
        },
        replacement: [`# ${cli} completion: ${TOOL_NOTE}`],
    };
}

/**
 * A cobra completion script pasted into the rc: from its `#compdef <cli>` line to the `fi` that closes the
 * trailing `if [ "$funcstack[1]" = "_<cli>" ]` block (commented out or not). Without that closing line the end is
 * not certain, so nothing is reported.
 */
function pastedCobraScript(cli: string): HandWiring {
    const name = escapeRegExp(cli);
    const startPattern = new RegExp(`^\\s*(eval\\s+)?#compdef\\s+${name}\\s*$`);
    const compdefPattern = new RegExp(`^\\s*compdef\\s+_${name}\\s+${name}\\s*$`);
    const tailPattern = new RegExp(`^\\s*#?\\s*if \\[ "\\$funcstack\\[1\\]" = "_${name}" \\]; then\\s*$`);
    const fiPattern = /^\s*#?\s*fi\s*$/;

    return {
        describe: `a pasted ${cli} completion script`,
        find(lines) {
            const start = findLine(lines, startPattern);

            if (start === -1 || !compdefPattern.test(lines[start + 1] ?? "")) {
                return undefined;
            }

            const tail = findLine(lines, tailPattern, start + 2);

            if (tail === -1) {
                return undefined;
            }

            const end = findLine(lines, fiPattern, tail + 1);
            return end === -1 ? undefined : { start, end };
        },
        replacement: [`# ${cli} completion: ${TOOL_NOTE}`],
    };
}

/** Cobra CLIs print an autoloadable script with `<cli> completion zsh` and may carry either kind of hand wiring. */
function cobra(
    cli: string,
    extra: { generate?: readonly string[]; handWiring?: readonly HandWiring[] } = {}
): CompletionProvider {
    return {
        cli,
        generate: extra.generate ?? [cli, "completion", "zsh"],
        version: [cli, "--version"],
        wiring: "fpath",
        handWiring: [...(extra.handWiring ?? []), evalGeneratorLine(cli), pastedCobraScript(cli)],
    };
}

/**
 * The `# vitrinka-completion` marker block. `vitrinka setup` reads the marker as "completion is done" and would
 * otherwise append its own eval line, so a replacement keeps a line that starts with the marker.
 */
const VITRINKA_MARKER: HandWiring = {
    describe: "the `# vitrinka-completion` marker block",
    find(lines) {
        const start = findLine(lines, /^\s*# vitrinka-completion\b/);

        if (start === -1) {
            return undefined;
        }

        let end = start;

        while (end + 1 < lines.length && end - start < 3 && (lines[end + 1] ?? "").includes("_vitrinka")) {
            end++;
        }

        return { start, end };
    },
    replacement: [`# vitrinka-completion: ${TOOL_NOTE} (vitrinka setup reads this marker, keep it)`],
};

/** Docker Desktop's block only puts its folder on fpath (lazily); Docker Desktop rewrites it, so it is never changed. */
const DOCKER_DESKTOP_BLOCK: HandWiring = {
    describe: "Docker Desktop's completion block",
    find(lines) {
        const start = findLine(lines, /added by Docker Desktop to enable Docker CLI completions/);

        if (start === -1) {
            return undefined;
        }

        const end = findLine(lines, /^\s*# End of Docker CLI completions/, start + 1);
        return end === -1 ? { start, end: start } : { start, end };
    },
    coexists: true,
};

/** `[ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"`, which bun's installer writes. */
const BUN_SOURCE_LINE: HandWiring = {
    describe: "bun's `source $BUN_INSTALL/_bun` line",
    find(lines) {
        const index = findLine(
            lines,
            /^\s*[^#]*\bsource\s+"?(\$BUN_INSTALL|\$\{BUN_INSTALL\}|\$HOME\/\.bun|~\/\.bun)\/_bun"?/
        );
        return index === -1 ? undefined : { start: index, end: index };
    },
    replacement: [`# bun completion: ${TOOL_NOTE}`],
};

/**
 * Not here: `tools` itself (commander has no zsh generator yet) and grok (its installer writes its own fpath
 * entry and compinit).
 */
export const COMPLETION_PROVIDERS: readonly CompletionProvider[] = [
    cobra("vitrinka", { handWiring: [VITRINKA_MARKER] }),
    cobra("gh", { generate: ["gh", "completion", "-s", "zsh"] }),
    cobra("glab", { generate: ["glab", "completion", "-s", "zsh"] }),
    cobra("docker", { handWiring: [DOCKER_DESKTOP_BLOCK] }),
    cobra("glow"),
    {
        cli: "bun",
        generate: ["bun", "completions"],
        version: ["bun", "--version"],
        wiring: "source",
        generateEnv: { SHELL: "/bin/zsh" },
        handWiring: [BUN_SOURCE_LINE],
    },
];

export function getCompletionProvider(cli: string): CompletionProvider | undefined {
    return COMPLETION_PROVIDERS.find((provider) => provider.cli === cli);
}

/** `_<cli>`: the generated file's name and the completion function it defines. */
export function completionFunctionName(cli: string): string {
    return `_${cli}`;
}
