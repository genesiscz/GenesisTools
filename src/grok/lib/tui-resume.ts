import { resumeArgv } from "@genesiscz/utils/agent-sessions/resume-argv";
import type { AgentSession } from "@genesiscz/utils/agent-sessions/types";
import { accountEnvVar } from "@genesiscz/utils/ai/account-env";
import { env } from "@genesiscz/utils/env";

export function grokTuiResumeArgv(binary: string, sessionId: string): string[] {
    return [binary, ...resumeArgv("grok", sessionId).slice(1)];
}

export interface GrokTuiSpawnInput {
    binary: string;
    session?: AgentSession;
    /** `--resume` with no value: the native picker. */
    nativeResume?: boolean;
    /** `-c, --continue`. */
    continueLast?: boolean;
    model?: string;
    passthrough?: string[];
    cwd?: string;
    account?: string;
    /** The login file the session bills; `GROK_AUTH_PATH` overrides the home's own `auth.json`. */
    authPath?: string;
    /** The home the session tree lives in; the session's own home wins over it. */
    home?: string;
}

/**
 * The grok TUI is launched with the caller's environment, read through the env
 * facade rather than `process.env` (repo rule), so `env.testing.set()` reaches
 * this spawn like it reaches the worker's.
 */
export function buildGrokTuiSpawn(options: GrokTuiSpawnInput): {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
} {
    const { session, binary, account } = options;
    const mode = session
        ? grokTuiResumeArgv(binary, session.sessionId)
        : [binary, ...(options.nativeResume ? ["--resume"] : options.continueLast ? ["--continue"] : [])];
    const home = session?.sourceHome ?? options.home;
    const built: Record<string, string | undefined> = {
        ...env.getProcessEnv(),
        ...(home ? { GROK_HOME: home } : {}),
        // Read back off the process table to say which account a live pane bills. Grok
        // identifies a login by its home and never by a name, and no transcript records
        // one either, so this export is the only place the name survives the launch.
        ...(account ? { [accountEnvVar("grok")]: account } : {}),
    };

    if (options.authPath) {
        // The binary prefers an API key over its OAuth login, so the key has to go, exactly
        // as the headless worker does; otherwise a subscription launch bills the metered team.
        delete built.XAI_API_KEY;
        delete built.GROK_CODE_XAI_API_KEY;
        built.GROK_AUTH_PATH = options.authPath;
    }

    return {
        cmd: [...mode, ...(options.model ? ["-m", options.model] : []), ...(options.passthrough ?? [])],
        // The shared launch path already chose between the session's directory and the
        // requested one (and warned when the recorded one is gone), so an explicit cwd wins.
        cwd: options.cwd ?? session?.cwd ?? process.cwd(),
        env: built,
    };
}
