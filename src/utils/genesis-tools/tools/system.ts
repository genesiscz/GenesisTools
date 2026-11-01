import { toolCommand } from "@genesiscz/utils/cli/tool-command";

/**
 * The GenesisTools commands the other modules under `src/utils` name: the agent bus, Claude sessions and terminals,
 * the browser router, macOS grants and the app build, git, search, source maps and speech. This file imports
 * `toolCommand()` and nothing else, so a util that imports it loads no logger, commander or process helper.
 *
 * Every parameter goes into the line as given. A caller that quoted a value with `shellWord()` before passes the
 * quoted value, so each message stays what it was.
 */

/** The agent bus tool itself, for a line that forbids every one of its commands. */
export function agentsCommand(): string {
    return toolCommand("agents");
}

/** Receives bus mail; with `poll`, one check for an agent's replies in a rendezvous session. */
export function agentsLoginCommand(poll?: { agentName: string; sessionFlag: string }): string {
    if (!poll) {
        return toolCommand("agents login");
    }

    return `${toolCommand("agents login")} --agent-name ${poll.agentName} --once ${poll.sessionFlag}`;
}

/** Sends a bus request and waits for its answer. */
export function agentsRequestCommand(): string {
    return toolCommand("agents request");
}

/** Sends a bus message to an agent (`to`) or as a reply to a message (`reply`). `body` goes in as given. */
export function agentsMessageCommand(options: {
    from: string;
    to?: string;
    reply?: string;
    body: string;
    sessionFlag: string;
}): string {
    const parts = [toolCommand("agents message"), `--from ${options.from}`];

    if (options.to !== undefined) {
        parts.push(`--to ${options.to}`);
    }

    if (options.reply !== undefined) {
        parts.push(`--reply ${options.reply}`);
    }

    parts.push(`--body ${options.body}`, options.sessionFlag);
    return parts.join(" ");
}

/** Lists Claude history, the listing that migrates the history index. */
export function claudeHistoryCommand(): string {
    return toolCommand("claude history");
}

/** Rebuilds the history index of one agent tool (`claude`, `codex`, `grok`), which completes its identity migration. */
export function historyIndexCommand(toolName: string): string {
    return toolCommand(`${toolName} history index`);
}

/** Mints a link that scrolls a live Claude session to a decision or a text. */
export function claudeCmuxFindLinkCommand(): string {
    return `${toolCommand("claude cmux find")} --link`;
}

/** Triage and the rescue recipe for a cmux that does not answer. */
export function cmuxDoctorCommand(): string {
    return toolCommand("cmux doctor");
}

/** Attaches to a tmux session on the default socket. */
export function tmuxSessionAttachCommand(session: string): string {
    return `${toolCommand("tmux session attach")} ${session}`;
}

/** Sets the host the browser router's links use. */
export function browserRouterLinkHostCommand(host = "<host>"): string {
    return `${toolCommand("browser-router link-host")} ${host}`;
}

/** Lists the browser router's presets and which ones this Mac routes. */
export function browserRouterPresetsCommand(): string {
    return toolCommand("browser-router presets");
}

/** Opens a message in Mail. */
export function macosMailOpenCommand(): string {
    return toolCommand("macos mail open");
}

/** Shows what macOS granted for Calendar access. */
export function macosCalendarDoctorCommand(): string {
    return toolCommand("macos calendar doctor");
}

/** Opens a System Settings privacy pane and reveals GenesisTools.app in Finder. */
export function macosPermissionsOpenCommand(pane: string): string {
    return `${toolCommand("macos permissions open")} --pane ${pane}`;
}

/** Builds and installs GenesisTools.app. */
export function macosPermissionsBuildCommand(): string {
    return toolCommand("macos permissions build");
}

/** Asks macOS for the notification grant of GenesisTools.app. */
export function notifyAuthorizeCommand(): string {
    return toolCommand("notify authorize");
}

/** Writes the repository's git config, where the main PR branch is declared. */
export function gitConfigInitCommand(): string {
    return toolCommand("git config init");
}

/** Converts a brute-force vector index to sqlite-vec. */
export function indexerMigrateVecCommand(): string {
    return toolCommand("indexer migrate-vec");
}

/** Prints every env value a deployed bundle inlines. */
export function tsSourcemapsEnvCommand(): string {
    return toolCommand("ts sourcemaps env");
}

/** Speaks a text. */
export function sayCommand(): string {
    return toolCommand("say");
}

/** Speaks a text with an ElevenLabs voice. */
export function sayElevenLabsVoiceCommand(): string {
    return `${toolCommand("say")} <text> --provider elevenlabs --voice <voice_id>`;
}
