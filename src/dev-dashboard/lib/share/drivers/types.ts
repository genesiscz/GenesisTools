import type { PublishedNote } from "@app/dev-dashboard/config";
import type { ShareDriverKind, ShareTarget, ShareTargetOf } from "@app/dev-dashboard/lib/share/drivers/options";

/** One question a driver's setup asks; `flag` is the CLI flag that answers it without a prompt. */
export interface SetupPrompt {
    flag: string;
    message: string;
    initial?: string;
    /** An error message for a wrong answer, or undefined when the answer is fine. */
    validate?: (value: string) => string | undefined;
}

/** Answers a prompt: the terminal asks the person, a non-TTY run throws `MissingSetupValueError`. */
export type SetupAsk = (prompt: SetupPrompt) => Promise<string>;

export interface ShareTargetSetupInput {
    name: string;
    /** Answers given as flags, by flag name without dashes (`url`, `code`, `public-base`). */
    values: Partial<Record<string, string>>;
    ask: SetupAsk;
}

export class MissingSetupValueError extends Error {
    constructor(readonly flag: string) {
        super(`--${flag} is required`);
    }
}

/**
 * How shares reach one kind of target. A target (`share.targets[]`) names its driver; the driver does the work.
 * Every method takes the target of its own kind (`targetOf` checks it).
 */
export interface ShareDriver {
    readonly kind: ShareDriverKind;
    /** One line for `share target add --help` and the guided setup. */
    readonly summary: string;
    /** The link a person gets for `slug` on this target. */
    pageUrl(target: ShareTarget, slug: string): Promise<string>;
    /** Bring the target's copy of the note up to date (a share, a re-share, `share sync`). */
    sync(target: ShareTarget, note: PublishedNote): Promise<void>;
    /** Remove the note from the target (an unshare). Removing a slug the target never had succeeds. */
    remove(target: ShareTarget, slug: string): Promise<void>;
    /** The slugs the target holds, or null when the driver cannot list them. */
    listSlugs(target: ShareTarget): Promise<string[] | null>;
    /** The guided setup behind `share target add <name> --driver <kind>`. */
    setup(input: ShareTargetSetupInput): Promise<ShareTarget>;
    /** Drop what setup stored outside the config (a vault token), when the target is removed. */
    forget(target: ShareTarget): Promise<void>;
}

/** `target` as its driver's own type; a mismatch is a programming error in the driver table. */
export function targetOf<K extends ShareDriverKind>(target: ShareTarget, kind: K): ShareTargetOf<K> {
    if (target.driver !== kind) {
        throw new Error(`share target "${target.name}" uses driver ${target.driver}, not ${kind}`);
    }

    return target as ShareTargetOf<K>;
}

/** A flag's value, or the person's answer. */
export async function setupValue(input: ShareTargetSetupInput, prompt: SetupPrompt): Promise<string> {
    const given = input.values[prompt.flag]?.trim();

    if (given) {
        const problem = prompt.validate?.(given);

        if (problem) {
            throw new Error(`--${prompt.flag}: ${problem}`);
        }

        return given;
    }

    return input.ask(prompt);
}

export function pageUrlUnder(publicBase: string, slug: string): string {
    return `${publicBase.replace(/\/+$/, "")}/${encodeURIComponent(slug)}`;
}

export function validateUrl(value: string): string | undefined {
    return URL.canParse(value) && /^https?:/.test(value) ? undefined : "an http(s) URL, e.g. https://example.com/share";
}
