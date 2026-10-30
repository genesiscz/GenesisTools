import { type ZipEntry, zip } from "./zip";

self.onmessage = (event: MessageEvent<ZipEntry[]>) => {
    try {
        const body = zip(event.data);
        self.postMessage({ body }, { transfer: [body.buffer] });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
