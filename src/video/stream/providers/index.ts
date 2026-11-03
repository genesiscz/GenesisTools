import type { HarLog } from "@genesiscz/utils/hls/har";
import { streamyard } from "./streamyard";
import type { ProviderEvent, StreamProvider } from "./types";

export type { EventState, ProviderEvent, StreamProvider } from "./types";

/** Every platform the stream downloader can ask for a finished recording. */
export const STREAM_PROVIDERS: StreamProvider[] = [streamyard];

export function providerById(id: string): StreamProvider {
    const provider = STREAM_PROVIDERS.find((candidate) => candidate.id === id);

    if (!provider) {
        throw new Error(`Unknown stream provider "${id}"`);
    }

    return provider;
}

export function findProviderEvents(log: HarLog): ProviderEvent[] {
    return STREAM_PROVIDERS.flatMap((provider) => provider.find(log));
}

/** Whether a browser capture must keep this response body for some provider. */
export function providerWantsBody(url: string): boolean {
    return STREAM_PROVIDERS.some((provider) => provider.wantsBody(url));
}
