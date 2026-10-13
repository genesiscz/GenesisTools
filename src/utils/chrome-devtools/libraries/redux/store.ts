import type { CdpLike } from "../../cdp-like.ts";
import { callInPage, type InPageCallOptions } from "../../evaluate.ts";
import { type ReduxStateArgs, type ReduxStateSize, reduxStateSize } from "./in-page/state-size.ts";

export type { ReduxSliceSize, ReduxStateArgs, ReduxStateSize } from "./in-page/state-size.ts";

/** Measures the Redux state of the store kept on `window[slot]` (expose it first with `findReactProps`). */
export function readReduxState(
    cdp: CdpLike,
    args: ReduxStateArgs,
    options: InPageCallOptions = {}
): Promise<ReduxStateSize> {
    return callInPage(cdp, reduxStateSize, args, options);
}
