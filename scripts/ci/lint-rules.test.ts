import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { SafeJSON } from "@genesiscz/utils/json";
import { keptExecutable } from "@genesiscz/utils/test/kept-executable";
import { AGENT_PROCESS_MATCH_RATCHET, HARNESS_BRANCH_RATCHET, HOOK_PAYLOAD_READ_RATCHET } from "./harness-ratchet";
import {
    BARE_REQUIRE_RATCHET,
    changedFiles,
    checkSource,
    namesToolCommand,
    namesTranscriptFormat,
    pluginsDisabledFor,
    ratchetAdditions,
} from "./lint-rules";
import { EFFORT_LIST_RATCHET, MODEL_ID_LITERAL_RATCHET, MODEL_PRICE_TABLE_RATCHET } from "./model-facts-ratchet";
import { NATIVE_HOME_CLAUDE_RATCHET, NATIVE_HOME_CODEX_GROK_RATCHET } from "./native-home-ratchet";
import { TOOL_COMMAND_RATCHET } from "./tool-command-ratchet";
import { TRANSCRIPT_FORMAT_RATCHET } from "./transcript-format-ratchet";

/**
 * These pin the behaviour of the six GritQL plugins this checker replaced.
 *
 * Storage-path enforcement now requires the canonical root helper for every home expression, including
 * env.tools.getHome(), so explicit sandbox roots and the user's root follow the same construction contract.
 */

function rules(source: string, file = "src/example.ts"): string[] {
    return checkSource(file, source).map((f) => f.rule);
}

describe("no-hardcoded-tmp", () => {
    test("flags a /tmp literal in the binding contexts GritQL enumerated", () => {
        expect(rules('const p = "/tmp/x";')).toContain("no-hardcoded-tmp");
        expect(rules('foo("/tmp/x");')).toContain("no-hardcoded-tmp");
        expect(rules('return "/tmp/x";')).toContain("no-hardcoded-tmp");
    });

    test("also flags contexts GritQL could not reach — the reason it missed real bugs", () => {
        // An object property. `videoOut: "/tmp/run.mp4"` sat in the repo
        // unflagged because no GritQL pattern covered this position.
        expect(rules('const plan = { videoOut: "/tmp/run.mp4" };')).toContain("no-hardcoded-tmp");
        expect(rules('const p = process.env.X ?? "/tmp/db.sqlite";')).toContain("no-hardcoded-tmp");
    });

    test("leaves bare /tmp and other paths alone", () => {
        expect(rules('const p = "/tmp";')).toEqual([]);
        expect(rules('const p = "/var/tmp/x";')).toEqual([]);
    });

    test("honours the suppression comment", () => {
        expect(rules('// lint-rules-ignore: fixture\nconst p = "/tmp/x";')).toEqual([]);
        expect(rules('const p = "/tmp/x"; // lint-rules-ignore: fixture')).toEqual([]);
    });

    test("does NOT honour biome's own marker, which biome would then call unused", () => {
        expect(rules('// biome-ignore lint/plugin: stale\nconst p = "/tmp/x";')).toContain("no-hardcoded-tmp");
    });
});

describe("no-hardcoded-user-paths", () => {
    test("flags an absolute /Users path", () => {
        expect(rules('const p = "/Users/Martin/Projects/x";')).toContain("no-hardcoded-user-paths");
    });

    test("reports it as a warning, matching the original severity", () => {
        const [finding] = checkSource("src/example.ts", 'const p = "/Users/Martin/x";');
        expect(finding.severity).toBe("warn");
    });

    test("leaves a bare /Users prefix alone", () => {
        expect(rules('const p = "/UsersGuide";')).toEqual([]);
    });
});

describe("no-hand-joined-genesis-tools", () => {
    test("flags the data directory reached through homedir()", () => {
        expect(rules('const d = join(homedir(), ".genesis-tools", "daemon");')).toContain(
            "no-hand-joined-genesis-tools"
        );
    });

    test("flags a template that builds the same path", () => {
        expect(rules("const d = `${homedir()}/.genesis-tools/daemon`;")).toContain("no-hand-joined-genesis-tools");
    });

    test("flags arbitrary homes and path function forms", () => {
        for (const home of ["env.tools.getHome()", "env.paths.getHome()", "home", "resolve(home)"]) {
            expect(rules(`const d = join(${home}, ".genesis-tools", "daemon");`)).toContain(
                "no-hand-joined-genesis-tools"
            );
        }
        expect(rules('const d = path.resolve(home, ".genesis-tools/daemon");')).toContain(
            "no-hand-joined-genesis-tools"
        );
        expect(rules("const d = `${home}/.genesis-tools/daemon`;")).toContain("no-hand-joined-genesis-tools");
    });

    test("allows helpers, the canonical implementation, tests, plugins and lookalike names", () => {
        expect(rules('const d = genesisToolsDir("daemon");')).toEqual([]);
        expect(rules('const d = genesisToolsDirIn(home, "daemon");')).toEqual([]);
        const direct = 'const d = join(home, ".genesis-tools", "daemon");';
        expect(rules(direct, "src/utils/storage/root.ts")).toEqual([]);
        expect(rules(direct, "plugins/example/index.ts")).toEqual([]);
        expect(rules(direct, "src/example.test.ts")).toEqual([]);
        expect(rules('const d = join(home, ".genesis-tools-backup");')).toEqual([]);
        expect(rules(`// lint-rules-ignore: intentional fixture\n${direct}`)).toEqual([]);
        expect(rules("const shell = '\"${HOME}/.genesis-tools/cmux\"';")).toEqual([]);
    });

    test("LEAVES LaunchAgent plist names alone", () => {
        // `com.genesis-tools.daemon.plist` contains the string but is not the
        // data directory, and homedir() is correct for ~/Library/LaunchAgents.
        expect(
            rules('const p = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.daemon.plist");')
        ).toEqual([]);
    });
});

