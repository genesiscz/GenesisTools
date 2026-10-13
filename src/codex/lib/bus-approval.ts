/**
 * Which `--write ask` approval requests are the worker's own bus commands.
 *
 * The injected contract tells every worker to report in with `tools agents message` as its first action, and
 * `untrusted` asks before any command outside Codex's read-only set. So the first command of every `ask`
 * worker paused for the lead's approval (observed 2026-10-13, approval_request 0). The daemon accepts a
 * command itself only when it is exactly one of the seeded verbs, run as this worker in its own swarm, and
 * holds nothing a shell would expand or chain. Anything else still goes to the lead.
 */

/** Characters a bare (unquoted) word may hold: no expansion, globbing, redirection or chaining. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]$/;

/**
 * The words of one simple command, or null when the text holds anything beyond plain words: an operator,
 * a redirection, a newline, an expansion (`$`, backtick, `~`, globs) or an escape. Single quotes are literal;
 * double quotes are accepted only when nothing inside them would be expanded or escaped.
 */
export function strictShellWords(command: string): string[] | null {
    const words: string[] = [];
    let word: string | null = null;
    let index = 0;

    while (index < command.length) {
        const char = command[index];

        if (char === " " || char === "\t") {
            if (word !== null) {
                words.push(word);
                word = null;
            }

            index += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            const end = command.indexOf(char, index + 1);

            if (end === -1) {
                return null;
            }

            const inner = command.slice(index + 1, end);

            if (char === '"' && /[$`\\!]/.test(inner)) {
                return null;
            }

            word = (word ?? "") + inner;
            index = end + 1;
            continue;
        }

        if (!BARE.test(char)) {
            return null;
        }

        word = (word ?? "") + char;
        index += 1;
    }

    if (word !== null) {
        words.push(word);
    }

    return words;
}

const SHELL_WRAPPER = /(^|\/)(zsh|bash|sh)$/;

/** Flags each verb may carry; `true` = takes a value. The identity flag is checked separately. */
const VERB_FLAGS: Record<string, Record<string, boolean>> = {
    message: { "--from": true, "--to": true, "--body": true, "--body-file": true, "--reply": true, "--session": true },
    request: {
        "--from": true,
        "--to": true,
        "--body": true,
        "--body-file": true,
        "--timeout": true,
        "--session": true,
    },
    login: { "--agent-name": true, "--once": false, "--session": true, "--format": true, "--kinds": true },
    leave: { "--agent-name": true, "--note": true, "--session": true },
};

const IDENTITY_FLAG: Record<string, string> = {
    message: "--from",
    request: "--from",
    login: "--agent-name",
    leave: "--agent-name",
};

/** True when `command` is a seeded `tools agents` verb run as `agentName` in `session`, and nothing more. */
export function isOwnBusCommand(command: string, bus: { agentName: string; session: string }): boolean {
    const outer = strictShellWords(command);

    if (!outer) {
        return false;
    }

    const words =
        outer.length === 3 && SHELL_WRAPPER.test(outer[0]) && (outer[1] === "-lc" || outer[1] === "-c")
            ? strictShellWords(outer[2])
            : outer;

    if (words?.[0] !== "tools" || words[1] !== "agents") {
        return false;
    }

    const verb = words[2];
    const allowed = VERB_FLAGS[verb];

    if (!allowed) {
        return false;
    }

    const values = new Map<string, string>();

    for (let index = 3; index < words.length; index += 1) {
        const [flag, inline] = words[index].split(/=(.*)/s, 2);

        if (!(flag in allowed)) {
            return false;
        }

        if (!allowed[flag]) {
            if (inline !== undefined) {
                return false;
            }

            continue;
        }

        const value = inline ?? words[index + 1];

        if (value === undefined || values.has(flag)) {
            return false;
        }

        values.set(flag, value);

        if (inline === undefined) {
            index += 1;
        }
    }

    return values.get(IDENTITY_FLAG[verb]) === bus.agentName && values.get("--session") === bus.session;
}
