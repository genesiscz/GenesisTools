import { env } from "@genesiscz/utils/env";

/**
 * Centralized test skip gates.
 *
 * Instead of hand-rolling `describe.skipIf(process.platform === "win32" || …)`
 * in every file, import a named gate here and pass it straight to bun's
 * `describe.skipIf(...)` / `it.skipIf(...)` (they take a boolean).
 *
 *   import { skip } from "@genesiscz/utils/test/skip";
 *
 *   describe.skipIf(skip.unlessMac)("Apple Mail indexer", () => { … });
 *   describe.skipIf(skip.network)("live crawl", () => { … });
 *   it.skipIf(skip.onWindows)("uses a POSIX path", () => { … });
 *
 * Platform gates evaluate immediately. "Opt-in" gates default to SKIPPED and
 * only run when their env flag is set, e.g.:
 *
 *   RUN_NETWORK_TESTS=1 bun test         # network suites
 *   RUN_NOTIFY_E2E=1 bun test            # real macOS-notification e2e
 *   RUN_E2E=1 bun test                   # heavier end-to-end suites
 *   RUN_WIP_E2E=1 bun test               # tests for in-progress features
 *   RUN_DARWINKIT=1 bun test             # darwinkit native-binary suites (~30s)
 *   RUN_SOLID=1 bun test                 # Solid TUI + live-machine doctor integration (~30s)
 *   RUN_MAIL_INFRA=1 bun test            # EmlxBodyExtractor tests that scan ~/Library/Mail/V10 (~5s each)
 *   RUN_INTEGRATION=1 bun test          # benchmark/timer/say e2e tests that spawn bun subprocesses
 *   RUN_AI_ACCOUNTS=1 bun test           # tests that expect local AI account config (Claude/OpenAI creds)
 *   RUN_CLAUDE_DATA=1 bun test           # tests that discover ~/.claude session data (0 files on CI)
 *   RUN_LOCAL_MODELS=1 bun test          # tests that require locally-installed ONNX models (e.g. sherpa-onnx)
 *   RUN_AUDIO_DEVICE=1 bun test          # tests that need a real audio output device (playback)
 *   RUN_SPOTIFY_DATA=1 bun test          # tests that read the machine's imported Spotify history
 *
 * Env-var names intentionally reuse the conventions already in the repo
 * (RUN_NETWORK_TESTS, RUN_LIVE, …) so existing CI/local muscle memory holds.
 */