describe("no-direct-prompt-backend", () => {
    test("flags a direct backend call", () => {
        expect(rules("await inquirerBackend.select({});")).toContain("no-direct-prompt-backend");
        expect(rules("await clackBackend.confirm({});")).toContain("no-direct-prompt-backend");
    });

    test("leaves the p facade and unrelated methods alone", () => {
        expect(rules("await p.select({});")).toEqual([]);
        expect(rules("await inquirerBackend.dispose();")).toEqual([]);
    });
});

describe("no-mock-module-prompts", () => {
    test("flags a mocked prompt module", () => {
        expect(rules('mock.module("@genesiscz/utils/prompts/p", () => ({}));')).toContain("no-mock-module-prompts");
        expect(rules('mock.module("inquirer/prompts", () => ({}));')).toContain("no-mock-module-prompts");
    });

    test("leaves other mocked modules alone", () => {
        expect(rules('mock.module("node:fs", () => ({}));')).toEqual([]);
    });
});

describe("test-spawn-needs-env (test files only)", () => {
    const inTest = (source: string) => rules(source, "src/foo.test.ts");
    const CP = 'import { spawnSync, execSync } from "node:child_process";\n';

    test("flags Bun.spawn / Bun.spawnSync without env, with or without an options object", () => {
        expect(inTest('Bun.spawnSync(["ls"]);')).toContain("test-spawn-needs-env");
        expect(inTest('Bun.spawn(["ls"], { stdout: "pipe" });')).toContain("test-spawn-needs-env");
        expect(inTest('Bun.spawn({ cmd: ["ls"], stdout: "pipe" });')).toContain("test-spawn-needs-env");
    });

    test("passes when env is given in any form", () => {
        expect(inTest('Bun.spawn(["ls"], { stdout: "pipe", env: process.env });')).toEqual([]);
        expect(inTest('Bun.spawn(["ls"], { env: { ...process.env, X: "1" } });')).toEqual([]);
        expect(inTest('const env = process.env; Bun.spawn(["ls"], { env });')).toEqual([]);
        expect(inTest('Bun.spawn({ cmd: ["ls"], env: process.env });')).toEqual([]);
    });

    test("does not guess about options it cannot see into", () => {
        expect(inTest('Bun.spawn(["ls"], opts);')).toEqual([]);
        expect(inTest('Bun.spawn(["ls"], { ...base, stdout: "pipe" });')).toEqual([]);
        expect(inTest('Bun.spawn(["ls"], withEnv({ stdout: "pipe" }));')).toEqual([]);
    });

    test("flags node:child_process calls without env, but only when the module is imported", () => {
        expect(inTest(`${CP}spawnSync("ls", ["-la"], { encoding: "utf8" });`)).toContain("test-spawn-needs-env");
        expect(inTest(`${CP}execSync("ls");`)).toContain("test-spawn-needs-env");
        expect(inTest(`${CP}spawnSync("ls", ["-la"], { encoding: "utf8", env: process.env });`)).toEqual([]);
        // A bare spawn() from somewhere else (a local helper, a mock) is not the rule's business.
        expect(inTest('spawnSync("ls", ["-la"], { encoding: "utf8" });')).toEqual([]);
    });

    test("stays out of production files and honours the suppression comment", () => {
        expect(rules('Bun.spawnSync(["ls"]);', "src/foo.ts")).toEqual([]);
        expect(inTest('// lint-rules-ignore: child writes nothing\nBun.spawnSync(["ls"]);')).toEqual([]);
    });

    test("the literal rules stay off in test files even though the spawn rule runs there", () => {
        expect(inTest('const p = "/tmp/x"; Bun.spawnSync(["ls"], { env: process.env });')).toEqual([]);
    });
});

