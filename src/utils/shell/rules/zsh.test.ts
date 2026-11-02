import { describe, expect, it } from "bun:test";
import { skip, zshPath } from "@genesiscz/utils/test/skip";

import { detectShellViolations, type ShellViolation } from "./index";
import { zshRules } from "./zsh";

function ids(command: string): string[] {
    return detectShellViolations(command, zshRules).map((v) => v.ruleId);
}

function only(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command, zshRules).find((v) => v.ruleId === ruleId);
}

const GLOB = "zsh-glob-qualifier";
const LOG = "bare-log-command";
const SPLIT = "zsh-word-split";

describe("zsh-glob-qualifier", () => {
    it("(N) fires with the qualifier as matched, no suggestion", () => {
        const command = "ls -d /tmp/*.log(N)";
        const v = only(command, GLOB);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("(N)");
        expect(v?.index).toBe(command.indexOf("(N)"));
        expect(v?.suggestion).toBeUndefined();
    });

    it("(#qN) and longer qualifier strings fire", () => {
        expect(ids("ls *.log(#qN)")).toEqual([GLOB]);
        expect(ids("print -l ~/x/*(#qN.)")).toEqual([GLOB]);
        expect(ids("for f in *.har(N); do echo $f; done")).toEqual([GLOB]);
    });

    it("the recommended forms pass", () => {
        expect(ids("[ -e app.log ] && ls *.log")).toEqual([]);
        expect(ids("( setopt NULL_GLOB; ls -d /tmp/a* /tmp/b* )")).toEqual([]);
    });

    it("parens that are not a qualifier pass", () => {
        expect(ids("echo $(N)")).toEqual([]);
        expect(ids("f() { ls; }; (N)")).toEqual([]);
        expect(ids("echo '(N)'")).toEqual([]);
        expect(ids('echo "*.log(N)"')).toEqual([]);
        expect(ids("rg 'x(N)' src")).toEqual([]);
    });
});

describe("bare-log-command", () => {
    it("log show fires with `command` prepended in the suggestion", () => {
        const command = "log show --last 5m --predicate 'process == \"sharingd\"'";
        const v = only(command, LOG);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe(command);
        expect(v?.index).toBe(0);
        expect(v?.suggestion).toBe(`command ${command}`);
    });

    it("log stream / collect / config fire, log alone does not", () => {
        expect(ids("log stream --predicate 'x'")).toEqual([LOG]);
        expect(ids("log collect --last 1h")).toEqual([LOG]);
        expect(ids("log config --status")).toEqual([LOG]);
        expect(ids("log")).toEqual([]);
        expect(ids("log 2>&1")).toEqual([]);
    });

    it("later in a chain, with the offset pointing at log", () => {
        const command = "cd /tmp && log show --last 2m | head";
        const v = only(command, LOG);

        expect(v?.index).toBe(command.indexOf("log show"));
        expect(v?.matched).toBe("log show --last 2m");
        expect(v?.suggestion).toBe("cd /tmp && command log show --last 2m | head");
    });

    it("builtin log show still hits the builtin", () => {
        expect(ids("builtin log show --last 5m")).toEqual([LOG]);
    });

    it("a loop body or an if branch still hits the builtin", () => {
        expect(ids("for f in a b; do log show --last 5m; done")).toEqual([LOG]);
        expect(ids("if true; then log show --last 5m; fi")).toEqual([LOG]);
        expect(ids("for f in a; do command log show --last 5m; done")).toEqual([]);
    });

    it("command log, a path, or any exec wrapper reaches /usr/bin/log", () => {
        expect(ids("command log show --last 5m")).toEqual([]);
        expect(ids("/usr/bin/log show --last 5m")).toEqual([]);
        expect(ids("sudo log show --last 5m")).toEqual([]);
        expect(ids("env log show --last 5m")).toEqual([]);
        expect(ids("exec log stream")).toEqual([]);
        expect(ids("timeout 30 log show --last 5m")).toEqual([]);
    });

    it("other tools with a log subcommand pass", () => {
        expect(ids("git log --oneline -5")).toEqual([]);
        expect(ids("tools task logs --session x")).toEqual([]);
        expect(ids("xcrun simctl spawn UDID log show --last 90m")).toEqual([]);
        expect(ids("docker logs x")).toEqual([]);
        expect(ids("logger 'hi'")).toEqual([]);
    });

    it("prose", () => {
        expect(ids("echo 'log show'")).toEqual([]);
        expect(ids("# log show --last 1m\nls")).toEqual([]);
        expect(ids("cat <<'EOF'\nlog show\nEOF")).toEqual([]);
    });
});

