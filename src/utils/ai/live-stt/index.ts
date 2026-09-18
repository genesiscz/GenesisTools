export { MockLiveStt } from "./mock";
export { assertSttProvider, createLiveSttProvider } from "./providers";
export {
    type ConnectOptions,
    LIVE_STT_PROVIDERS,
    type LiveSttProvider,
    type LiveSttProviderId,
    type LiveSttSession,
    type TranscriptEvent,
    type WakeMatch,
} from "./types";
export { DEFAULT_WAKE_PHRASES, matchWake, normalizeUtterance, parseWakePhrases } from "./wake-word";
