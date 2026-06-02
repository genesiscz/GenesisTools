import { QA_STREAM_PATH, type QaRow } from "@dd/contract";
import { SafeJSON } from "@app/utils/json";
import { streamSse as defaultStreamSse, type SseEvent, type SseHandle, type StreamSseOptions } from "@/transport/sse-parser";
import type { QaStream, QaStreamStatus } from "@/transport/Transport";

type StreamSseImpl = (opts: StreamSseOptions) => SseHandle;

export interface QaStreamOptions {
    baseUrl: string;
    authHeader: () => string | undefined;
    /** Override for tests / the E2E decorator. Defaults to expo/fetch streamSse. */
    streamSseImpl?: StreamSseImpl;
}

export function createQaStream(opts: QaStreamOptions): QaStream {
    const streamImpl = opts.streamSseImpl ?? defaultStreamSse;
    const seen = new Set<string>();
    let handle: SseHandle | null = null;

    function parse(event: SseEvent): QaRow | null {
        try {
            return SafeJSON.parse(event.data, { strict: true }) as QaRow;
        } catch {
            return null;
        }
    }

    return {
        connect(onRow: (entry: QaRow) => void, onStatus: (status: QaStreamStatus) => void) {
            onStatus("connecting");
            const auth = opts.authHeader();

            handle = streamImpl({
                url: `${opts.baseUrl}${QA_STREAM_PATH}`,
                headers: auth ? { Authorization: auth } : undefined,
                onOpen: () => onStatus("open"),
                onError: () => onStatus("error"),
                onEvent: (event) => {
                    const entry = parse(event);

                    if (!entry || seen.has(entry.id)) {
                        return;
                    }

                    seen.add(entry.id);
                    onRow(entry);
                },
            });
        },
        close() {
            handle?.close();
            handle = null;
        },
    };
}