describe("zsh-word-split", () => {
    it("the 2026-11-02 command: a loop over `git show --name-only | head -40` output, corrected per line", () => {
        const command =
            "for s in A B; do files=$(git show --name-only --format= $s | head -40); " +
            "for f in $files; do git show $s:$f | grep -c foo; done; done";
        const v = only(command, SPLIT);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("$files");
        expect(v?.index).toBe(command.indexOf("$files"));
        expect(v?.suggestion).toBe(command.replace("in $files", "in ${(f)files}"));
    });

    it("a quoted literal with spaces passed as arguments is corrected to split on IFS", () => {
        const v = only('list="a b"; cmd $list', SPLIT);

        expect(v?.matched).toBe("$list");
        expect(v?.suggestion).toBe('list="a b"; cmd ${=list}');
        expect(ids('R="--resolve example.test:443:127.0.0.1"; curl -m 15 $R https://example.test')).toEqual([SPLIT]);
        // After an option the literal reads as that option's one value, even when the option is a flag.
        expect(ids('R="--resolve example.test:443:127.0.0.1"; curl -sS $R https://example.test')).toEqual([]);
        expect(ids('x="$a $b"; for i in $x; do echo $i; done')).toEqual([SPLIT]);
        expect(ids("for f in $files; do :; done; files='a\nb'; for f in $files; do :; done")).toEqual([SPLIT]);
    });

    it("corrects every use of the variable in one suggestion", () => {
        const command = "F=$(git diff --name-only); bunx biome check --write $F; bunx biome check ${F}";
        const v = only(command, SPLIT);

        expect(v?.index).toBe(command.indexOf("$F;"));
        expect(v?.suggestion).toBe(
            "F=$(git diff --name-only); bunx biome check --write ${(f)F}; bunx biome check ${(f)F}"
        );
    });

    it("a quoted use, an unassigned variable and the zsh split forms pass", () => {
        expect(ids('files=$(git diff --name-only); for f in "$files"; do echo $f; done')).toEqual([]);
        expect(ids('files=$(git diff --name-only); bunx biome check "a $files b"')).toEqual([]);
        expect(ids("for f in $files; do echo $f; done")).toEqual([]);
        expect(ids("files=$(git diff --name-only); for f in ${=files}; do echo $f; done")).toEqual([]);
        expect(ids("files=$(git diff --name-only); for f in ${(f)files}; do echo $f; done")).toEqual([]);
        expect(ids("files=$(git diff --name-only); git add $files/x ${files:-none} $files[1]")).toEqual([]);
    });

    it("an array assignment passes: zsh iterates arrays per element", () => {
        expect(ids("files=( $(git diff --name-only) ); for f in $files; do echo $f; done")).toEqual([]);
        expect(ids("files=(${(f)$(git diff --name-only)}); git add $files")).toEqual([]);
        expect(ids("local -a files=( a b ); files+=( c ); git add $files")).toEqual([]);
        expect(ids("arr=( foo $x ); x=$(git diff --name-only)")).toEqual([]);
    });

    it("an array assignment covers only the uses after it, until the next assignment", () => {
        expect(ids('files="a b"; git add $files; files=( a b )')).toEqual([SPLIT]);
        expect(ids("files=( a b ); files=$(git diff --name-only); git add $files")).toEqual([SPLIT]);
        expect(ids("files=$(git diff --name-only); files=( ${(f)files} ); git add $files")).toEqual([]);
    });

    it("an assignment inside a subshell, a substitution or a piped element stays there", () => {
        expect(ids("files=README.md; (files=$(git diff --name-only)); cat $files")).toEqual([]);
        expect(ids("out=$(files=$(git diff --name-only); echo x); git add $files")).toEqual([]);
        expect(ids("files=$(git diff --name-only) | cat; git add $files")).toEqual([]);
        expect(ids("files=README.md; zsh <<'EOF'\nfiles=$(git diff --name-only)\nEOF\ncat $files")).toEqual([]);
        // Inside the subshell, and from the outer shell into a subshell, it still counts.
        expect(ids("(files=$(git diff --name-only); git add $files)")).toEqual([SPLIT]);
        expect(ids("files=$(git diff --name-only); (cd sub && git add $files)")).toEqual([SPLIT]);
    });

    it("a use inside the substitution that reassigns the variable reads the earlier value", () => {
        expect(ids("x=$(git diff --name-only); x=$(wc -l $x)")).toEqual([SPLIT]);
    });

    it("a list variable inside an array literal is one element in zsh", () => {
        const v = only("x=$(git diff --name-only); arr=( $x ); git add $arr", SPLIT);

        expect(v?.suggestion).toBe("x=$(git diff --name-only); arr=( ${(f)x} ); git add $arr");
    });

    it("local and export assign too", () => {
        expect(ids("local files=$(git diff --name-only); git add $files")).toEqual([SPLIT]);
        expect(ids('export LIST="a b"; cmd $LIST')).toEqual([SPLIT]);
    });

    it("a command that runs under bash, or turns splitting on, passes", () => {
        expect(ids("bash -c 'files=$(git diff --name-only); for f in $files; do echo $f; done'")).toEqual([]);
        expect(ids("bash <<'EOF'\nfiles=$(git diff --name-only)\nfor f in $files; do echo $f; done\nEOF")).toEqual([]);
        expect(
            ids(
                "cat > /tmp/x.sh <<'EOF'\n#!/bin/bash\nfiles=$(git diff --name-only)\nfor f in $files; do echo $f; done\nEOF\nbash /tmp/x.sh"
            )
        ).toEqual([]);
        expect(ids("setopt shwordsplit; files=$(ls | head); for f in $files; do echo $f; done")).toEqual([]);
        expect(ids("emulate -L sh; files=$(ls | head); for f in $files; do echo $f; done")).toEqual([]);
    });

    it("a heredoc fed to zsh is still zsh", () => {
        expect(ids("zsh <<'EOF'\nfiles=$(git diff --name-only)\nfor f in $files; do echo $f; done\nEOF")).toEqual([
            SPLIT,
        ]);
    });

    it("option text in data, an option set later or in a subshell, and a bash heredoc leave the zsh code checked", () => {
        const list = "files=$(git diff --name-only); git add $files";

        expect(ids(`echo 'setopt shwordsplit'; ${list}`)).toEqual([SPLIT]);
        expect(ids(`# setopt shwordsplit\n${list}`)).toEqual([SPLIT]);
        expect(ids(`git commit -m "emulate sh"; ${list}`)).toEqual([SPLIT]);
        expect(ids(`${list}; setopt shwordsplit`)).toEqual([SPLIT]);
        expect(ids(`(setopt shwordsplit); ${list}`)).toEqual([SPLIT]);
        expect(ids(`zsh <<'EOF'\nsetopt shwordsplit\nEOF\n${list}`)).toEqual([SPLIT]);
        expect(ids(`bash <<'EOF'\necho hi\nEOF\n${list}`)).toEqual([SPLIT]);
        expect(ids(`${list}\nbash <<'EOF'\nfor f in $files; do echo $f; done\nEOF`)).toEqual([SPLIT]);
        expect(ids(`echo 'bash <<EOF'\n${list}`)).toEqual([SPLIT]);
        // The bash body itself still passes, and so does code after an option set in the same shell.
        expect(ids("bash <<'EOF'\nfiles=$(git diff --name-only)\nfor f in $files; do echo $f; done\nEOF")).toEqual([]);
        expect(ids(`(setopt shwordsplit; ${list})`)).toEqual([]);
    });

    it("a single value by construction passes", () => {
        expect(ids("sha=$(git rev-parse HEAD); git show $sha")).toEqual([]);
        expect(ids("base=$(git merge-base HEAD origin/master); for c in $base; do echo $c; done")).toEqual([]);
        expect(ids("n=$(git diff --name-only | wc -l); for i in $n; do echo $i; done")).toEqual([]);
        expect(ids("f=$(git diff --name-only | head -1); cat $f")).toEqual([]);
        expect(ids("c=$(git log -1 --format=%H); git show $c")).toEqual([]);
        expect(ids("refs=$(rg -o 't[0-9]+' f.txt | tr '\\n' ','); tools github review expand $refs")).toEqual([]);
    });

    it("a search result fires in a loop but not as an argument, where it is usually the one expected hit", () => {
        expect(ids("f=$(rg -l 'class ProductExtras' app); sed -n 1,80p $f")).toEqual([]);
        expect(ids("p=$(pgrep -x fseventsd); ps -o pid,pcpu -p $p")).toEqual([]);
        expect(ids("f=$(git diff --name-only origin/main...HEAD | rg service.spec); rg -n test $f")).toEqual([]);
        expect(ids("f=$(fd -t f -e ts . src); for x in $f; do wc -l $x; done")).toEqual([SPLIT]);
        expect(ids("W=$(pgrep -f 'bun test'); for p in $W; do kill $p; done")).toEqual([SPLIT]);
    });

    it("an explicit head count or a tr join to spaces is a list even as an argument", () => {
        expect(ids("F=$(rg -l heartbeat src -g '*.test.ts' | head -3); bun run test $F")).toEqual([SPLIT]);

        const joined = only("F=$(rg -l parity src -g '*.test.ts' | tr '\\n' ' '); bun run test $F", SPLIT);
        expect(joined?.suggestion).toBe("F=$(rg -l parity src -g '*.test.ts' | tr '\\n' ' '); bun run test ${=F}");

        const sorted = only("F=$(git diff --name-only | tr '\\n' ' ' | sort); git add $F", SPLIT);
        expect(sorted?.suggestion).toBe("F=$(git diff --name-only | tr '\\n' ' ' | sort); git add ${=F}");
        expect(only("F=$(git diff --name-only | xargs); git add $F", SPLIT)?.suggestion).toBe(
            "F=$(git diff --name-only | xargs); git add ${=F}"
        );
    });

    it("a tr that maps characters keeps the lines, so the correction still splits per line", () => {
        const v = only("files=$(git diff --name-only | tr '[:upper:]' '[:lower:]'); git add $files", SPLIT);

        expect(v?.suggestion).toBe("files=$(git diff --name-only | tr '[:upper:]' '[:lower:]'); git add ${(f)files}");
    });

    it("an argument meant as one string passes", () => {
        expect(ids('msg="a b"; echo $msg; print $msg; printf "%s" $msg')).toEqual([]);
        expect(ids("files=$(git diff --name-only); [ -n $files ] && grep x <<< $files")).toEqual([]);
        expect(ids("files=$(git diff --name-only); cat > $files")).toEqual([]);
        expect(ids('msg="fix the thing"; git commit -m $msg')).toEqual([]);
        expect(ids('dir="/Users/dev/My Folder"; ls $dir')).toEqual([]);
        expect(ids('note="Done. Next step"; tools say $note')).toEqual([]);
        expect(ids('cmd="git status --short"; eval $cmd')).toEqual([]);
    });

    it("a jq lookup with select passes as an argument; a plain `.[]` is a list", () => {
        expect(
            ids(
                "JOB=$(gh run view 1 --json jobs --jq '.jobs[]|select(.name|startswith(\"test\"))|.databaseId'); gh run view 1 --job $JOB"
            )
        ).toEqual([]);
        expect(ids("ids=$(gh pr list --json number -q '.[].number'); gh pr view $ids")).toEqual([SPLIT]);
    });

    it("output the tables cannot place fires only as the sole item of a loop", () => {
        const v = only("out=$(tools x ids); for id in $out; do echo $id; done", SPLIT);

        expect(v?.suggestion).toBe("out=$(tools x ids); for id in ${=out}; do echo $id; done");
        expect(ids("out=$(tools x ids); other $out")).toEqual([]);
        expect(ids("a=$(tools x a); b=$(tools x b); for x in $a $b; do echo $x; done")).toEqual([]);
    });

    const zshIt = it.skipIf(skip.unlessZsh);

    zshIt("the corrected command really splits in zsh, where the original ran once", () => {
        const run = (command: string) =>
            Bun.spawnSync([zshPath ?? "/bin/zsh", "-f", "-c", command], { env: process.env })
                .stdout.toString()
                .trim();
        const loop = "files=$(printf 'a\\nb\\nc\\n' | head -40); n=0; for f in $files; do n=$((n+1)); done; echo $n";
        const args = 'list="a b"; count() { echo $#; }; count $list';
        const mapped =
            "files=$(printf 'My File.ts\\nb.ts\\n' | head -40 | tr '[:upper:]' '[:lower:]'); " +
            "count() { echo $#; }; count $files";

        expect(run(loop)).toBe("1");
        expect(run(only(loop, SPLIT)?.suggestion ?? "")).toBe("3");
        expect(run(args)).toBe("1");
        expect(run(only(args, SPLIT)?.suggestion ?? "")).toBe("2");
        // A path with a space survives the per-line split; `${=files}` would have made it 3.
        expect(run(mapped)).toBe("1");
        expect(run(only(mapped, SPLIT)?.suggestion ?? "")).toBe("2");
    });
});

