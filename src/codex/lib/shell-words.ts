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
