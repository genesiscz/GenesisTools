#!/usr/bin/env bun
/**
 * Deterministic fixture repositories for the gt:git evals, so a with-skill run and a baseline
 * run start from byte-identical repos.
 *
 *   bun plugins/genesis-tools/skills/git/evals/fixtures/build.ts <name> <dest-dir>
 *
 * Names: squash-merged-then-master-moved · recomposed-upstream-rebase · cleanup-with-dirty-worktree.
 * <dest-dir> must not exist. Prints the repo path. Run from the GenesisTools checkout (tsconfig paths).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "@genesiscz/utils/git/test-repo";

let epoch = 1_700_000_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
    epoch += 10;
    const res = await runGit({ cwd, args, epoch });

    if (res.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }

    return res.stdout;
}

async function commit(cwd: string, file: string, content: string, message: string): Promise<void> {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
    await git(cwd, "add", "--", file);
    await git(cwd, "commit", "-q", "-m", message);
}

async function seed(repo: string): Promise<void> {
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "master");
    await commit(repo, "README.md", "seed\n", "seed");
    await commit(repo, "src/app.ts", "export const app = 1;\n", "app");
}

const builders: Record<string, (dest: string) => Promise<string>> = {
    async "squash-merged-then-master-moved"(dest) {
        const repo = join(dest, "repo");
        await seed(repo);
        await git(repo, "checkout", "-q", "-b", "feat/x");
        await commit(repo, "src/feature.ts", "export const feature = 'x';\n", "feat: add feature");
        await commit(repo, "src/feature.test.ts", "test('x', () => {});\n", "test: cover feature");
        await git(repo, "checkout", "-q", "master");
        await git(repo, "merge", "-q", "--squash", "feat/x");
        await git(repo, "commit", "-q", "-m", "feat: feature (#12)");

        for (let i = 1; i <= 10; i++) {
            await commit(repo, `src/other-${i}.ts`, `export const other${i} = ${i};\n`, `chore: unrelated change ${i}`);
        }

        return repo;
    },

    async "recomposed-upstream-rebase"(dest) {
        const repo = join(dest, "repo");
        await seed(repo);
        await git(repo, "checkout", "-q", "-b", "feat/y");
        const files = ["a", "b", "c", "d", "e", "f"];

        for (const f of files) {
            await commit(repo, `src/${f}.ts`, `export const ${f} = "${f}";\n`, `feat: add ${f}`);
        }

        await commit(repo, "src/new-work.ts", "export const newWork = true;\n", "feat: genuinely new work");
        await git(repo, "checkout", "-q", "master");

        for (const f of ["a", "b", "c"]) {
            writeFileSync(join(repo, "src", `${f}.ts`), `export const ${f} = "${f}";\n`);
        }

        await git(repo, "add", "src/a.ts", "src/b.ts", "src/c.ts");
        await git(repo, "commit", "-q", "-m", "feat: a, b and c (#20, recomposed)");

        for (const f of ["d", "e", "f"]) {
            writeFileSync(join(repo, "src", `${f}.ts`), `export const ${f} = "${f}";\n`);
        }

        await git(repo, "add", "src/d.ts", "src/e.ts", "src/f.ts");
        await git(repo, "commit", "-q", "-m", "feat: d, e and f (#21, recomposed)");
        await commit(repo, "src/app.ts", "export const app = 2;\n", "chore: bump app");
        return repo;
    },

    async "cleanup-with-dirty-worktree"(dest) {
        const repo = join(dest, "repo");
        await seed(repo);

        for (const name of ["a", "b"]) {
            await git(repo, "checkout", "-q", "-b", `feat/${name}`);
            await commit(repo, `src/${name}.ts`, `export const ${name} = "${name}";\n`, `feat: ${name}`);
            await commit(repo, `src/${name}.test.ts`, `test('${name}', () => {});\n`, `test: ${name}`);
            await git(repo, "checkout", "-q", "master");
            await git(repo, "merge", "-q", "--squash", `feat/${name}`);
            await git(repo, "commit", "-q", "-m", `feat: ${name} (#3${name === "a" ? 0 : 1})`);
        }

        await git(repo, "worktree", "add", "-q", join(dest, "wt-a"), "feat/a");
        await git(repo, "worktree", "add", "-q", join(dest, "wt-b"), "feat/b");
        writeFileSync(join(dest, "wt-b", "src", "b.ts"), 'export const b = "b, edited but never committed";\n');
        return repo;
    },
};

const [name, dest] = process.argv.slice(2);
const builder = name ? builders[name] : undefined;

if (!builder || !dest) {
    process.stderr.write(`usage: build.ts <${Object.keys(builders).join("|")}> <dest-dir>\n`);
    process.exit(2);
}

// A reused dest keeps the previous run's branches and worktrees, so the fixture stops being
// the state the assertions describe; refuse instead of seeding on top of it.
if (existsSync(dest)) {
    process.stderr.write(`${dest} already exists; pass a fresh directory\n`);
    process.exit(2);
}

builder(dest).then(
    (repo) => process.stdout.write(`${repo}\n`),
    (err) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
);
