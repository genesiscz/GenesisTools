import type { Download } from "./downloads";

/** What the word check knows about one language beyond its spelling dictionary. */
export interface LanguageRules {
    code: string;
    /** The language loan words come from; their stems are checked in it. */
    loanLanguage?: string;
    /** Words as people say them, one "word count" per line: the spoken forms a dictionary lacks. */
    wordList?: Download;
    /** The written forms a spoken word may stand for, the word itself not included. */
    writtenForms(word: string): string[];
    /** The words left once a prefix of the language is gone; a known one makes the word a derived form. */
    prefixedRoots(word: string): string[];
    /** The stems a loan word may have once its prefix and ending are gone. */
    loanStems(word: string): string[];
}
