/**
 * Shell command fixer — 1:1 translation of raycast/fix-paste-command/fix-paste-command.sh
 *
 * This is a faithful port of the bash script logic to TypeScript,
 * preserving the exact same regex patterns and step ordering.
 * Used to compare against the preprocess.ts approach and find gaps.
 */

export function fixShellCommand(input: string): string {
    if (!input) {
        return "";
    }

    // --- Normalize line endings (strip \r) ---
    let clipboard = input.replace(/\r/g, "");

    let isBashWrapped = false;

    // --- Strip Bash(...) wrapper from Claude Code tool output ---
    if (clipboard.startsWith("Bash(")) {
        isBashWrapped = true;
        clipboard = clipboard.slice("Bash(".length);

        // Remove trailing ) — only the LAST one (the wrapper close)
        const lastParen = clipboard.lastIndexOf(")");

        if (lastParen !== -1) {
            clipboard = clipboard.slice(0, lastParen);
        }

        // Dedent: strip common leading whitespace (skip unindented lines like
        // the first line which sits right after "Bash(")
        // perl -0777 -pe: find min indent of indented lines, strip that many spaces
        const lines = clipboard.split("\n");
        let minIndent = 999;

        for (const line of lines) {
            if (/^\s*$/.test(line)) {
                continue; // skip empty lines
            }

            if (!/^\s/.test(line)) {
                continue; // skip lines with no leading whitespace
            }

            const match = line.match(/^(\s*)/);
            const indent = match ? match[1].length : 0;

            if (indent < minIndent) {
                minIndent = indent;
            }
        }

        if (minIndent > 0 && minIndent < 999) {
            clipboard = lines
                .map((line) => {
                    if (line.length >= minIndent && /^\s/.test(line)) {
                        return line.slice(minIndent);
                    }

                    return line;
                })
                .join("\n");
        }
    }

    // --- Fix broken lines ---

    // Step 0: Strip flattened continuations — terminal copy sometimes replaces
    // \+newline with \+spaces on the SAME line. "\ " (single space) is a legit
    // escaped space in paths, so only strip \+2-or-more spaces.
    // perl -pe 's/\\\h{2,}/ /g'
    let fixed = clipboard.replace(/\\[ \t]{2,}/g, " ");

    // Step 1: Join \-continuation lines (\ + optional whitespace + newline + whitespace → space)
    // perl -0777 -pe 's/\\\h*\n\h*/ /g'
    fixed = fixed.replace(/\\[ \t]*\n[ \t]*/g, " ");

    // Step 2: For non-Bash() content, join terminal-wrapped lines
    if (!isBashWrapped) {
        // perl -0777 -pe:
        //   s/(\S)\n\h*(?=[a-zA-Z0-9._-])(?!\d+>)/$1/g;  — mid-word join (no space)
        //   s/\h*\n\h*/ /g;                                — word-boundary join (space)

        // We need to do this in a loop since JS doesn't support lookahead after \n well in replace
        // First pass: mid-word wraps
        fixed = fixed.replace(/(\S)\n[ \t]*(?=[a-zA-Z0-9._-])(?!\d+>)/g, "$1");

        // Second pass: word-boundary wraps (remaining newlines)
        fixed = fixed.replace(/[ \t]*\n[ \t]*/g, " ");
    }

    // Step 3: Collapse runs of spaces into one, trim leading/trailing
    // sed -E 's/  +/ /g; s/^ +//; s/ +$//'
    fixed = fixed.replace(/ {2,}/g, " ").replace(/^ +/, "").replace(/ +$/, "");

    // --- Re-split single commands with proper \ per long flag ---
    // Only split at --long-flags (not short -r, -rf, -c which break commands)
    const lineCount = fixed.split("\n").length;

    if (lineCount === 1 && / --[a-zA-Z]/.test(fixed)) {
        fixed = fixed.replace(/ (--)(?=[a-zA-Z])/g, " \\\n  $1");
    }

    // Strip trailing whitespace from every line
    // sed 's/[[:space:]]*$//'
    fixed = fixed
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .join("\n");

    // Remove trailing blank lines
    fixed = fixed.replace(/\n+$/, "");

    return fixed;
}
