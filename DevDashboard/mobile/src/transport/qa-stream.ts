import { QA_STREAM_PATH, type QaRow } from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";
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

    /**
     * `/api/qa/stream` is multiplexed: the server tags every frame with `type`, and emits
     * `handoff` frames (`{ id, ev, ts }`) on the same stream as the `qa` ones. A handoff frame
     * carries a handoff id, so an untagged read would push it into the QA list as a row with no
     * question. Drop anything that is not a qa frame, and strip the tag before it reaches the UI.
     */
    function parse(event: SseEvent): QaRow | null {
        try {
            const frame = SafeJSON.parse(event.data, { strict: true }) as { type?: string } & QaRow;

            if (frame.type !== undefined && frame.type !== "qa") {
                return null;
            }

            const { type: _type, ...row } = frame;

            return row as QaRow;
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
