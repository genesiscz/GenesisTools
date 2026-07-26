/**
 * Ambient tags for the stage currently executing. Every model call a stage makes
 * is tagged with these, so the proxy can group the whole run's transcripts into
 * one directory and `requests.jsonl` can answer "which job was that slow call?".
 *
 * Set once by `runStage`; individual jobs add their own `label`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestTags } from "@genesiscz/utils/ai/proxy/AiProxyClient";

const storage = new AsyncLocalStorage<RequestTags>();

/** Run `fn` with these tags applied to every model call made inside it. */
export function withStageTags<T>(tags: RequestTags, fn: () => Promise<T>): Promise<T> {
    return storage.run(tags, fn);
}

/** Tags of the enclosing stage, if any. */
export function currentStageTags(): RequestTags | undefined {
    return storage.getStore();
}
