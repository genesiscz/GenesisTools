import { describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { persistentFixture } from "@genesiscz/utils/test/persistent-fixture";
import { type CommandRunner, generateCompletions, looksLikeZshCompletion, versionChanged } from "./generate";
import { COMPLETION_PROVIDERS, type CompletionProvider, getCompletionProvider } from "./providers";
import {
    BLOCK_END,
    BLOCK_START,
    findHandBlocks,
    isReplaceable,
    planCompletions,
    rcDiff,
    renderBlock,
    replacedRecord,
    restoreHandBlocks,
    shellPath,
    stripOwnBlock,
} from "./rc-block";
import { emptyState, isCompletionsState, readStateForUpdate, readStateReadOnly, writeState } from "./state";

const root = mkdtempSync(join(tmpdir(), "gt-zsh-completions-"));
const HOME = "/Users/alice";
const DIR = `${HOME}/.genesis-tools/zsh/completions`;

function provider(cli: string): CompletionProvider {
    const found = getCompletionProvider(cli);

    if (!found) {
        throw new Error(`no provider ${cli}`);
    }

    return found;
}

const PASTED_GLOW = [
    "eval #compdef glow",
    "compdef _glow glow",
    "",
    "# zsh completion for glow",
    "_glow()",
    "{",
    "    compadd one",
    "}",
    "",
    "# don't run the completion function when being source-ed or eval-ed",
    '#if [ "$funcstack[1]" = "_glow" ]; then',
    "#    _glow",
    "#fi",
];

const HAND_RC = [
    "export PATH=/opt/bin:$PATH",
    "# The following lines have been added by Docker Desktop to enable Docker CLI completions.",
    "_load_docker_completions() {",
    "  fpath=(/Users/alice/.docker/completions $fpath)",
    "}",
    "# End of Docker CLI completions",
    "source $ZSH/oh-my-zsh.sh",
    '[ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"',
    ...PASTED_GLOW,
    'eval "$(gh completion -s zsh)"',
    "# vitrinka-completion (static copy)",
    "[[ -r ~/.zsh/completions/_vitrinka ]] && source ~/.zsh/completions/_vitrinka",
    'fpath=("/Users/alice/.othercli/zsh" $fpath); autoload -Uz _othercli; (( $+functions[compdef] )) && compdef _othercli othercli',
    "alias ll='ls -la'",
    "",
].join("\n");

const ALL = COMPLETION_PROVIDERS;

describe("renderBlock", () => {
    it("wires fpath CLIs by autoload + compdef and source CLIs by source, and never runs a CLI", () => {
        const block = renderBlock({ providers: [provider("gh"), provider("bun")], completionsDir: DIR, home: HOME });

        expect(block.split("\n")[0]).toBe(BLOCK_START);
        expect(block.split("\n").at(-1)).toBe(BLOCK_END);
        expect(block).toContain('__gt_completions="$HOME/.genesis-tools/zsh/completions"');
        expect(block).toContain("[[ -r $__gt_completions/_gh ]] && autoload -Uz _gh && compdef _gh gh");
        expect(block).toContain("[[ -r $__gt_completions/_bun ]] && source $__gt_completions/_bun");
        expect(block).not.toMatch(/eval|\$\(/);
    });

    it("quotes a path outside the home folder", () => {
        expect(shellPath("/tmp/a b/$x", HOME)).toBe('"/tmp/a b/\\$x"');
        expect(shellPath(`${HOME}/x`, HOME)).toBe('"$HOME/x"');
    });

    it("keeps shell syntax in a path under the home folder literal; only the leading $HOME expands", () => {
        expect(shellPath(`${HOME}/cache/$(touch marker)/\`x\`/"q"`, HOME)).toBe(
            '"$HOME/cache/\\$(touch marker)/\\`x\\`/\\"q\\""'
        );
    });
});

describe("planCompletions", () => {
    it("appends one block, is idempotent, and uninstall restores the original text", () => {
        const rc = "export A=1\nsource $ZSH/oh-my-zsh.sh\n";
        const plan = planCompletions({
            rcText: rc,
            selected: [provider("gh")],
            replace: [],
            completionsDir: DIR,
            home: HOME,
        });

        expect(plan.after.startsWith(rc)).toBe(true);
        expect(plan.after.split(BLOCK_START).length).toBe(2);
        expect(plan.after.endsWith(`${BLOCK_END}\n`)).toBe(true);

        const again = planCompletions({
            rcText: plan.after,
            selected: [provider("gh")],
            replace: [],
            completionsDir: DIR,
            home: HOME,
        });
        expect(again.after).toBe(plan.after);
        expect(stripOwnBlock(plan.after)).toBe(rc);
        expect(rcDiff({ rcPath: "/x/.zshrc", before: rc, after: plan.after })).toContain(`+${BLOCK_START}`);
        expect(rcDiff({ rcPath: "/x/.zshrc", before: rc, after: rc })).toBe("");
    });

    it("rewrites the block in place and removes it when nothing is selected", () => {
        const first = planCompletions({
            rcText: "a\nb\n",
            selected: [provider("gh"), provider("glab")],
            replace: [],
            completionsDir: DIR,
            home: HOME,
        }).after;
        const moved = `${first}after-the-block\n`;
        const fewer = planCompletions({
            rcText: moved,
            selected: [provider("gh")],
            replace: [],
            completionsDir: DIR,
            home: HOME,
        });

        expect(fewer.after).not.toContain("_glab");
        expect(fewer.after.endsWith(`${BLOCK_END}\nafter-the-block\n`)).toBe(true);

        const none = planCompletions({ rcText: moved, selected: [], replace: [], completionsDir: DIR, home: HOME });
        expect(none.after).toBe("a\nb\nafter-the-block\n");
    });

    it("refuses a start marker without an end marker", () => {
        expect(() =>
            planCompletions({
                rcText: `x\n${BLOCK_START}\ny\n`,
                selected: [],
                replace: [],
                completionsDir: DIR,
                home: HOME,
            })
        ).toThrow(/no "# <<< genesis-tools zsh completions <<<" line/);
    });

    it("does not replace completion lines that contain other commands", () => {
        const rc = 'eval "$(gh completion -s zsh)"; export EDITOR=vim\n';
        expect(findHandBlocks(rc, [provider("gh")]).filter(isReplaceable)).toEqual([]);
    });

    it("finds every hand-made block with its exact lines", () => {
        const blocks = findHandBlocks(HAND_RC, ALL);
        const byCli = Object.fromEntries(blocks.map((block) => [block.provider.cli, block]));

        expect(Object.keys(byCli).sort()).toEqual(["bun", "docker", "gh", "glow", "vitrinka"]);
        expect(byCli.glow?.lines).toEqual(PASTED_GLOW);
        expect(byCli.vitrinka?.lines).toHaveLength(2);
        expect(byCli.docker?.lines).toHaveLength(5);
        expect(byCli.docker && isReplaceable(byCli.docker)).toBe(false);
        expect(byCli.gh?.lines).toEqual(['eval "$(gh completion -s zsh)"']);
    });

    it("keeps every hand block unless asked and skips the CLIs they already wire", () => {
        const plan = planCompletions({ rcText: HAND_RC, selected: ALL, replace: [], completionsDir: DIR, home: HOME });

        expect(plan.wired.map((entry) => entry.cli)).toEqual(["glab", "docker"]);
        expect(plan.skipped.map((entry) => entry.provider.cli).sort()).toEqual(["bun", "gh", "glow", "vitrinka"]);
        expect(plan.after.startsWith(HAND_RC.replace(/\n$/, ""))).toBe(true);
    });

    it("replaces the agreed blocks, keeps the vitrinka marker, and a second run changes nothing", () => {
        const replace = findHandBlocks(HAND_RC, ALL).filter(isReplaceable);
        const plan = planCompletions({ rcText: HAND_RC, selected: ALL, replace, completionsDir: DIR, home: HOME });
        const lines = plan.after.split("\n");

        expect(plan.replaced.map((block) => block.provider.cli).sort()).toEqual(["bun", "gh", "glow", "vitrinka"]);
        expect(plan.wired.map((entry) => entry.cli).sort()).toEqual([
            "bun",
            "docker",
            "gh",
            "glab",
            "glow",
            "vitrinka",
        ]);
        expect(plan.after).not.toContain("_glow()");
        expect(plan.after).not.toContain('eval "$(gh');
        expect(lines.some((line) => line.startsWith("# vitrinka-completion"))).toBe(true);
        expect(plan.after).toContain("_load_docker_completions");
        expect(plan.after).toContain("compdef _othercli othercli");
        expect(plan.after).not.toMatch(/^[^#\n]*eval "\$\(/m);

        const again = planCompletions({
            rcText: plan.after,
            selected: ALL,
            replace: findHandBlocks(plan.after, ALL).filter(isReplaceable),
            completionsDir: DIR,
            home: HOME,
        });
        expect(again.after).toBe(plan.after);
        expect(again.wired.map((entry) => entry.cli).sort()).toEqual(plan.wired.map((entry) => entry.cli).sort());
    });

    it("puts the replaced hand blocks back, so install then uninstall returns the original rc", () => {
        const replace = findHandBlocks(HAND_RC, ALL).filter(isReplaceable);
        const plan = planCompletions({ rcText: HAND_RC, selected: ALL, replace, completionsDir: DIR, home: HOME });
        const records = plan.replaced.map(replacedRecord);
        const restored = restoreHandBlocks(plan.after, records);

        expect(restored.missing).toEqual([]);
        expect(restored.restored).toHaveLength(4);
        expect(stripOwnBlock(restored.text)).toBe(HAND_RC);

        const edited = plan.after.replace("# glow completion: wired by tools zsh completions", "# edited by alice");
        const partial = restoreHandBlocks(edited, records);
        expect(partial.missing.map((record) => record.original[0])).toEqual(["eval #compdef glow"]);
        expect(partial.text).toContain("# edited by alice");
    });
});

describe("generateCompletions", () => {
    const fake: CompletionProvider = {
        cli: "alicecli",
        generate: ["alicecli", "completion", "zsh"],
        version: ["alicecli", "--version"],
        wiring: "fpath",
        handWiring: [],
    };

    function runner(script: string, version: string, calls: string[][] = []): CommandRunner {
        return async (argv) => {
            calls.push([...argv]);
            return argv.includes("--version")
                ? { exitCode: 0, stdout: `${version}\nextra\n`, stderr: "", timedOut: false }
                : { exitCode: 0, stdout: script, stderr: "", timedOut: false };
        };
    }

    it("writes the file once, reports unchanged content, and keeps the old entry when the generator fails", async () => {
        const dir = join(root, "gen");
        const script = "#compdef alicecli\ncompdef _alicecli alicecli\n_alicecli() { compadd one }\n";
        const first = await generateCompletions({
            providers: [fake],
            completionsDir: dir,
            state: emptyState(),
            run: runner(script, "alicecli 1.0"),
        });

        expect(first[0]?.changed).toBe(true);
        expect(first[0]?.installed?.version).toBe("alicecli 1.0");
        expect(readFileSync(join(dir, "_alicecli"), "utf8")).toBe(script);

        const state = { version: 1 as const, clis: { alicecli: first[0]?.installed ?? fail() } };
        const second = await generateCompletions({
            providers: [fake],
            completionsDir: dir,
            state,
            run: runner(script, "alicecli 1.1"),
        });
        expect(second[0]?.changed).toBe(false);
        expect(second[0]?.previousVersion).toBe("alicecli 1.0");
        expect(versionChanged(state.clis.alicecli, second[0]?.installed?.version)).toBe(true);

        const broken = await generateCompletions({
            providers: [fake],
            completionsDir: dir,
            state,
            run: runner("not a script", "alicecli 2"),
        });
        expect(broken[0]?.error).toContain('no "#compdef alicecli" script');
        expect(broken[0]?.installed).toEqual(state.clis.alicecli);
        expect(readFileSync(join(dir, "_alicecli"), "utf8")).toBe(script);
    });

    it("recognises a zsh completion only by its #compdef line", () => {
        expect(looksLikeZshCompletion("#compdef gh\ncompdef _gh gh\n", "gh")).toBe(true);
        expect(looksLikeZshCompletion("# bash completion for gh\n", "gh")).toBe(false);
        expect(looksLikeZshCompletion("#compdef glab\n", "gh")).toBe(false);
    });
});

function fail(): never {
    throw new Error("expected a value");
}

describe("state file", () => {
    it("round-trips and rejects a foreign shape without writing in the read-only path", () => {
        const path = join(root, "state", "completions.json");
        const state = {
            version: 1 as const,
            rc: "/Users/alice/.zshrc",
            clis: {
                gh: {
                    file: `${DIR}/_gh`,
                    wiring: "fpath" as const,
                    generatedAt: "2026-10-30T10:00:00.000Z",
                    sha256: "ab",
                },
            },
        };
        writeState(state, path);

        expect(readStateReadOnly(path).state).toEqual(state);
        expect(readStateForUpdate(path)).toEqual(state);

        const withHand = { ...state, replacedHand: { bun: [{ original: ["source x"], replacement: ["# bun"] }] } };
        writeState(withHand, path);
        expect(readStateReadOnly(path).state).toEqual(withHand);
        expect(isCompletionsState({ clis: {}, replacedHand: { bun: [{ original: "x" }] } })).toBe(false);
        expect(isCompletionsState({ clis: { gh: { file: 1 } } })).toBe(false);

        const badPath = join(root, "state-bad", "completions.json");
        mkdirSync(join(root, "state-bad"), { recursive: true });
        writeFileSync(badPath, "{ not json");
        const read = readStateReadOnly(badPath);

        expect(read.state).toEqual(emptyState());
        expect(read.problem).toContain("does not parse");
        expect(readdirSync(join(root, "state-bad"))).toEqual(["completions.json"]);
    });
});

describe("completion install", () => {
    it("retains an unrestored record when its CLI is deselected", async () => {
        const home = join(root, "install-home");
        const rc = join(home, ".zshrc");
        const bin = join(home, "bin");
        const statePath = join(home, ".genesis-tools", "zsh", "completions.json");
        mkdirSync(bin, { recursive: true });
        symlinkSync("/usr/bin/true", join(bin, "gh"));
        writeFileSync(rc, "# edited replacement\n");
        const records = { bun: [{ original: ["source old"], replacement: ["# removed"] }] };
        writeState({ version: 1, rc, clis: {}, replacedHand: records }, statePath);
        const proc = Bun.spawn(
            [process.execPath, join(import.meta.dir, "../../index.ts"), "completions", "--yes", "--rc", rc],
            {
                env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, GENESIS_TOOLS_HOME: home },
                stdout: "pipe",
                stderr: "pipe",
            }
        );
        await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        expect(await proc.exited).toBe(0);
        expect(readStateReadOnly(statePath).state.replacedHand).toEqual(records);
    });
});

describe("completion install and refresh", () => {
    // A fake gh that prints a zsh completion; made once and kept, since macOS checks each new executable it runs.
    const fakeGh = persistentFixture("gh", "zsh-completions-fake-gh-v1", (path) => {
        writeFileSync(path, "#!/bin/sh\nprintf '#compdef gh\\n_gh() { :; }\\n'\n", { mode: 0o755 });
    });

    function run(home: string, args: string[]) {
        const bin = join(home, "bin");
        mkdirSync(bin, { recursive: true });

        if (!existsSync(join(bin, "gh"))) {
            symlinkSync(fakeGh, join(bin, "gh"));
        }

        return Bun.spawn([process.execPath, join(import.meta.dir, "../../index.ts"), ...args], {
            env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, GENESIS_TOOLS_HOME: home },
            stdout: "pipe",
            stderr: "pipe",
        });
    }

    it("puts the rc back when the state that records its replaced hand blocks cannot be saved", async () => {
        const home = join(root, "state-fails-home");
        const rc = join(home, ".zshrc");
        const zshDir = join(home, ".genesis-tools", "zsh");
        const original = 'export A=1\neval "$(gh completion -s zsh)"\n';
        mkdirSync(join(zshDir, "completions"), { recursive: true });
        writeFileSync(rc, original);
        chmodSync(zshDir, 0o500);

        try {
            const proc = run(home, ["completions", "--yes", "--replace-hand", "--rc", rc]);
            await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

            expect(await proc.exited).not.toBe(0);
            expect(readFileSync(rc, "utf8")).toBe(original);
        } finally {
            chmodSync(zshDir, 0o755);
        }

        // The control: with a writable state folder the same run replaces the line and records it.
        const proc = run(home, ["completions", "--yes", "--replace-hand", "--rc", rc]);
        await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

        expect(await proc.exited).toBe(0);
        expect(readFileSync(rc, "utf8")).not.toContain("eval");
        expect(Object.keys(readStateReadOnly(join(zshDir, "completions.json")).state.replacedHand ?? {})).toEqual([
            "gh",
        ]);
    });

    it("refresh --dry-run writes neither a completion file nor the state", async () => {
        const home = join(root, "refresh-dry-home");
        const dir = join(home, ".genesis-tools", "zsh", "completions");
        const statePath = join(home, ".genesis-tools", "zsh", "completions.json");
        mkdirSync(dir, { recursive: true });
        const before = {
            version: 1 as const,
            clis: {
                gh: {
                    file: join(dir, "_gh"),
                    wiring: "fpath" as const,
                    version: "old",
                    generatedAt: "2026-10-01T00:00:00.000Z",
                    sha256: "0".repeat(64),
                },
            },
        };
        writeState(before, statePath);
        const proc = run(home, ["completions", "--dry-run", "refresh"]);
        const output = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

        expect(await proc.exited).toBe(0);
        expect(output.join("")).toContain("Dry run");
        expect(readdirSync(dir)).toEqual([]);
        expect(readStateReadOnly(statePath).state).toEqual(before);
    });
});

describe("completion uninstall", () => {
    it("retains missing restoration records with their rc and refuses a different rc", async () => {
        const home = join(root, "uninstall-home");
        const rc = join(home, ".zshrc");
        const other = join(home, "other-rc");
        const statePath = join(home, ".genesis-tools", "zsh", "completions.json");
        mkdirSync(home, { recursive: true });
        writeFileSync(rc, "# edited replacement\n");
        writeFileSync(other, "# unrelated file\n");
        const records = { gh: [{ original: ['eval "$(gh completion -s zsh)"'], replacement: ["# removed"] }] };
        writeState({ version: 1, rc, clis: {}, replacedHand: records }, statePath);

        const run = async (path: string) => {
            const proc = Bun.spawn(
                [process.execPath, join(import.meta.dir, "../../index.ts"), "completions", "--rc", path, "uninstall"],
                {
                    env: { PATH: env.get("PATH") ?? "/usr/bin:/bin", HOME: home, GENESIS_TOOLS_HOME: home },
                    stdout: "pipe",
                    stderr: "pipe",
                }
            );
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            return { stdout, stderr, exitCode };
        };

        const wrong = await run(other);
        expect(wrong.exitCode).not.toBe(0);
        expect(readFileSync(other, "utf8")).toBe("# unrelated file\n");
        expect(readStateReadOnly(statePath).state.replacedHand).toEqual(records);

        const right = await run(rc);
        expect(right.exitCode).toBe(0);
        expect(readStateReadOnly(statePath).state).toEqual({ version: 1, rc, clis: {}, replacedHand: records });
    });
});

describe("zsh wiring", () => {
    it("registers an fpath CLI and a source CLI in an interactive zsh after compinit", async () => {
        const zdot = join(root, "zdot");
        const dir = join(zdot, "completions");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "_alicecli"),
            '#compdef alicecli\ncompdef _alicecli alicecli\n_alicecli() { compadd one two }\nif [ "$funcstack[1]" = "_alicecli" ]; then\n    _alicecli\nfi\n'
        );
        writeFileSync(join(dir, "_bobcli"), "#compdef bobcli\n_bobcli() { compadd x }\ncompdef _bobcli bobcli\n");

        const alice: CompletionProvider = {
            cli: "alicecli",
            generate: [],
            version: [],
            wiring: "fpath",
            handWiring: [],
        };
        const bob: CompletionProvider = { ...alice, cli: "bobcli", wiring: "source" };
        const rc = `autoload -Uz compinit && compinit -C -d ${zdot}/.zcompdump\n`;
        const plan = planCompletions({
            rcText: rc,
            selected: [alice, bob],
            replace: [],
            completionsDir: dir,
            home: "/nonexistent-home",
        });
        writeFileSync(join(zdot, ".zshrc"), plan.after);

        const proc = Bun.spawn(
            ["zsh", "-d", "-i", "-c", "print -r -- $_comps[alicecli] $_comps[bobcli] $(whence -w _alicecli _bobcli)"],
            {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                env: { PATH: env.get("PATH") ?? "/usr/bin:/bin", HOME: zdot, ZDOTDIR: zdot, TERM: "dumb" },
            }
        );
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);

        expect(await proc.exited).toBe(0);
        expect(stderr).not.toContain("not found");
        expect(stdout.trim()).toBe("_alicecli _bobcli _alicecli: function _bobcli: function");
        expect(existsSync(join(zdot, ".zcompdump"))).toBe(true);
    });
});
