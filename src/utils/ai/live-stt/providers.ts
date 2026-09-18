import { MockLiveStt } from "./mock";
import { LIVE_STT_PROVIDERS, type LiveSttProvider, type LiveSttProviderId } from "./types";

export function assertSttProvider(id: string): LiveSttProviderId {
    if (!LIVE_STT_PROVIDERS.includes(id as LiveSttProviderId)) {
        throw new Error(`Unknown STT provider '${id}'. Valid: ${LIVE_STT_PROVIDERS.join(", ")}`);
    }
    return id as LiveSttProviderId;
}

/**
 * Live sessions for Deepgram / Grok / GPT attach in connect(). Unit tests use mock.
 * Network providers refuse in this process unless explicitly constructed with credentials
 * through tools ai accounts — connect() throws a named setup error so tests never dial.
 */
export class UnconfiguredLiveStt implements LiveSttProvider {
    constructor(readonly id: Exclude<LiveSttProviderId, "mock">) {}
    async connect(): Promise<never> {
        throw new Error(
            `STT provider '${this.id}' is not connected in this process. Use tools ai accounts, or --stt mock with --pcm-in for tests.`
        );
    }
}

export function createLiveSttProvider(
    id: LiveSttProviderId,
    mockEvents?: ConstructorParameters<typeof MockLiveStt>[0]
): LiveSttProvider {
    if (id === "mock") {
        return new MockLiveStt(mockEvents);
    }
    return new UnconfiguredLiveStt(id);
}