describe("the biome.json override that disabled plugins for tests", () => {
    /**
     * biome.json carries `{"includes": ["**\/*.test.ts", …], "plugins": []}`, so
     * the GritQL rules never ran on tests. Test files legitimately hardcode
     * /tmp paths and call prompt backends directly; without this the checker
     * reported 300+ findings the originals allowed by design.
     */
    test("skips the same files", () => {
        expect(pluginsDisabledFor("src/foo.test.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.test.tsx")).toBe(true);
        expect(pluginsDisabledFor("src/__tests__/foo.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.data.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.ts")).toBe(false);
    });

    test("a /tmp literal in a test file is not reported", () => {
        expect(rules('const p = "/tmp/x";', "src/foo.test.ts")).toEqual([]);
    });
});

describe("tsx and plain js", () => {
    test("parses .tsx", () => {
        expect(rules('const C = () => <div data-p="/tmp/x" />;', "src/c.tsx")).toContain("no-hardcoded-tmp");
    });

    test("parses every extension the file lister passes in", () => {
        // langFor and targetFiles must agree: a tracked .mts or .cts that one
        // accepts and the other never lists bypasses all six rules.
        for (const file of ["src/a.ts", "src/a.tsx", "src/a.mts", "src/a.cts", "src/a.js", "src/a.mjs", "src/a.cjs"]) {
            expect(rules('const p = "/tmp/x";', file)).toContain("no-hardcoded-tmp");
        }
    });

    test("ignores non-source files", () => {
        expect(rules('const p = "/tmp/x";', "README.md")).toEqual([]);
    });
});

describe("no-sub-100ms-interval", () => {
    test("flags a timer under 100 ms and leaves 100 ms and above alone", () => {
        expect(rules("setInterval(tick, 50);")).toContain("no-sub-100ms-interval");
        expect(rules("const t = setInterval(() => poll(), 20);")).toContain("no-sub-100ms-interval");
        expect(rules("globalThis.setInterval(tick, 0);")).toContain("no-sub-100ms-interval");
        expect(rules("setInterval(tick, 100);")).toEqual([]);
        expect(rules("setInterval(tick, 2_000);")).toEqual([]);
        expect(rules("setTimeout(tick, 20);")).toEqual([]);
    });

    test("a computed delay is not judged, and a suppression names the reason", () => {
        expect(rules("setInterval(tick, opts.pollMs);")).toEqual([]);
        expect(rules("setInterval(tick, 60 * 60 * 1000);")).toEqual([]);
        expect(rules("// lint-rules-ignore: spinner frame rate\nsetInterval(spin, 80);")).toEqual([]);
    });

    test("a delay bound to a sub-100 ms constant is still a violation", () => {
        expect(rules("const ms = 10;\nsetInterval(tick, ms);")).toContain("no-sub-100ms-interval");
        expect(rules("const DEFAULT_TICK_MS = 10;\nsetInterval(tick, DEFAULT_TICK_MS);")).toContain(
            "no-sub-100ms-interval"
        );
        expect(rules("const ms = 200;\nsetInterval(tick, ms);")).toEqual([]);
    });
});

describe("no-sync-poll-loop", () => {
    test("flags sleepSync inside any loop, bare or on Bun", () => {
        expect(rules("while (!done()) { Bun.sleepSync(50); }")).toContain("no-sync-poll-loop");
        expect(rules("for (let i = 0; i < 5; i++) { sleepSync(50); }")).toContain("no-sync-poll-loop");
        expect(rules("do { Bun.sleepSync(1); } while (busy());")).toContain("no-sync-poll-loop");
        expect(rules("for (const step of steps) { run(step); if (gap) { Bun.sleepSync(gap); } }")).toContain(
            "no-sync-poll-loop"
        );
    });

    test("leaves a one-off sleepSync and an async loop alone", () => {
        expect(rules("Bun.sleepSync(400);")).toEqual([]);
        expect(rules("async function wait() { while (!done()) { await Bun.sleep(50); } }")).toEqual([]);
        expect(rules("// lint-rules-ignore: bounded retry\nfor (;;) { Bun.sleepSync(5); }")).toEqual([]);
    });
});

