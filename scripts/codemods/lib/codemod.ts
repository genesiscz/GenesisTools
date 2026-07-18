import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";

export interface SpecRewrite {
    /** Import-specifier prefix to replace, e.g. "@app/macos/lib/mail". */
    from: string;
    to: string;
    /** Skip the rewrite when the specifier continues with one of these suffixes (e.g. "/search-runner" for a file that stays behind). */
    unless?: string[];
    /** Restrict the rewrite to files under this path (default: whole repo). */
    scope?: string;
}

export interface FileRewrite {
    /** Repo-relative file whose exact import specifier changes (relative-import fixups). */
    file: string;
    from: string;
    to: string;
}

export interface Move {
    id: string;
    description: string;
    /** Applied in order — later entries may move a file back out of an earlier dir move. */
    gitMoves: Array<{ from: string; to: string }>;
    specRewrites: SpecRewrite[];
    fileRewrites?: FileRewrite[];
    /** New files to create (e.g. a barrel at the new location). */
    createFiles?: Array<{ path: string; content: string }>;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All tracked .ts/.tsx files that mention a given specifier prefix. */
async function filesMentioning(prefix: string, scope: string): Promise<string[]> {
    const glob1 = "*.ts";
    const glob2 = "*.tsx";
    const exclude = "!node_modules";
    // Never rewrite the codemod scripts themselves — their MOVES tables contain
    // the very specifiers being rewritten (learned the hard way).
    const excludeSelf = "!scripts/codemods";
    const raw = await $`rg -l -g ${exclude} -g ${excludeSelf} -g ${glob1} -g ${glob2} -F ${prefix} ${scope}`
        .nothrow()
        .text();
    return raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

export async function applyMove(move: Move, dry: boolean): Promise<void> {
    console.log(`\n=== ${move.id}: ${move.description}${dry ? " (DRY RUN)" : ""} ===`);

    for (const m of move.gitMoves) {
        console.log(`  git mv ${m.from} -> ${m.to}`);
        if (!dry) {
            mkdirSync(dirname(m.to), { recursive: true });
            await $`git mv ${m.from} ${m.to}`;
        }
    }

    for (const cf of move.createFiles ?? []) {
        console.log(`  create ${cf.path}`);
        if (!dry) {
            mkdirSync(dirname(cf.path), { recursive: true });
            await Bun.write(cf.path, cf.content);
        }
    }

    for (const rw of move.specRewrites) {
        const files = await filesMentioning(rw.from, rw.scope ?? ".");
        // Match `"<from>` or `'<from>` followed by a closing quote, `/`, or `.`
        // (explicit-extension imports like `X.ts`), optionally guarded by
        // negative lookaheads for the `unless` suffixes.
        const unlessGuard = (rw.unless ?? []).map((u) => `(?!${escapeRegExp(u)})`).join("");
        const re = new RegExp(`(["'])${escapeRegExp(rw.from)}${unlessGuard}(?=["'/.])`, "g");
        let touched = 0;
        for (const file of files) {
            const before = await Bun.file(file).text();
            const after = before.replace(re, `$1${rw.to}`);
            if (after !== before) {
                touched++;
                if (!dry) {
                    await Bun.write(file, after);
                }
            }
        }

        console.log(`  spec ${rw.from} -> ${rw.to}: ${touched} files`);
    }

    for (const rw of move.fileRewrites ?? []) {
        if (!(await Bun.file(rw.file).exists())) {
            if (dry) {
                console.log(`  file ${rw.file}: (post-move path, skipped in dry run)`);
                continue;
            }

            console.warn(`  ⚠ ${rw.file}: missing`);
            continue;
        }

        const before = await Bun.file(rw.file).text();
        const after = before.replaceAll(`"${rw.from}"`, `"${rw.to}"`).replaceAll(`'${rw.from}'`, `'${rw.to}'`);
        if (after === before) {
            console.warn(`  ⚠ ${rw.file}: specifier "${rw.from}" not found (already rewritten?)`);
        } else if (!dry) {
            await Bun.write(rw.file, after);
        }

        console.log(`  file ${rw.file}: "${rw.from}" -> "${rw.to}"`);
    }
}
