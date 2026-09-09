import { expect, test } from "bun:test";
import { buildAccountLaunchOptions, validateTuiArgs } from "./launch-options";

test("account launch selects one shared home and excludes inherited credential overrides", () => {
    const result = buildAccountLaunchOptions({ sharedHome: "/shared/.codex", accountName: "work", cwd: "/repo" });
    expect(result.home).toBe("/shared/.codex");
    expect(result.config).toContain('cli_auth_credentials_store="ephemeral"');
    expect(result.unsetEnv).toContain("CODEX_ACCESS_TOKEN");
    expect(result.unsetEnv).toContain("CODEX_API_KEY");
    expect(result.config).toContain('forced_login_method="chatgpt"');
    expect(result.config).toContain('model_provider="openai"');
});

test.each(
    [
        ["--remote", "ws://another"],
        ["--remote=unix:///another"],
        ["--profile", "other"],
        ["-c", "model_provider=proxy"],
        ["--config=forced_login_method=api"],
        ["-pother"],
        ["login"],
        ["logout"],
    ].map((args) => ({ args }))
)("rejects connection or configuration replacement in TUI arguments %j", ({ args }) => {
    expect(() => validateTuiArgs(args)).toThrow();
});

test("permits ordinary native TUI controls and prompt text", () => {
    expect(validateTuiArgs(["--model", "gpt-6-astra", "--resume", "thread-a"])).toEqual([
        "--model",
        "gpt-6-astra",
        "--resume",
        "thread-a",
    ]);
});

test.each([
    "--oss",
    "--local-provider",
    "exec",
    "app-server",
    "mcp",
    "remote-control",
    "review",
])("rejects non-account-bound native path %s", (arg) => {
    expect(() => validateTuiArgs([arg])).toThrow();
});

test("consumes the launcher separator so native flags do not become an initial prompt", () => {
    expect(validateTuiArgs(["--", "--no-alt-screen"])).toEqual(["--no-alt-screen"]);
});

test("does not treat native option values or subcommand arguments as replacement commands", () => {
    // Regression test: PR #370 review thread 3 — `--cd app` and `resume --last review` were rejected.
    expect(validateTuiArgs(["--cd", "app", "--model", "sol"])).toEqual(["--cd", "app", "--model", "sol"]);
    expect(validateTuiArgs(["resume", "--last", "review"])).toEqual(["resume", "--last", "review"]);
    expect(validateTuiArgs(["resume", "--last", "--", "review"])).toEqual(["resume", "--last", "--", "review"]);
});

test.each([
    "plugin",
    "queue",
    "archive",
    "delete",
    "migrate-rollouts",
    "unarchive",
])("account terminals reject native management command %s", (command) => {
    expect(() => validateTuiArgs([command])).toThrow("account-bound terminal");
});

test("a second separator does not end account-bypass validation", () => {
    expect(() => validateTuiArgs(["--", "foo", "--", "--remote=ws://evil"])).toThrow("does not accept");
    expect(() => validateTuiArgs(["prompt", "--", "--profile=other"])).toThrow("does not accept");
});

test("native image filenames are option values rather than management commands", () => {
    expect(validateTuiArgs(["--image", "app", "Inspect screenshot"])).toEqual(["--image", "app", "Inspect screenshot"]);
});

test("a value-taking flag cannot smuggle a blocked override past the account guard", () => {
    // `skipValue` swallowed the token after any value-taking flag, whatever it was, so five
    // distinct shapes reached an account-bound launch carrying a config, profile or remote
    // override. Checking the blocked pattern before the skip is what closes it.
    for (const argv of [
        ["--add-dir", "--config=evil"],
        ["--image", "--config=evil"],
        ["--model", "--profile=x"],
        ["--sandbox", "-c", "trust=true"],
        ["--cd", "--remote=http://evil"],
    ]) {
        expect(() => validateTuiArgs(argv)).toThrow(/does not accept/);
    }

    // Ordinary values, including ones that follow a value-taking flag, still pass.
    for (const argv of [
        ["--model", "gpt-5-codex"],
        ["-m", "gpt-5-codex"],
        ["--add-dir", "/tmp/project"],
        ["--image", "/tmp/a.png", "--model", "gpt-5"],
        ["--cd", "/tmp", "explain this"],
        [],
    ]) {
        expect(() => validateTuiArgs(argv)).not.toThrow();
    }
});