describe("no-process-tool-spawn", () => {
    test("flags ps, lsof and pgrep in every spawn shape", () => {
        for (const source of [
            'exec(["ps", "-axo", "pid=,command="]);',
            'Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);',
            'runCommand(["pgrep", "-P", String(pid)]);',
            'spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });',
            'childProcess.execFileSync("lsof", ["-p", "1"]);',
            'execSync("pgrep -f claude");',
            'execSync("/bin/ps -ax");',
            "await $`/usr/sbin/lsof -nP`;",
            "await $`ps -axo pid=`;",
            'Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "command="]);',
            'const lsofBinary = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";',
            'Bun.spawnSync({ cmd: ["pgrep", "-fl", "cloudflared"], stdout: "pipe" });',
            'Bun.spawnSync(["env", "LC_ALL=C", "ps", "-axo", "pid="]);',
            'probeRun("listeners", "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);',
            'probeRun("processes", "env", ["LC_ALL=C", "ps", "-axo", COLUMNS]);',
            'deps.run("ps", ["-Ao", "pid=,rss="]);',
            'const lsof = Bun.which("lsof");',
            'Bun.spawn(["sh", "-c", "ps -ax"]);',
            'Bun.spawn(["sh", "-c", " /bin/ps -ax"]);',
            'spawnSync("sh", ["-c", "lsof -nP"]);',
            'childProcess.spawn("/bin/bash", ["-lc", "pgrep -f server"]);',
            'Bun.spawn({ cmd: ["env", "LC_ALL=C", "zsh", "-c", "ps -ax"] });',
        ]) {
            expect({ source, rules: rules(source) }).toEqual({ source, rules: ["no-process-tool-spawn"] });
        }
    });

    test("one line is one finding, however many shapes it holds", () => {
        expect(
            rules('const lsof = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : null);')
        ).toEqual(["no-process-tool-spawn"]);
    });

    test("leaves other programs, log text and a bare string alone", () => {
        expect(rules('exec(["git", "status"]);')).toEqual([]);
        expect(rules('log.debug("ps -axo did not exit cleanly");')).toEqual([]);
        expect(rules('spawnSync("psql", ["-c", "select 1"]);')).toEqual([]);
        expect(rules('const program = "ps";')).toEqual([]);
        expect(rules('this.run(["ps", "--filter", "name=db"]);')).toEqual([]);
        expect(rules('program.command("ps").description("list running artifacts");')).toEqual([]);
        expect(rules('Bun.spawnSync(["env", "LC_ALL=C", "git", "status"]);')).toEqual([]);
        expect(rules('const docs = "/usr/share/man/man1/ps.1";')).toEqual([]);
        expect(rules('Bun.spawn(["sh", "-c", "echo ps"]);')).toEqual([]);
        expect(rules('spawnSync("sh", ["ps", "-c", "echo ok"]);')).toEqual([]);
    });

    test("the process layer and the benchmarks may spawn them, and a suppression names the reason", () => {
        const source = 'Bun.spawnSync(["ps", "-axo", "pid="]);';
        expect(rules(source, "src/utils/process/ps.ts")).toEqual([]);
        expect(rules(source, "scripts/benchmarks/process/process-child.ts")).toEqual([]);
        expect(rules(`// lint-rules-ignore: Linux fallback\n${source}`)).toEqual([]);
    });
});

/**
 * A fake tool the wrapper starts, made once per body and kept: a new script per run, deleted with the run's folder,
 * was one of the executables syspolicyd crashed on when the Mac froze on 2026-10-14.
 */
const fakeTool = keptExecutable;

