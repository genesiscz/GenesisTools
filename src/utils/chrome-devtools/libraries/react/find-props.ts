import type { CdpLike } from "../../cdp-like.ts";
import { callInPage, type InPageCallOptions } from "../../evaluate.ts";
import { type ReactFindArgs, type ReactFindResult, reactFind } from "./in-page/react-find.ts";

export type { ReactFindArgs, ReactFindResult, ReactMatch, ReactMatcher } from "./in-page/react-find.ts";

/**
 * Finds React props by structured matchers in one walk over every React root of the page.
 * Use `exposeAs` to keep a live object (a QueryClient, a Redux store) on `window` for later calls.
 */
export async function findReactProps(
    cdp: CdpLike,
    args: ReactFindArgs,
    options: InPageCallOptions = {}
): Promise<ReactFindResult> {
    const useless = args.matchers.filter((matcher) => !matcher.hasFunction && !matcher.hasPath && !matcher.component);
    if (useless.length > 0) {
        throw new Error(
            `matcher(s) ${useless.map((matcher) => matcher.name).join(", ")} need hasFunction, hasPath or component`
        );
    }

    return callInPage(cdp, reactFind, args, options);
}
