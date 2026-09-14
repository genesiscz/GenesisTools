import { expect, test } from "bun:test";
import { accountEnvVar, accountFromEnv, psEnvValue } from "./account-env";

test("a key with regex metacharacters is matched literally", () => {
    // `readProcessEnvKeys(pid, keys)` takes the key list from its caller, and the key is
    // interpolated into a RegExp. Unescaped, `.` matched any character and `(` threw.
    expect(psEnvValue("claude AXB=two", "A.B")).toBeUndefined();
    expect(psEnvValue("claude A.B=one", "A.B")).toBe("one");
    expect(() => psEnvValue("claude PATH=/usr/bin", "A(B")).not.toThrow();
});

test("the variable name is derived from the alias, for all three providers", () => {
    expect(accountEnvVar("claude")).toBe("TOOLS_CLAUDE_ACCOUNT");
    expect(accountEnvVar("codex")).toBe("TOOLS_CODEX_ACCOUNT");
    expect(accountEnvVar("grok")).toBe("TOOLS_GROK_ACCOUNT");
});

test("an account, a proxy target and an absent variable are three different answers", () => {
    expect(accountFromEnv("bun tools codex run TOOLS_CODEX_ACCOUNT=work", "codex")).toEqual({
        account: "work",
        proxyTarget: null,
    });
    expect(accountFromEnv("claude --model opus TOOLS_CLAUDE_ACCOUNT=proxy:shop", "claude")).toEqual({
        account: null,
        proxyTarget: "shop",
    });
    expect(accountFromEnv("claude --resume abc", "claude")).toEqual({ account: null, proxyTarget: null });
});

test("one provider's variable is never read as another's", () => {
    const line = "codex app-server TOOLS_CODEX_ACCOUNT=work";
    expect(accountFromEnv(line, "codex").account).toBe("work");
    expect(accountFromEnv(line, "claude").account).toBeNull();
    expect(accountFromEnv(line, "grok").account).toBeNull();
});

test("a longer variable that merely starts with the name does not match", () => {
    // `indexOf` would take this, and the account would read as a file path.
    expect(accountFromEnv("codex TOOLS_CODEX_ACCOUNT_FILE=/tmp/x", "codex")).toEqual({
        account: null,
        proxyTarget: null,
    });
});

test("an account name that contains a space reads back whole", () => {
    // 🛑 The fixtures below put the argv FIRST and the environment last, because that is what
    // `ps axeww -o pid=,args=` and `ps eww` actually print. Measured 2026-09-14 on a live line
    // (`bun …/tools artifact serve . --port 3077 PNPM_HOME=… PHP_INI_SCAN_DIR=…`), and
    // `parsePinnedProcesses` in src/claude/lib/doctor.ts says the same. So a value ends at the
    // next `KEY=` word or at the end of the line, never at the next space.
    //
    // The earlier reader stopped at whitespace and reported `work laptop` as the account
    // `work`, which is a DIFFERENT account rather than an unknown one. `account-ops.test.ts`
    // pins `"my key"` as a creatable account name, so the reader is the side that has to cope.
    expect(accountFromEnv("grok --resume abc TOOLS_GROK_ACCOUNT=work laptop PATH=/usr/bin", "grok")).toEqual({
        account: "work laptop",
        proxyTarget: null,
    });
    expect(accountFromEnv("grok TOOLS_GROK_ACCOUNT=work laptop", "grok")).toEqual({
        account: "work laptop",
        proxyTarget: null,
    });
    expect(accountFromEnv("codex TOOLS_CODEX_ACCOUNT=proxy:side account HOME=/Users/x", "codex")).toEqual({
        account: null,
        proxyTarget: "side account",
    });
});

test("an exported but empty variable is unknown, not an empty account name", () => {
    expect(accountFromEnv("claude TOOLS_CLAUDE_ACCOUNT= PATH=/usr/bin", "claude")).toEqual({
        account: null,
        proxyTarget: null,
    });
    expect(accountFromEnv("claude TOOLS_CLAUDE_ACCOUNT=", "claude")).toEqual({
        account: null,
        proxyTarget: null,
    });
});

test("each provider reads only its own variable off a shared line", () => {
    const line = "grok --resume abc TOOLS_GROK_ACCOUNT=personal PATH=/usr/bin";

    expect(accountFromEnv(line, "grok")).toEqual({ account: "personal", proxyTarget: null });
    expect(accountFromEnv(line, "codex")).toEqual({ account: null, proxyTarget: null });
    expect(accountFromEnv(line, "claude")).toEqual({ account: null, proxyTarget: null });
});

test("the key is the LAST variable on a line that ends with a newline", () => {
    // 🛑 REGRESSION, found by review round 4 against `0926d0d52`. `$` without the `m` flag
    // matches only the end of the WHOLE string, and `.` never crosses a newline, so a lazy
    // capture could never reach it and the whole match failed. `readProcessEnvKeys` always
    // passes the entire `ps eww -p <pid>` stdout, which always ends in a newline, and the
    // codex and grok launchers put their account variable last. Latent, not live, only
    // because today's claude launcher happens to export TOOLS_CLAUDE_AUTH after it.
    expect(accountFromEnv("  PID TTY\n 4242 s001 claude TOOLS_CLAUDE_ACCOUNT=work laptop\n", "claude")).toEqual({
        account: "work laptop",
        proxyTarget: null,
    });
    expect(accountFromEnv("codex TOOLS_CODEX_ACCOUNT=side\n", "codex")).toEqual({
        account: "side",
        proxyTarget: null,
    });
    // A value on an earlier line must not swallow the next line's variable.
    expect(accountFromEnv("grok TOOLS_GROK_ACCOUNT=personal\nPATH=/usr/bin\n", "grok")).toEqual({
        account: "personal",
        proxyTarget: null,
    });
});

test("a key is matched literally, never as a regular expression", () => {
    // `readProcessEnvKeys(pid, keys)` takes an arbitrary key list and the key goes straight into
    // `new RegExp`. Unescaped, `A.B` also matched the `AxB=` word and answered with a DIFFERENT
    // variable's value. Every call site passes a plain `TOOLS_*` name today, so this is hardening.
    expect(psEnvValue("cmd AxB=wrong A.B=right PATH=/x", "A.B")).toBe("right");
    expect(psEnvValue("cmd AxB=only PATH=/x", "A.B")).toBeUndefined();
});

test("DOCUMENTED LIMIT: a value holding a ` WORD=` fragment is truncated at it", () => {
    // Nothing in `ps` output quotes a value, so `K=a b=c` and `K=a` followed by `b=c` are the
    // same bytes and no reader can tell them apart. Pinned rather than fixed: the docblock names
    // the limit, and an account name never has this shape. `npm_lifecycle_script` does.
    expect(psEnvValue("cmd K=a b=c PATH=/x", "K")).toBe("a");
    expect(psEnvValue("cmd K=work laptop PATH=/x", "K")).toBe("work laptop");
});