describe("lint-changed wrapper dispatch", () => {
    test("Swift-only and empty diffs still run repo rules while Biome remains scoped", () => {
        const dir = mkdtempSync(join(tmpdir(), "lint-changed-"));
        const trace = join(dir, "trace");
        const bun = fakeTool(
            "bun",
            '#!/bin/sh\nprintf "bun %s\\n" "$*" >> "$LINT_TRACE"\nexit "${FAKE_BUN_EXIT:-0}"\n'
        );
        const biome = fakeTool("biome", '#!/bin/sh\nprintf "biome %s\\n" "$*" >> "$LINT_TRACE"\n');
        const run = (args: string[], extraEnv: Record<string, string> = {}) =>
            spawnSync(args[0]!, args.slice(1), {
                cwd: dir,
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${dirname(bun)}:${process.env.PATH ?? ""}`,
                    LINT_TRACE: trace,
                    ...extraEnv,
                },
            });

        try {
            mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
            mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
            cpSync(join(import.meta.dir, "lint-changed.sh"), join(dir, "scripts", "ci", "lint-changed.sh"));
            symlinkSync(biome, join(dir, "node_modules", ".bin", "biome"));
            expect(run(["git", "init", "-q"]).status).toBe(0);
            expect(run(["git", "config", "user.name", "Fixture User"]).status).toBe(0);
            expect(run(["git", "config", "user.email", "fixture@example.com"]).status).toBe(0);
            writeFileSync(join(dir, "Native.swift"), "let ready = true\n");
            expect(run(["git", "add", "Native.swift"]).status).toBe(0);
            expect(run(["git", "commit", "-qm", "base"]).status).toBe(0);
            const base = run(["git", "rev-parse", "HEAD"]).stdout.trim();

            writeFileSync(join(dir, "Native.swift"), "let ready = sem.wait()\n");
            const swiftOnly = run(["bash", "scripts/ci/lint-changed.sh", base]);
            expect(swiftOnly.status).toBe(0);
            expect(readFileSync(trace, "utf8")).toBe(`bun scripts/ci/lint-rules.ts --changed ${base}\n`);

            writeFileSync(trace, "");
            expect(run(["git", "add", "Native.swift"]).status).toBe(0);
            expect(run(["git", "commit", "-qm", "swift"]).status).toBe(0);
            const current = run(["git", "rev-parse", "HEAD"]).stdout.trim();
            const empty = run(["bash", "scripts/ci/lint-changed.sh", current]);
            expect(empty.status).toBe(0);
            expect(readFileSync(trace, "utf8")).toBe(`bun scripts/ci/lint-rules.ts --changed ${current}\n`);

            writeFileSync(trace, "");
            const crashed = run(["bash", "scripts/ci/lint-changed.sh", current], { FAKE_BUN_EXIT: "7" });
            expect(crashed.status).toBe(7);

            // A config-only change touches no source file, yet it can break any of them.
            writeFileSync(join(dir, "biome.json"), '{ "linter": { "enabled": true } }\n');
            expect(run(["git", "add", "biome.json"]).status).toBe(0);
            expect(run(["git", "commit", "-qm", "config"]).status).toBe(0);
            writeFileSync(trace, "");
            const configOnly = run(["bash", "scripts/ci/lint-changed.sh", current]);
            expect(configOnly.status).toBe(0);
            expect(readFileSync(trace, "utf8")).toBe(
                `bun run lint:biome\nbun scripts/ci/lint-rules.ts --changed ${current}\n`
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("no-raw-genesis-link", () => {
    test("flags a router link built outside the router utils", () => {
        expect(rules("const u = `https://genesis.tools/md/open?path=${p}`;", "src/agents/x.ts")).toContain(
            "no-raw-genesis-link"
        );
    });

    test("flags an app scheme link built by hand", () => {
        expect(rules("const u = `genesis-md://open?path=${p}`;", "src/gitlab/x.ts")).toContain("no-raw-genesis-link");
        expect(rules('const u = "genesis-tools://hub";', "src/hub/x.ts")).toContain("no-raw-genesis-link");
    });

    test("allows the router utils, which own the gate", () => {
        expect(rules('const u = "https://genesis.tools/t/";', "src/utils/browser-router/x.ts")).not.toContain(
            "no-raw-genesis-link"
        );
    });
});

describe("no-tool-command-in-utils", () => {
    const rule = "no-tool-command-in-utils";

    test("flags a toolCommand call and a written-out tools command under src/utils", () => {
        expect(rules('const h = `run ${toolCommand("question show")} <id>`;', "src/utils/x/a.ts")).toContain(rule);
        expect(rules('const h = suggestCommand("tools notify", {});', "src/utils/x/a.ts")).toContain(rule);
        expect(rules('const h = "run `tools json2md build` again";', "src/utils/x/a.ts")).toContain(rule);
    });

    test("passes prose, comments, hints.ts and code outside src/utils", () => {
        expect(rules('const h = "the tools are slow";', "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules("// run tools json2md build\nconst a = 1;", "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules('const h = toolCommand("say");', "src/utils/genesis-tools/tools/hints.ts")).not.toContain(rule);
        expect(rules('const h = toolCommand("say");', "src/notify/index.ts")).not.toContain(rule);
    });

    test("every ratchet entry still names a command, so a migrated file leaves the list", async () => {
        const stale: string[] = [];

        for (const file of TOOL_COMMAND_RATCHET) {
            const root = parse(file.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript, await Bun.file(file).text()).root();
            const literals = root.findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } });

            if (!literals.some((node) => namesToolCommand(node.text(), node))) {
                stale.push(file);
            }
        }

        expect(stale).toEqual([]);
    });
});

describe("no-bun-only-import-meta", () => {
    const rule = "no-bun-only-import-meta";

    test("flags the line that broke tools clarity ui, and every Bun-only member, in shared and dashboard code", () => {
        const broke = 'const PASS_SCRIPT = path.join(import.meta.dir, "..", "compress", "daily-pass.ts");';
        expect(rules(broke, "src/utils/logger/daily-trigger.ts")).toContain(rule);
        for (const member of ["dir", "dirname", "filename", "path"]) {
            expect(rules(`const a = import.meta.${member};`, "src/clarity/ui/src/server.ts")).toContain(rule);
        }
        // The two dashboards whose sources live outside a `ui/` folder.
        expect(rules("const a = import.meta.dir;", "src/claude-history-dashboard/src/server.ts")).toContain(rule);
        expect(rules("const a = import.meta.dir;", "src/debugging-master/dashboard/src/server.ts")).toContain(rule);
    });

    test("passes module-dir.ts, tests, vite configs, import.meta.url and code no dashboard loads", () => {
        expect(rules("const a = import.meta.dir;", "src/utils/fs/module-dir.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.dir;", "src/utils/x/a.test.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.dirname;", "src/monitor/ui/vite.config.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.url;", "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.dir;", "src/du/index.ts")).not.toContain(rule);
    });
});

