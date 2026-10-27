import { answerSessionRows, type SessionRowsRequest } from "./session-rows";

declare const self: Worker;

// The hub server's session rows rebuild, on its own thread (SessionRowsRunner): the server's event loop keeps
// answering every other door while this one walks the transcripts.
self.onmessage = async (event: MessageEvent<SessionRowsRequest>) => {
    self.postMessage(await answerSessionRows(event.data));
};
