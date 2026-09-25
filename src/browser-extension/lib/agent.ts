import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { OpenResult } from "@genesiscz/utils/open-in";
import type { BrowserExtensionConfig } from "./config";
import type { Deps } from "./deps";
import { FeatureError } from "./errors";

const log = logger.child({ component: "browser-extension/agent" });

/** Page text can be long; an agent prompt past this is cut, with a note, rather than refused. */
export const PROMPT_TEXT_CAP = 40_000;

/**
 * Writes a prompt to its own file. Page-derived text lives only in this file: the command line
 * that starts an agent names the file and nothing else.
 */
export async function writePromptFile({
    deps,
    kind,
    text,
}: {
    deps: Pick<Deps, "promptDir" | "now">;
    kind: string;
    text: string;
}): Promise<string> {
    await mkdir(deps.promptDir, { recursive: true });
    const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
    const file = join(deps.promptDir, `${stamp}-${kind}-${crypto.randomUUID().slice(0, 8)}.md`);
    await Bun.write(file, text);
    log.info({ file, kind, bytes: text.length }, "prompt file written");
    return file;
}

export function promptSentence(file: string): string {
    return `Read the task in ${file} and do it.`;
}

export function interactiveArgv(config: BrowserExtensionConfig, promptFile: string): string[] {
    return [...config.agent.interactive, promptSentence(promptFile)];
}

/** A new terminal at `cwd` running the interactive agent on a prompt file. */
export async function startSession({
    deps,
    config,
    cwd,
    title,
    kind,
    prompt,
}: {
    deps: Deps;
    config: BrowserExtensionConfig;
    cwd: string;
    title: string;
    kind: string;
    prompt: string;
}): Promise<OpenResult & { promptFile: string }> {
    const promptFile = await writePromptFile({ deps, kind, text: prompt });
    const opened = await deps.terminal(config.terminal).open({
        cwd,
        title,
        argv: interactiveArgv(config, promptFile),
    });
    return { ...opened, promptFile };
}

/** Runs the headless agent in `cwd` with the prompt on stdin and returns its answer. */
export async function askHeadless({
    deps,
    config,
    cwd,
    prompt,
}: {
    deps: Deps;
    config: BrowserExtensionConfig;
    cwd: string;
    prompt: string;
}): Promise<string> {
    const res = await deps.run(config.agent.headless, {
        cwd,
        timeoutMs: config.agent.headlessTimeoutMs,
        stdin: prompt,
    });

    if (res.code !== 0) {
        const detail = (res.stderr.trim() || res.stdout.trim()).slice(-500);
        throw new FeatureError("failed", `${config.agent.headless.join(" ")} exited ${res.code}: ${detail}`);
    }

    return res.stdout.trim();
}

export function capText(text: string): string {
    return text.length > PROMPT_TEXT_CAP
        ? `${text.slice(0, PROMPT_TEXT_CAP)}\n[cut at ${PROMPT_TEXT_CAP} characters]`
        : text;
}