describe("no-bare-require-in-utils", () => {
    const rule = "no-bare-require-in-utils";

    test("flags a bare require under src/utils, and passes createRequire, member calls and other folders", () => {
        expect(rules('function f() { return require("./x"); }', "src/utils/x/a.ts")).toContain(rule);
        expect(rules('const load = createRequire(import.meta.url); load("./x");', "src/utils/x/a.ts")).not.toContain(
            rule
        );
        expect(rules('const r = module.require("./x");', "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules('const r = require("./x");', "src/du/index.ts")).not.toContain(rule);
    });

    test("every ratchet entry still calls require, so a migrated file leaves the list", async () => {
        const stale: string[] = [];

        for (const file of BARE_REQUIRE_RATCHET) {
            const root = parse(Lang.TypeScript, await Bun.file(file).text()).root();
            const calls = root.findAll({
                rule: { kind: "call_expression", has: { field: "function", regex: "^require$" } },
            });

            if (calls.length === 0) {
                stale.push(file);
            }
        }

        expect(stale).toEqual([]);
    });
});

describe("no-transcript-format-outside-readers", () => {
    const rule = "no-transcript-format-outside-readers";

    test("flags a record type or a raw-line probe outside the readers, and passes the readers and other chat formats", () => {
        expect(rules('if (row.type === "continued-in") {}', "src/claude/lib/x.ts")).toContain(rule);
        expect(rules('const at = text.indexOf(\'"type":"turn_context"\');', "src/hub/lib/x.ts")).toContain(rule);
        expect(rules('if (line.includes(\'"type":"user"\')) {}', "src/agents/lib/hooks/x.ts")).toContain(rule);
        expect(
            rules('if (row.type === "continued-in") {}', "src/utils/agent-sessions/readers/claude.ts")
        ).not.toContain(rule);
        // An LLM chat message is not a transcript record, and a bare role names nothing provider-specific.
        expect(rules('const m = \'{"role":"user","content":"hi"}\';', "src/jev/lib/x.ts")).not.toContain(rule);
        expect(rules('const role = "assistant";', "src/ask/lib/x.ts")).not.toContain(rule);
    });

    test("every ratchet entry still names the transcript format, so a migrated file leaves the list", async () => {
        const stale: string[] = [];

        for (const file of TRANSCRIPT_FORMAT_RATCHET) {
            const root = parse(file.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript, await Bun.file(file).text()).root();
            const literals = root.findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } });

            if (!literals.some((node) => namesTranscriptFormat(node.text()))) {
                stale.push(file);
            }
        }

        expect(stale).toEqual([]);
    });
});