function flag(name: string): boolean {
    const v = env.get(name);
    return v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";
export const isCI = flag("CI");
export const isInteractiveTTY = !!process.stdin.isTTY;

/** Opt-in switches (false unless the matching env var is set). */
export const optIn = {
    network: flag("RUN_NETWORK_TESTS"),
    live: flag("RUN_LIVE"),
    liveSmoke: flag("RUN_LIVE_SMOKE"),
    e2e: flag("RUN_E2E"),
    notifyE2E: flag("RUN_NOTIFY_E2E"),
    /** Tests for features still being built (won't pass on a clean tree yet). */
    wip: flag("RUN_WIP_E2E"),
    /**
     * darwinkit native-binary suites — each test spawns `bun run darwinkit/index.ts …`
     * which takes ~0.3s cold-start per call, adding up to ~30s across 8 files.
     * Set RUN_DARWINKIT=1 to include them.
     */
    darwinkit: flag("RUN_DARWINKIT"),
    /**
     * Solid TUI tests (src/doctor/ui/tui) and the live-machine doctor integration
     * smoke (src/doctor/__tests__/integration.test.ts). The integration test runs
     * DiskSpaceAnalyzer + MemoryAnalyzer + ProcessesAnalyzer against the real machine
     * and takes ~30s. Set RUN_SOLID=1 to include them.
     */
    solid: flag("RUN_SOLID"),
    /**
     * Tests that exercise EmlxBodyExtractor which scans ~/Library/Mail/V10 (~0.7s cold,
     * 5s+ under parallel load with 16 workers). These tests require a macOS machine with
     * Apple Mail set up. Set RUN_MAIL_INFRA=1 to include them.
     */
    mailInfra: flag("RUN_MAIL_INFRA"),
    /**
     * Integration e2e tests that spawn `bun run tools <cmd>` subprocesses (benchmark,
     * timer, say). Each subprocess adds ~100–300ms cold-start, and multi-spawn tests
     * exceed the default 5s test timeout under parallel load.
     * Set RUN_INTEGRATION=1 to include them.
     */
    integration: flag("RUN_INTEGRATION"),
    /**
     * The agents CLI matrix e2e: one bash script driving dozens of `tools agents`
     * subprocesses. It passes in ~89s alone but exceeds the default test timeout
     * under the 16-way parallel run, so it belongs to `bun run test:e2e`.
     * Set RUN_AGENTS_E2E=1 to include it in an ordinary run.
     */
    agentsE2E: flag("RUN_AGENTS_E2E"),
    /**
     * Tests that call AIAccount.listClaude() / AIAccount.list(), which read local AI
     * account config (Claude subscriptions, OpenAI keys, etc.). On CI there are no
     * credentials, so list() returns 0 accounts and the length assertions fail.
     * Set RUN_AI_ACCOUNTS=1 to include them.
     */
    aiAccounts: flag("RUN_AI_ACCOUNTS"),
    /**
     * Tests that discover ~/.claude session files (discoverSessionFiles / discoverSessionFilesInDir).
     * On CI the home directory has no Claude Code history, so the count assertions fail.
     * Set RUN_CLAUDE_DATA=1 to include them.
     */
    claudeData: flag("RUN_CLAUDE_DATA"),
    /**
     * Tests that require locally-installed ONNX models such as sherpa-onnx-darwin-arm64.
     * These models are not present on CI runners — the require() will throw and file-existence
     * checks will fail. Set RUN_LOCAL_MODELS=1 to include them.
     */
    localModels: flag("RUN_LOCAL_MODELS"),
    /**
     * Tests that exercise real audio output (playBuffer / playStream via ffplay/afplay).
     * CI runners have no audio device; the promise rejects with a device error.
     * Set RUN_AUDIO_DEVICE=1 to include them.
     */
    audioDevice: flag("RUN_AUDIO_DEVICE"),
    /**
     * Tests that make live calls to paid external AI APIs (OpenAI, Anthropic,
     * @ai-sdk/* providers, Deepgram, Groq, Google GenAI) using real keys from
     * the environment. CI passes no keys (these 401 or self-skip there), but
     * running the full suite locally with keys in env silently burns paid
     * credits and hits provider rate limits. Set RUN_REAL_APIS=1 to include.
     */
    realApis: flag("RUN_REAL_APIS"),
    /**
     * Tests that read the machine's own Spotify listening history (~/.config/me-spotify
     * plus the imported play DB). CI has no such history, so the CLI they drive prints
     * nothing on stdout and the row-count assertions parse an empty body.
     * Set RUN_SPOTIFY_DATA=1 to include them.
     */
    spotifyData: flag("RUN_SPOTIFY_DATA"),
} as const;

/**
 * Booleans to hand directly to `describe.skipIf` / `it.skipIf`.
 * Read each name as "skip when …".
 */
export const skip = {
    /** Skip on Windows (POSIX-only behaviour: shell quoting, path seps, …). */
    onWindows: isWindows,
    /** Skip on Linux. */
    onLinux: isLinux,
    /** Skip unless running on macOS (darwinkit, Apple Mail/Notes, osascript). */
    unlessMac: !isMac,
    /** Skip unless an interactive TTY is attached. */
    unlessInteractive: !isInteractiveTTY,
    /** Skip in CI. */
    inCI: isCI,
    /** Skip unless RUN_NETWORK_TESTS is set. */
    network: !optIn.network,
    /** Skip unless RUN_LIVE is set. */
    live: !optIn.live,
    /** Skip unless RUN_LIVE_SMOKE is set. */
    liveSmoke: !optIn.liveSmoke,
    /** Skip unless RUN_E2E is set. */
    e2e: !optIn.e2e,
    /** Skip unless RUN_NOTIFY_E2E is set (fires real OS notifications). */
    notifyE2E: !optIn.notifyE2E,
    /** Skip unless RUN_WIP_E2E is set (feature under construction). */
    wip: !optIn.wip,
    /**
     * Skip unless RUN_DARWINKIT is set.
     * Gates darwinkit native-binary suites (~30s total, each test spawns bun run).
     */
    darwinkit: !optIn.darwinkit,
    /**
     * Skip unless RUN_SOLID is set.
     * Gates Solid TUI view tests and the live-machine doctor integration smoke (~30s).
     */
    solid: !optIn.solid,
    /**
     * Skip unless RUN_MAIL_INFRA is set.
     * Gates EmlxBodyExtractor tests that scan ~/Library/Mail/V10 (~5s each under load).
     */
    mailInfra: !optIn.mailInfra,
    /**
     * Skip unless RUN_INTEGRATION is set.
     * Gates integration e2e tests that spawn bun subprocesses (benchmark, timer, say).
     */
    integration: !optIn.integration,
    /**
     * Skip unless RUN_AI_ACCOUNTS is set.
     * Gates tests that expect local AI account config (Claude subscriptions, OpenAI keys).
     */
    aiAccounts: !optIn.aiAccounts,
    /**
     * Skip unless RUN_CLAUDE_DATA is set.
     * Gates tests that discover ~/.claude session files — no history present on CI.
     */
    claudeData: !optIn.claudeData,
    /**
     * Skip unless RUN_LOCAL_MODELS is set.
     * Gates tests that require locally-installed ONNX models (e.g. sherpa-onnx).
     */
    localModels: !optIn.localModels,
    /**
     * Skip unless RUN_AUDIO_DEVICE is set.
     * Gates tests that exercise real audio output (ffplay/afplay) — no device on CI.
     */
    audioDevice: !optIn.audioDevice,
    /**
     * Skip unless RUN_REAL_APIS is set.
     * Gates tests that hit live paid AI APIs with real keys (cost + rate limits).
     */
    realApis: !optIn.realApis,
    /**
     * Skip unless RUN_SPOTIFY_DATA is set.
     * Gates tests that need the machine's own imported Spotify history — none on CI.
     */
    spotifyData: !optIn.spotifyData,
} as const;

/** Compose gates: skip if ANY condition is true. */
export function skipIfAny(...conditions: boolean[]): boolean {
    return conditions.some(Boolean);
}

/** Back-compat alias for the originally-proposed helper name. */
export function shouldSkipOnWindows(): boolean {
    return isWindows;
}

/**
 * What an ordinary `bun run test` is NOT running.
 *
 * Opt-in gates are silent by design, which means a green suite can hide whole
 * categories of coverage. The runner prints this once per run so the skipped set
 * is visible rather than folklore.
 */
export function describeGates(): { enabled: string[]; disabled: string[] } {
    const enabled: string[] = [];
    const disabled: string[] = [];

    for (const [name, on] of Object.entries(optIn)) {
        if (on) {
            enabled.push(name);
        } else {
            disabled.push(name);
        }
    }

    return { enabled: enabled.sort(), disabled: disabled.sort() };
}

/** The variable that turns each opt-in gate on, for the runner's hint line. */
export const GATE_ENV_VARS: Record<keyof typeof optIn, string> = {
    network: "RUN_NETWORK_TESTS",
    live: "RUN_LIVE",
    liveSmoke: "RUN_LIVE_SMOKE",
    e2e: "RUN_E2E",
    notifyE2E: "RUN_NOTIFY_E2E",
    wip: "RUN_WIP_E2E",
    darwinkit: "RUN_DARWINKIT",
    solid: "RUN_SOLID",
    mailInfra: "RUN_MAIL_INFRA",
    integration: "RUN_INTEGRATION",
    agentsE2E: "RUN_AGENTS_E2E",
    aiAccounts: "RUN_AI_ACCOUNTS",
    claudeData: "RUN_CLAUDE_DATA",
    localModels: "RUN_LOCAL_MODELS",
    audioDevice: "RUN_AUDIO_DEVICE",
    realApis: "RUN_REAL_APIS",
    spotifyData: "RUN_SPOTIFY_DATA",
};
