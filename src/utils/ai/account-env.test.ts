import { expect, test } from "bun:test";
import { ACCOUNT_ENV_VARS, accountEnvVar, accountFromEnv, anyAccountFromEnv } from "./account-env";

test("the variable name is derived from the alias, for all three providers", () => {
    expect(accountEnvVar("claude")).toBe("TOOLS_CLAUDE_ACCOUNT");
    expect(accountEnvVar("codex")).toBe("TOOLS_CODEX_ACCOUNT");
    expect(accountEnvVar("grok")).toBe("TOOLS_GROK_ACCOUNT");
    expect(ACCOUNT_ENV_VARS.codex).toBe("TOOLS_CODEX_ACCOUNT");
});

test("an account, a proxy target and an absent variable are three different answers", () => {
    expect(accountFromEnv("bun tools codex run TOOLS_CODEX_ACCOUNT=work", "codex")).toEqual({
        account: "work",
        proxyTarget: null,
    });
    expect(accountFromEnv("TOOLS_CLAUDE_ACCOUNT=proxy:shop claude", "claude")).toEqual({
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
    expect(accountFromEnv("TOOLS_CODEX_ACCOUNT_FILE=/tmp/x codex", "codex")).toEqual({
        account: null,
        proxyTarget: null,
    });
});

test("one line is attributed to whichever provider launched it", () => {
    expect(anyAccountFromEnv("grok --resume TOOLS_GROK_ACCOUNT=personal")).toEqual({
        provider: "grok",
        account: "personal",
        proxyTarget: null,
    });
    expect(anyAccountFromEnv("TOOLS_CODEX_ACCOUNT=proxy:side codex")).toEqual({
        provider: "codex",
        account: null,
        proxyTarget: "side",
    });
    expect(anyAccountFromEnv("some unrelated process")).toBeUndefined();
});