describe("the agent and model ratchet rules (❓ DECISION 22 b)", () => {
    test("each rule flags its shape outside the owners and passes the owner and a look-alike", () => {
        const cases: { rule: string; hit: [string, string]; owner?: [string, string]; miss: [string, string] }[] = [
            {
                rule: "no-hand-built-claude-home",
                hit: ['const p = join(homedir(), ".claude", "projects");', "src/hub/lib/x.ts"],
                owner: ['const p = join(homedir(), ".claude");', "src/utils/providers/session-paths.ts"],
                miss: ['const p = join(repoRoot, ".claude", "rules");', "src/hub/lib/x.ts"],
            },
            {
                rule: "no-hand-built-codex-grok-home",
                hit: ['const p = join(homedir(), ".codex");', "src/hub/lib/x.ts"],
                owner: ['const p = join(homedir(), ".codex");', "src/utils/providers/session-paths.ts"],
                miss: ['const p = join(repoRoot, ".codex-review");', "src/hub/lib/x.ts"],
            },
            {
                rule: "no-model-id-literal-outside-catalog",
                hit: ['export const DEFAULT_MODEL = "claude-opus-5";', "src/ai/lib/x.ts"],
                owner: ['const id = "claude-opus-5-5";', "src/utils/ai/catalog/static.ts"],
                miss: ['const hint = "Try: opus, claude-sonnet-5-5, haiku";', "src/ai/lib/x.ts"],
            },
            {
                rule: "no-model-price-table",
                hit: ["const P = { opus: { input: 15, output: 75 } };", "src/ai-spend/lib/x.ts"],
                miss: ["const P = { opus: { ...base } };", "src/ai-spend/lib/x.ts"],
            },
            {
                rule: "no-effort-vocabulary-list",
                hit: ['export const E = ["low", "medium", "high", "xhigh"] as const;', "src/utils/worker/x.ts"],
                owner: ['export const E = ["low", "high", "xhigh"];', "src/utils/ai/catalog/efforts.ts"],
                miss: ['const args = ["--effort", "xhigh", "--yes"];', "src/claude/lib/x.ts"],
            },
            {
                rule: "no-harness-name-branch",
                hit: ['if (node.harness === "claude") {}', "src/hub/lib/x.ts"],
                owner: ['if (kind === "codex") {}', "src/utils/agent-sessions/x.ts"],
                miss: ['if (theme.name === "claude") {}', "src/hub/lib/x.ts"],
            },
            {
                rule: "no-hook-payload-read",
                hit: ["const t = payload.raw.transcript_path;", "src/agents/lib/hooks/x.ts"],
                owner: ["const t = raw.transcript_path;", "src/agents/lib/hooks/payload.ts"],
                miss: ['const fixture = { transcript_path: "/x.jsonl" };', "src/agents/lib/hooks/x.ts"],
            },
            {
                rule: "no-agent-name-in-command-match",
                hit: ["const live = /claude/i.test(process.command);", "src/question/lib/x.ts"],
                owner: ["const live = /claude/i.test(process.command);", "src/utils/process/classify.ts"],
                miss: ['const t = text.includes("claude");', "src/timely/x.ts"],
            },
        ];

        for (const { rule, hit, owner, miss } of cases) {
            expect({ rule, found: rules(...hit).includes(rule) }).toEqual({ rule, found: true });
            expect({ rule, miss: rules(...miss).includes(rule) }).toEqual({ rule, miss: false });

            if (owner) {
                expect({ rule, owner: rules(...owner).includes(rule) }).toEqual({ rule, owner: false });
            }
        }
    });

    test("standalone home templates are native roots, while repository-relative templates are not", () => {
        for (const provider of ["claude", "codex", "grok"]) {
            const rule = provider === "claude" ? "no-hand-built-claude-home" : "no-hand-built-codex-grok-home";

            for (const home of ["homedir()", "env.paths.getHome()", "home"]) {
                const source = "const root = `${" + home + "}/." + provider + "`;";
                expect(rules(source)).toContain(rule);
                expect(rules(source, "src/utils/providers/session-paths.ts")).not.toContain(rule);
            }

            const repositorySource = "const root = `${repoRoot}/." + provider + "`;";
            expect(rules(repositorySource)).not.toContain(rule);
        }
    });

    test("hook payload reads include destructuring and literal indexes, but not payload construction", () => {
        const rule = "no-hook-payload-read";
        const file = "src/agents/lib/hooks/example.ts";
        const owner = "src/agents/lib/hooks/payload.ts";

        for (const source of [
            "const { transcript_path } = payload.raw;",
            "const { tool_input: input } = payload.raw;",
            "const { tool_response = {} } = payload.raw;",
            "({ hook_event_name: event } = payload.raw);",
            "const { toolInput } = payload.raw;",
            "const { raw: { toolInput } } = payload;",
            'const { ["tool_input"]: input } = payload.raw;',
            'const input = payload.raw["tool_input"];',
            "const input = payload.raw['toolInput'];",
            'const input = payload["raw"].toolInput;',
        ]) {
            expect(rules(source, file)).toContain(rule);
            expect(rules(source, owner)).not.toContain(rule);
        }

        for (const source of [
            'const payload = { transcript_path: "/fixture.jsonl", tool_input: {} };',
            "const { unrelated: tool_input } = config;",
            "const { toolInput } = config;",
            'const input = config["toolInput"];',
        ]) {
            expect(rules(source, file)).not.toContain(rule);
        }
    });

    test("harness, payload and process diagnostics name their migration owner", () => {
        for (const [source, owner] of [
            ['if (node.harness === "claude") {}', "ProviderPlugin or NativeSessionReader"],
            ["const input = payload.raw.tool_input;", "src/agents/lib/hooks/payload.ts"],
            ["const live = /claude/i.test(process.command);", "src/utils/process/classify.ts"],
        ]) {
            const findings = checkSource("src/example.ts", source);
            expect(findings).toHaveLength(1);
            expect(findings[0].message).toContain(owner);
            expect(findings[0].message).not.toContain("PROBE");
        }
    });

    test("process match methods use the regex and command in their actual positions", () => {
        const rule = "no-agent-name-in-command-match";

        for (const source of [
            "process.command.match(/claude/i);",
            "process.command.search(/codex/);",
            "/grok/.test(process.command);",
        ]) {
            expect(rules(source)).toContain(rule);
            expect(rules(source, "src/utils/process/classify.ts")).not.toContain(rule);
        }

        expect(rules("text.match(/claude/i);")).not.toContain(rule);
        expect(rules("process.command.search(/editor/);")).not.toContain(rule);
    });

    test("established lists reject additions, including a new offender, but allow removals and initialization", () => {
        const list = (files: string[]) =>
            `export const EXAMPLE_RATCHET = new Set<string>(${SafeJSON.stringify(files)});`;
        const source = 'const id = "claude-opus-5";';
        expect(rules(source, "src/new-offender.ts")).toContain("no-model-id-literal-outside-catalog");
        expect(ratchetAdditions(list(["src/old.ts"]), list(["src/old.ts", "src/new-offender.ts"]))).toEqual([
            "EXAMPLE_RATCHET: src/new-offender.ts",
        ]);
        expect(ratchetAdditions(list(["src/old.ts"]), list([]))).toEqual([]);
        expect(ratchetAdditions("", list(["src/old.ts"]))).toEqual([]);
        expect(() => ratchetAdditions(list([]), "const EXAMPLE_RATCHET = loadExemptions();")).toThrow(
            "literal new Set"
        );
    });

    test("changing any imported ratchet rescans an unchanged offender and rejects growth against the base", () => {
        const dir = mkdtempSync(join(tmpdir(), "lint-ratchet-"));
        const run = (args: string[]) => {
            const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
                cwd: dir,
                encoding: "utf8",
                env: { ...process.env },
            });
            expect(result.status, result.stderr).toBe(0);
            return result.stdout.trim();
        };
        const inputs = [
            "harness-ratchet.ts",
            "model-facts-ratchet.ts",
            "native-home-ratchet.ts",
            "tool-command-ratchet.ts",
            "transcript-format-ratchet.ts",
        ];
        const list = (files: string[]) =>
            `export const EXAMPLE_RATCHET = new Set<string>(${SafeJSON.stringify(files)});`;

        try {
            mkdirSync(join(dir, "scripts/ci"), { recursive: true });
            mkdirSync(join(dir, "src"));
            writeFileSync(join(dir, "src/offender.ts"), 'const id = "claude-opus-5";');

            for (const file of inputs) {
                writeFileSync(join(dir, "scripts/ci", file), list(["src/offender.ts"]));
            }

            run(["init", "-q"]);
            run(["config", "user.name", "Fixture User"]);
            run(["config", "user.email", "fixture@example.com"]);
            run(["add", "--", "src/offender.ts", ...inputs.map((file) => `scripts/ci/${file}`)]);
            run(["commit", "-qm", "base"]);
            const base = run(["rev-parse", "HEAD"]);
            expect(changedFiles(base, { cwd: dir })).toEqual(new Set());

            let previous = base;

            for (const file of inputs) {
                writeFileSync(join(dir, "scripts/ci", file), list([]));
                run(["add", "--", `scripts/ci/${file}`]);
                run(["commit", "-qm", "remove exemption"]);
                expect(changedFiles(previous, { cwd: dir })).toBeNull();
                previous = run(["rev-parse", "HEAD"]);
                const source = readFileSync(join(dir, "src/offender.ts"), "utf8");
                expect(rules(source, "src/offender.ts")).toContain("no-model-id-literal-outside-catalog");
            }

            writeFileSync(join(dir, "scripts/ci/harness-ratchet.ts"), list(["src/offender.ts", "src/new.ts"]));
            run(["add", "--", "scripts/ci/harness-ratchet.ts"]);
            run(["commit", "-qm", "grow exemption"]);
            expect(() => changedFiles(base, { cwd: dir })).toThrow("EXAMPLE_RATCHET: src/new.ts");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    test("every file on a ratchet list still offends its rule, so a migrated file leaves the list", async () => {
        const lists: [string, ReadonlySet<string>][] = [
            ["no-transcript-format-outside-readers", TRANSCRIPT_FORMAT_RATCHET],
            ["no-hand-built-claude-home", NATIVE_HOME_CLAUDE_RATCHET],
            ["no-hand-built-codex-grok-home", NATIVE_HOME_CODEX_GROK_RATCHET],
            ["no-model-id-literal-outside-catalog", MODEL_ID_LITERAL_RATCHET],
            ["no-model-price-table", MODEL_PRICE_TABLE_RATCHET],
            ["no-effort-vocabulary-list", EFFORT_LIST_RATCHET],
            ["no-harness-name-branch", HARNESS_BRANCH_RATCHET],
            ["no-hook-payload-read", HOOK_PAYLOAD_READ_RATCHET],
            ["no-agent-name-in-command-match", AGENT_PROCESS_MATCH_RATCHET],
        ];
        const stale: string[] = [];
        const files = [...new Set(lists.flatMap(([, entries]) => [...entries]))];
        const found = new Map(
            await Promise.all(
                files.map(async (file) => {
                    const source = await Bun.file(file).text();
                    return [
                        file,
                        new Set(checkSource(file, source, { ratchets: false }).map((finding) => finding.rule)),
                    ] as const;
                })
            )
        );

        for (const [rule, entries] of lists) {
            for (const file of entries) {
                if (!found.get(file)?.has(rule)) {
                    stale.push(`${rule}: ${file}`);
                }
            }
        }

        expect(stale).toEqual([]);
    }, 30_000);
});
