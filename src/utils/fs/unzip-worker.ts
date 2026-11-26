import { unzip } from "./unzip";

self.onmessage = (event: MessageEvent<{ body: Uint8Array; options: { maxTotalBytes?: number } }>) => {
    try {
        const files = unzip(event.data.body, event.data.options);
        self.postMessage({ files }, { transfer: [...files.values()].map((entry) => entry.buffer) });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
