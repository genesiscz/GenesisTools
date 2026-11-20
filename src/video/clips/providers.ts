import { kickProvider } from "../kick/provider";
import { twitchProvider } from "../twitch/provider";
import type { ClipProvider, ClipProviderId } from "./types";

/** One entry per site; the key type makes a missing provider a compile error. */
export const CLIP_PROVIDERS: Record<ClipProviderId, ClipProvider> = {
    kick: kickProvider,
    twitch: twitchProvider,
};
