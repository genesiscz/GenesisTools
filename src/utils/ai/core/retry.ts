import { VaultKeyDeniedError } from "@genesiscz/utils/security/keyring/app-gate";
import { MasterKeyUnavailableError } from "@genesiscz/utils/security/MasterKey";
import { CredentialUnavailableError } from "../providers/credentials";
import { UnknownProviderError } from "../providers/registry";
import { ModelRefError } from "./model-ref";
import { ModelResolutionError } from "./resolve";

/**
 * Errors a retry cannot fix, by class: no model or provider for the task, a
 * malformed ref, a missing credential, and a vault key the app refused or never
 * answered for (that wait is 169 s, so retrying it tripled the hang).
 */
const PERMANENT_CLASSES = [
    ModelResolutionError,
    ModelRefError,
    UnknownProviderError,
    CredentialUnavailableError,
    VaultKeyDeniedError,
    MasterKeyUnavailableError,
] as const;

/**
 * The same, for classes that live in `tasks/` above this layer. Importing them
 * here would make `core` import `tasks` and close a cycle (facade imports
 * Transcriber, which imports this file), so they are matched by the `name`
 * their constructor sets.
 */
const PERMANENT_NAMES = new Set(["NoProviderForTaskError", "NotImplementedError"]);

/** HTTP statuses that mean the request itself is wrong: bad input, bad credentials, no such model. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);

/** `statusCode` (AI SDK `APICallError`, `UpstreamStatusError`, `RetryableApiError`) or `status` (fetch-shaped errors). */
function httpStatus(error: object): number | undefined {
    const record = error as { statusCode?: unknown; status?: unknown };

    if (typeof record.statusCode === "number") {
        return record.statusCode;
    }

    return typeof record.status === "number" ? record.status : undefined;
}

/**
 * Whether a failed AI call is worth another attempt.
 *
 * The one retry predicate for every task verb. It used to be four private copies
 * (Summarizer, Translator, Embedder, Transcriber); the Transcriber copy was the
 * widest, so its message rules are the ones kept here.
 *
 * Anything not recognised as permanent is retried, because a rate limit or a
 * dropped connection reads differently per provider and missing one costs a
 * failed command, while retrying a permanent error only costs the delay.
 */
export function isTransientAiError(error: unknown): boolean {
    if (error instanceof Error) {
        if (PERMANENT_CLASSES.some((type) => error instanceof type) || PERMANENT_NAMES.has(error.name)) {
            return false;
        }

        const status = httpStatus(error);

        if (status !== undefined && PERMANENT_STATUSES.has(status)) {
            return false;
        }
    }

    const msg = error instanceof Error ? error.message : String(error);

    // Permanent HTTP errors: bad credentials, bad model, invalid input.
    if (/\b(401|403|404|400)\b/.test(msg)) {
        return false;
    }

    // Permanent provider errors.
    if (/\b(invalid.api.key|unauthorized|forbidden|model.not.found)\b/i.test(msg)) {
        return false;
    }

    // Permanent capability or format mismatches: retrying just repeats the error.
    if (/unsupported.model.version|does not support the format|unsupported.format/i.test(msg)) {
        return false;
    }

    return true;
}
