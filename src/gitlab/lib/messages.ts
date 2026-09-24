/**
 * Texts that `stale-branches` writes onto merge requests. English is the default; the Czech
 * catalog is built in. Any key can be overridden in `~/.genesis-tools/gitlab/config.json`
 * under `messages`, with `{name}` placeholders.
 */

export const MESSAGE_LANGUAGES = ["en", "cs"] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

const EN = {
    "closedBug.lead":
        "⚠️ This MR is still open, although its [{type} - ADO {id} - {title}]({url}) is already closed{closed}.",
    "closedBug.codeHuge": "- Code: the MR changes {files} (+{insertions} lines), too many to compare its content.",
    "closedBug.codeUnknown": "- Code: the MR adds no lines that can be compared, so where the fix is stays unknown.",
    "closedBug.code": "- Code: {size}; {comparable} comparable lines{sample}: {parts}{missing}",
    "closedBug.size": "the MR adds {lines} ({files})",
    "closedBug.sample": ", sampled",
    "closedBug.percent": "{value}%",
    "closedBug.partUat": "{ref} {matched} ({pct})",
    "closedBug.partProduction": "{ref} {matched} ({pct})",
    "closedBug.partTest": "{ref} {matched} ({pct})",
    "closedBug.missing": "; missing on {ref}: {files}{more}",
    "closedBug.missingMore": " and {count} more",
    "closedBug.linkedThis": "- The work item names this MR as the fix.",
    "closedBug.linkedOther": "- The work item names !{iid} as the fix.",
    "closedBug.linkedUrl": "- The work item names {url} as the fix.",
    "closedBug.environment": " (environment in the work item: {environment})",
    "closedBug.askUnreleased":
        "- {badge} The bug was closed after a test{environment}, but the fix is only on {test} and never reached {release}. Either merge this MR into {release}, or explain on the bug why it cannot ship, and close the MR.",
    "closedBug.askNowhere":
        "- {badge} The bug is closed, but this fix is on none of {refs}. If the bug was fixed another way or needs no fix, close this MR; otherwise the bug should be reopened and this MR merged.",
    "closedBug.askPartial":
        "- {badge} Only part of the change is on {release} and the bug is closed. If the rest is no longer needed, close this MR; otherwise the bug should be reopened and this MR merged.",
    "closedBug.askReleased":
        "- {badge} The change is already on {release} and the bug is closed, so this MR can be closed.",
    "closedBug.askUnknown": "- Please say whether the fix is in production; the content of the MR does not tell.",
} as const;

export type MessageKey = keyof typeof EN;
export type MessageCatalog = Record<MessageKey, string>;

const CS: MessageCatalog = {
    "closedBug.lead":
        "⚠️ Tenhle MR je stále otevřený, i když jeho [{type} - ADO {id} - {title}]({url}) je už zavřený{closed}.",
    "closedBug.codeHuge": "- Kód: MR má {files} (+{insertions} řádků), takže obsah nejde rozumně porovnat.",
    "closedBug.codeUnknown": "- Kód: MR nepřidává řádky, které by šly porovnat, takže nevím, kde fix je.",
    "closedBug.code": "- Kód: {size}; porovnatelných řádků je {comparable}{sample}: {parts}{missing}",
    "closedBug.size": "MR přidává {lines} ({files})",
    "closedBug.sample": ", vzorek",
    "closedBug.percent": "{value} %",
    "closedBug.partUat": "ve {ref} {matched} ({pct})",
    "closedBug.partProduction": "v {ref} {matched} ({pct})",
    "closedBug.partTest": "na {ref} {matched} ({pct})",
    "closedBug.missing": "; ve {ref} chybí {files}{more}",
    "closedBug.missingMore": " a další {count}",
    "closedBug.linkedThis": "- V ADO je tenhle MR uvedený jako oprava.",
    "closedBug.linkedOther": "- V ADO je jako oprava uvedený !{iid}.",
    "closedBug.linkedUrl": "- V ADO je jako oprava uvedený {url}.",
    "closedBug.environment": " (prostředí v ADO: {environment})",
    "closedBug.askUnreleased":
        "- {badge} Bug se zavřel po testu{environment}, ale fix je jen na {test}, do UAT ani do produkce se nedostal. Buď MR domergni do {release}, nebo k bugu napiš, proč do produkce nejde, a MR zavři.",
    "closedBug.askNowhere":
        "- {badge} Bug je zavřený, ale tenhle fix není na {test}, ve {release} ani v produkci. Jestli se bug opravil jinak nebo opravu nepotřebuje, MR zavři; jinak by se měl bug znovu otevřít a MR domergnout.",
    "closedBug.askPartial":
        "- {badge} Ve {release} je jen část změny a bug je zavřený. Jestli zbytek už není potřeba, MR zavři; jinak by se měl bug znovu otevřít a MR domergnout.",
    "closedBug.askReleased": "- {badge} Změna už je ve {release} a bug je zavřený, MR jde zavřít.",
    "closedBug.askUnknown": "- Napiš prosím, jestli je fix v produkci; z obsahu MR to nepoznám.",
};

export const MESSAGE_KEYS = Object.keys(EN) as MessageKey[];

interface PluralForms {
    one: string;
    few: string;
    many: string;
}

const NOUNS: Record<MessageLanguage, { line: PluralForms; file: PluralForms }> = {
    en: {
        line: { one: "line", few: "lines", many: "lines" },
        file: { one: "file", few: "files", many: "files" },
    },
    cs: {
        line: { one: "řádek", few: "řádky", many: "řádků" },
        file: { one: "soubor", few: "soubory", many: "souborů" },
    },
};

export interface Messages {
    language: MessageLanguage;
    text(key: MessageKey, vars?: Record<string, string | number>): string;
    /** `3 files`, `1 soubor`: the count with the noun in the right plural form. */
    count(n: number, noun: "line" | "file"): string;
}

export function fillTemplate(template: string, vars: Record<string, string | number> = {}): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

function pluralForm(language: MessageLanguage, n: number, forms: PluralForms): string {
    if (n === 1) {
        return forms.one;
    }

    if (language === "cs" && n >= 2 && n <= 4) {
        return forms.few;
    }

    return forms.many;
}

export function createMessages(
    language: MessageLanguage = "en",
    overrides: Partial<Record<MessageKey, string>> = {}
): Messages {
    const catalog: MessageCatalog = { ...(language === "cs" ? CS : EN), ...overrides };

    return {
        language,
        text: (key, vars) => fillTemplate(catalog[key], vars),
        count: (n, noun) => `${n} ${pluralForm(language, n, NOUNS[language][noun])}`,
    };
}
