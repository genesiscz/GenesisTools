import { logger } from "@genesiscz/utils/logger";

/** Serial cleanup, replaceable work, and publication gated by the desired revision. */
export class LatestPreparation<T> {
    private revision = 0;
    private controller?: AbortController;
    private tail: Promise<unknown> = Promise.resolve();

    request(prepare: (signal: AbortSignal) => Promise<T>): Promise<{ revision: number; value: T } | null> {
        const revision = ++this.revision;
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const previous = this.tail;
        const work = (async () => {
            try {
                await previous;
            } catch (error) {
                logger.debug({ error }, "Prior media preparation ended before replacement");
            }

            if (revision !== this.revision) {
                return null;
            }

            try {
                const value = await prepare(controller.signal);
                return revision === this.revision && !controller.signal.aborted ? { revision, value } : null;
            } catch (error) {
                if (controller.signal.aborted || revision !== this.revision) {
                    return null;
                }

                throw error;
            }
        })();
        this.tail = work;
        return work;
    }

    cancel(): void {
        this.revision += 1;
        this.controller?.abort();
    }
}
