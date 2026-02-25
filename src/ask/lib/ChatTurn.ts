import { ChatEvent } from "./ChatEvent";
import type { ChatResponse } from "./types";

/**
 * ChatTurn — returned by AIChat.send(), both awaitable and streamable.
 *
 * Usage:
 *   const response = await chat.send("hello");           // buffered
 *   for await (const event of chat.send("hello")) { }    // streaming
 *   const turn = chat.send("hello");
 *   const response = await turn.response;                 // deferred
 */
export class ChatTurn implements PromiseLike<ChatResponse>, AsyncIterable<ChatEvent> {
    private readonly _source: () => AsyncGenerator<ChatEvent>;
    private readonly _onChunk?: (text: string) => void;
    private _consumed = false;
    private _buffer: ChatEvent[] = [];
    private _responseResolve!: (value: ChatResponse) => void;
    private _responseReject!: (reason: unknown) => void;
    private _drainStarted = false;

    /** The final response — resolves after the stream completes */
    readonly response: Promise<ChatResponse>;

    constructor(
        source: () => AsyncGenerator<ChatEvent>,
        onChunk?: (text: string) => void,
    ) {
        this._source = source;
        this._onChunk = onChunk;
        this.response = new Promise<ChatResponse>((resolve, reject) => {
            this._responseResolve = resolve;
            this._responseReject = reject;
        });
    }

    /** PromiseLike — await the turn to get the buffered ChatResponse */
    then<TResult1 = ChatResponse, TResult2 = never>(
        onfulfilled?: ((value: ChatResponse) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this._drain().then(onfulfilled, onrejected);
    }

    /** AsyncIterable — iterate to get streaming ChatEvents */
    [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
        if (this._consumed) {
            // Replay from buffer if already consumed
            return this._replayFromBuffer();
        }

        this._consumed = true;
        return this._iterateWithCallbacks();
    }

    /** Drain the stream internally, resolve with ChatResponse */
    private async _drain(): Promise<ChatResponse> {
        if (this._drainStarted) {
            return this.response;
        }

        this._drainStarted = true;

        try {
            const gen = this._source();

            for await (const event of gen) {
                this._buffer.push(event);

                if (event.isText() && this._onChunk) {
                    this._onChunk(event.text);
                }

                if (event.isDone()) {
                    this._responseResolve(event.response);
                    return event.response;
                }
            }

            // If no done event, create a fallback response from buffered text
            const content = this._buffer
                .filter((e) => e.isText())
                .map((e) => e.text)
                .join("");

            const fallback: ChatResponse = { content, duration: 0 };
            this._responseResolve(fallback);
            return fallback;
        } catch (error) {
            this._responseReject(error);
            throw error;
        }
    }

    /** Iterate the source, calling onChunk and resolving response */
    private async *_iterateWithCallbacks(): AsyncGenerator<ChatEvent> {
        this._drainStarted = true;

        try {
            const gen = this._source();

            for await (const event of gen) {
                this._buffer.push(event);

                if (event.isText() && this._onChunk) {
                    this._onChunk(event.text);
                }

                if (event.isDone()) {
                    this._responseResolve(event.response);
                }

                yield event;
            }

            // If no done event was emitted, resolve with fallback
            if (!this._buffer.some((e) => e.isDone())) {
                const content = this._buffer
                    .filter((e) => e.isText())
                    .map((e) => e.text)
                    .join("");
                this._responseResolve({ content, duration: 0 });
            }
        } catch (error) {
            this._responseReject(error);
            throw error;
        }
    }

    /** Replay events from buffer for second consumer */
    private async *_replayFromBuffer(): AsyncGenerator<ChatEvent> {
        for (const event of this._buffer) {
            yield event;
        }
    }
}