describe("zsh rules: corpus fixtures", () => {
    const cases: Array<[string, string[]]> = [
        ["command log show --last 5m --predicate 'subsystem == \"com.apple.TCC\"' --style compact | head -20", []],
        ["log show --last 10m --predicate 'process == \"usernoted\"' --style compact 2>&1 | head", [LOG]],
        ["log stream --predicate 'subsystem == \"com.apple.usernotifications\"' --level debug", [LOG]],
        ["ls -la ~/Library/Logs/DiagnosticReports/*.ips(N) 2>&1", [GLOB]],
        ["ls ~/.genesis-tools/logs/*.log | tail -3", []],
        [
            'FILES="src/a/store.ts src/a/gateway.ts"; for f in $FILES; do mkdir -p $B/$(dirname $f); cp $f $B/$f; done',
            [SPLIT],
        ],
        ["F=$(git diff --name-only); bunx biome check --write $F > /dev/null 2>&1; bunx biome check $F", [SPLIT]],
        ['O="-P 2222 -o PubkeyAuthentication=no -q"; scp $O host:/var/log/app.log /tmp/', [SPLIT]],
        ["SHAS=$(git rev-list --reverse origin/main..topic)\nfor sha in $SHAS; do git checkout -q $sha; done", [SPLIT]],
        ["f=$(fd -a Wrapper.kt expo); rg -n 'loadAppReady' $f | head -20; sed -n 425,450p $f", []],
        ["F=$(rg -l 'class BankTransferService' app); wc -l $F; rg -n 'function ' $F | head -50", []],
        ['N=$(ls -t *.jsonl | sed -n \'3p\'); echo $N; rg -o \'"entrypoint":"[^"]*"\' $N | sort | uniq -c', []],
    ];

    for (const [command, expected] of cases) {
        it(`${expected.join("+") || "silent"}: ${command.slice(0, 70)}`, () => {
            expect(ids(command)).toEqual(expected);
        });
    }
});
