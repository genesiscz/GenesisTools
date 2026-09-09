import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { env } from "@genesiscz/utils/env";

export const FIXED_HISTORY_NOW = "2026-08-15T12:00:00.000Z";

export interface HistoryFixtureWorld {
    root: string;
    home: string;
    sources: {
        claude: string;
        codex: string;
        grok: string;
    };
    databases: {
        legacy: string;
        candidate: string;
    };
    git: {
        root: string;
        head: string;
    };
    now: Date;
    environment: Record<string, string>;
    assertOwnedPath(path: string): string;
    dispose(): Promise<void>;
}

function canonicalPath(path: string): string {
    const tail: string[] = [];
    let current = resolve(path);
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        tail.unshift(current.slice(parent.length + 1));
        current = parent;
    }

    return resolve(realpathSync(current), ...tail);
}

function assertInside(root: string, path: string): string {
    const canonicalRoot = canonicalPath(root);
    const absolute = canonicalPath(path);
    const fromRoot = relative(canonicalRoot, absolute);
    if (fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))) {
        return absolute;
    }

    throw new Error(`Path is outside fixture world: ${absolute}`);
}

function runtimeEnvironment(): Record<string, string> {
    const result: Record<string, string> = { PATH: env.get("PATH") ?? "/usr/bin:/bin" };
    for (const key of ["TMPDIR", "TMP", "TEMP", "SystemRoot"] as const) {
        const value = env.get(key);
        if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
}

async function runGit(root: string, args: string[], environment?: Record<string, string>): Promise<string> {
    const processHandle = Bun.spawn(["git", ...args], {
        cwd: root,
        env: { ...runtimeEnvironment(), ...environment },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
        processHandle.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(`Fixture git command failed (${args.join(" ")}): ${stderr.trim()}`);
    }

    return stdout.trim();
}

export async function createFixtureWorld(
    options: { baseDirectory?: string; now?: Date } = {}
): Promise<HistoryFixtureWorld> {
    const baseDirectory = resolve(options.baseDirectory ?? tmpdir());
    await mkdir(baseDirectory, { recursive: true });
    const root = await mkdtemp(join(baseDirectory, "genesis-history-fixture-"));
    const home = join(root, "invented-home");
    const sources = {
        claude: join(home, ".claude", "projects"),
        codex: join(home, ".codex", "sessions"),
        grok: join(home, ".grok", "sessions"),
    };
    const legacyHome = join(root, "databases", "legacy-home");
    const databases = {
        legacy: join(legacyHome, ".genesis-tools", "claude-history", "index.db"),
        candidate: join(root, "databases", "candidate", "index.db"),
    };
    const git = { root: join(root, "invented-repository"), head: "" };
    const now = new Date(options.now ?? FIXED_HISTORY_NOW);

    await Promise.all([
        mkdir(sources.claude, { recursive: true }),
        mkdir(sources.codex, { recursive: true }),
        mkdir(sources.grok, { recursive: true }),
        mkdir(dirname(databases.legacy), { recursive: true }),
        mkdir(dirname(databases.candidate), { recursive: true }),
        mkdir(git.root, { recursive: true }),
    ]);
    await writeFile(join(git.root, "fixture.txt"), "invented fixture repository\n", "utf8");
    const gitEnvironment = {
        HOME: home,
        GIT_CONFIG_GLOBAL: join(root, "no-global-git-config"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture Author",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture Author",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_AUTHOR_DATE: FIXED_HISTORY_NOW,
        GIT_COMMITTER_DATE: FIXED_HISTORY_NOW,
    };
    await runGit(git.root, ["init", "--quiet", "--initial-branch=main"], gitEnvironment);
    await runGit(git.root, ["config", "core.hooksPath", "/dev/null"], gitEnvironment);
    await runGit(git.root, ["config", "commit.gpgsign", "false"], gitEnvironment);
    await runGit(git.root, ["add", "fixture.txt"], gitEnvironment);
    await runGit(git.root, ["commit", "--quiet", "-m", "fixture baseline"], gitEnvironment);
    git.head = await runGit(git.root, ["rev-parse", "HEAD"], gitEnvironment);

    const environment = {
        HOME: home,
        GENESIS_TOOLS_HOME: legacyHome,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        GROK_HOME: join(home, ".grok"),
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        OPENAI_API_KEY: "",
        XAI_API_KEY: "",
        GIT_CONFIG_GLOBAL: join(root, "no-global-git-config"),
        TZ: "UTC",
        ...runtimeEnvironment(),
    };

    return {
        root,
        home,
        sources,
        databases,
        git,
        now,
        environment,
        assertOwnedPath: (path) => assertInside(root, path),
        async dispose() {
            assertInside(root, root);
            await rm(root, { recursive: true, force: true });
        },
    };
}
