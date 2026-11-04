import type { ApiDescriptor } from "@genesiscz/utils/api-descriptor";
import { renderDocs } from "@genesiscz/utils/api-descriptor";
import type { ShowInput } from "./show";

/** What a toolset gets from the kernel when it is preloaded into a fresh worker. */
export interface ToolsetContext {
    recorder?: { start(options: unknown): Promise<string> };
    /** A private folder for this worker's life; the kernel removes it when the worker stops. */
    scratchDir: string;
    /** Returns an image to the model with the current turn's result. */
    show(input: ShowInput): Promise<void>;
    /** Adds a line to the current turn's text. */
    write(value: unknown): void;
}

/**
 * One preloadable REPL API: a global (or several) built once per kernel spawn, documented by its descriptor, and
 * disposed on reset and exit. A new toolset is one subclass and one line in the kernel's `REPL_TOOLSETS` table.
 */
export abstract class ReplToolset {
    abstract readonly api: ApiDescriptor;

    get id(): string {
        return this.api.id;
    }

    get title(): string {
        return this.api.title;
    }

    get summary(): string {
        return this.api.summary;
    }

    /** The full API, as `help(id)` prints it. */
    docs(): string {
        return renderDocs(this.api);
    }

    /** The one line the `js` tool description carries. */
    oneLine(): string {
        return `${this.api.global}: ${this.api.summary}`;
    }

    /** Builds the globals inside the worker; runs once per spawn, outside every turn's timeout. */
    abstract bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>>;

    /** Releases what `bootstrap` started (a recording, a native session). */
    async dispose(): Promise<void> {}
}

export type ReplToolsetFactory = () => ReplToolset;
