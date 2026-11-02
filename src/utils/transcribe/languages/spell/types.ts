/** A spell checker for one language, opened and ready. */
export interface SpellEngine {
    /** The words of `words` the engine accepts as correctly spelled. */
    accepted(words: string[]): Set<string>;
    dispose(): void;
}

/** One way to check spelling: an engine plus the dictionaries it needs. */
export interface SpellProvider {
    readonly id: string;
    readonly description: string;
    /** Why the provider cannot check `language` here (another system, no dictionary); undefined when it can. */
    unavailable(language: string): string | undefined;
    /** Opens the engine, fetching its dictionaries on first use. */
    open(language: string): Promise<SpellEngine>;
}
