import type { IndexerCallbacks } from "./events";

interface SpinnerLike {
    message: (msg: string) => void;
}

/** Create standard progress callbacks that update a clack spinner */
export function createProgressCallbacks(spinner: SpinnerLike): IndexerCallbacks {
    return {
        onScanProgress: (payload) => {
            const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
            spinner.message(
                `Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
            );
        },
        onScanComplete: (payload) => {
            if (payload.added > 0) {
                spinner.message(`Scanned: ${payload.added.toLocaleString()} new items`);
            } else {
                spinner.message("Index is up to date");
            }
        },
        onChunkFile: (payload) => {
            spinner.message(`Chunking: ${payload.filePath.slice(-60)}`);
        },
        onEmbedProgress: (payload) => {
            const pct = Math.round((payload.completed / payload.total) * 100);
            spinner.message(
                `Embedding... ${payload.completed.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
            );
        },
    };
}
