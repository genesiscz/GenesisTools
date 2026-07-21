/**
 * Tiny typed UI-string catalog (Feature 08 Layer 3). No i18n framework — a
 * `t(key)` lookup over a plain object, keyed by `MESSAGES.en`. Panel
 * language is a client-only concern (unlike output lang): stored in
 * `chrome.storage.local` under `uiLang`, independent of the server-side
 * output-language preference.
 */
import { useSyncExternalStore } from "react";

const MESSAGES = {
    en: {
        "tab.insights": "Insights",
        "tab.summary": "Summary",
        "tab.ask": "Ask",
        "tab.comments": "Comments",
        "tab.transcript": "Transcript",
        "action.generate": "Generate",
        "action.regenerate": "Re-generate",
        "action.cancel": "Cancel",
        "action.run": "Run",
        "action.save": "Save",
        "action.retry": "Retry",
        "action.signingIn": "Signing in…",
        "action.creatingAccount": "Creating account…",
        "action.logIn": "Log in",
        "action.logOut": "Log out",
        "action.register": "Register",
        "action.createAccount": "Create account",
        "action.exportJson": "Export JSON",
        "action.importJson": "Import JSON",
        "action.showAll": "Show all",
        "action.revoke": "Revoke",
        "action.reallyRevoke": "Really revoke?",
        "action.reallyDelete": "Really delete?",
        "summary.title": "Whole-video summary",
        "summary.generate": "Generate summary…",
        "summary.regenerate": "Re-generate…",
        "summary.empty": "No long-form summary yet.",
        "summary.loading": "Loading summary",
        "insights.title": "Key insights",
        "insights.generate": "Generate insights…",
        "insights.regenerate": "Re-generate…",
        "insights.empty": "No timestamped insights yet.",
        "insights.loading": "Loading insights",
        "ask.title": "Ask the video",
        "ask.placeholder": "Ask a question…",
        "ask.loading": "Thinking…",
        "transcript.loading": "Loading transcript",
        "transcript.empty": "No transcript",
        "transcript.fetch": "Fetch transcript",
        "transcript.fetching": "Fetching transcript…",
        "transcript.translating": "Translating…",
        "transcript.original": "Original",
        "comments.empty": "No comments fetched yet.",
        "settings.title": "Account",
        "settings.signedInAs": "Signed in as",
        "settings.getDiamonds": "Get diamonds",
        "settings.shares": "Shares",
        "settings.presets": "Presets",
        "settings.language": "Language",
        "settings.outputLanguage": "Output language",
        "settings.panelLanguage": "Panel language",
        "settings.noShares": "Nothing shared yet — share a summary from any video.",
        "settings.noPresets": "No presets yet — create one from any generate dialog.",
        "settings.descSignedIn": "Diamonds pay for summaries and questions.",
        "settings.descSignedOut": "Sign in to spend diamonds on summaries and questions. New accounts start with 100.",
        "settings.paymentsUnconfigured": "Payments aren't configured on this server yet.",
        "settings.adminPanel": "Admin panel",
        "library.header": "your library",
        "library.history": "History",
        "library.collections": "Collections",
        "error.generationFailed": "Generation failed",
        "error.translationFailed": "Translation failed",
        "auth.email": "Email",
        "auth.password": "Password",
        "auth.emailPlaceholder": "you@example.com",
        "auth.passwordLoginPlaceholder": "Your password",
        "auth.passwordRegisterPlaceholder": "At least 8 characters",
        "auth.registerHint": "New accounts start with 💎 100.",
    },
    cs: {
        "tab.insights": "Přehled",
        "tab.summary": "Shrnutí",
        "tab.ask": "Dotaz",
        "tab.comments": "Komentáře",
        "tab.transcript": "Přepis",
        "action.generate": "Vytvořit",
        "action.regenerate": "Vytvořit znovu",
        "action.cancel": "Zrušit",
        "action.run": "Spustit",
        "action.save": "Uložit",
        "action.retry": "Zkusit znovu",
        "action.signingIn": "Přihlašování…",
        "action.creatingAccount": "Vytváření účtu…",
        "action.logIn": "Přihlásit se",
        "action.logOut": "Odhlásit se",
        "action.register": "Registrovat",
        "action.createAccount": "Vytvořit účet",
        "action.exportJson": "Exportovat JSON",
        "action.importJson": "Importovat JSON",
        "action.showAll": "Zobrazit vše",
        "action.revoke": "Zrušit sdílení",
        "action.reallyRevoke": "Opravdu zrušit?",
        "action.reallyDelete": "Opravdu smazat?",
        "summary.title": "Shrnutí celého videa",
        "summary.generate": "Vytvořit shrnutí…",
        "summary.regenerate": "Vytvořit znovu…",
        "summary.empty": "Zatím žádné shrnutí.",
        "summary.loading": "Načítám shrnutí",
        "insights.title": "Klíčové body",
        "insights.generate": "Vytvořit body…",
        "insights.regenerate": "Vytvořit znovu…",
        "insights.empty": "Zatím žádné časované body.",
        "insights.loading": "Načítám body",
        "ask.title": "Zeptejte se videa",
        "ask.placeholder": "Napište otázku…",
        "ask.loading": "Přemýšlím…",
        "transcript.loading": "Načítám přepis",
        "transcript.empty": "Žádný přepis",
        "transcript.fetch": "Načíst přepis",
        "transcript.fetching": "Načítám přepis…",
        "transcript.translating": "Překládám…",
        "transcript.original": "Originál",
        "comments.empty": "Komentáře zatím nenačteny.",
        "settings.title": "Účet",
        "settings.signedInAs": "Přihlášen jako",
        "settings.getDiamonds": "Získat diamanty",
        "settings.shares": "Sdílení",
        "settings.presets": "Předvolby",
        "settings.language": "Jazyk",
        "settings.outputLanguage": "Jazyk výstupu",
        "settings.panelLanguage": "Jazyk panelu",
        "settings.noShares": "Zatím nic nesdíleno — sdílejte shrnutí z libovolného videa.",
        "settings.noPresets": "Zatím žádné předvolby — vytvořte ji v libovolném dialogu generování.",
        "settings.descSignedIn": "Diamanty platí za shrnutí a dotazy.",
        "settings.descSignedOut": "Přihlaste se a utrácejte diamanty za shrnutí a dotazy. Nové účty začínají se 100.",
        "settings.paymentsUnconfigured": "Platby na tomto serveru zatím nejsou nastavené.",
        "settings.adminPanel": "Administrace",
        "library.header": "vaše knihovna",
        "library.history": "Historie",
        "library.collections": "Kolekce",
        "error.generationFailed": "Generování selhalo",
        "error.translationFailed": "Překlad selhal",
        "auth.email": "E-mail",
        "auth.password": "Heslo",
        "auth.emailPlaceholder": "vy@example.com",
        "auth.passwordLoginPlaceholder": "Vaše heslo",
        "auth.passwordRegisterPlaceholder": "Alespoň 8 znaků",
        "auth.registerHint": "Nové účty začínají s 💎 100.",
    },
} as const;

export type MessageKey = keyof typeof MESSAGES.en;
export type UiLang = keyof typeof MESSAGES;

const UI_LANG_STORAGE_KEY = "uiLang";
const listeners = new Set<() => void>();
let currentLang: UiLang = detectInitialLang();

function detectInitialLang(): UiLang {
    if (typeof navigator === "undefined" || typeof navigator.language !== "string") {
        return "en";
    }

    return navigator.language.toLowerCase().startsWith("cs") ? "cs" : "en";
}

function isUiLang(value: unknown): value is UiLang {
    return value === "en" || value === "cs";
}

export function getUiLang(): UiLang {
    return currentLang;
}

/** Sets the in-memory language (and notifies subscribers). Does not persist — call `persistUiLang` too. */
export function setUiLang(lang: string): void {
    const next: UiLang = isUiLang(lang) ? lang : "en";

    if (next === currentLang) {
        return;
    }

    currentLang = next;

    for (const listener of listeners) {
        listener();
    }
}

/** Loads the persisted panel language from `chrome.storage.local`, falling back to `navigator.language`. Call once on panel mount. */
export async function loadUiLang(): Promise<void> {
    const stored = await chrome.storage.local.get([UI_LANG_STORAGE_KEY]);

    if (isUiLang(stored[UI_LANG_STORAGE_KEY])) {
        setUiLang(stored[UI_LANG_STORAGE_KEY]);
    }
}

export async function persistUiLang(lang: string): Promise<void> {
    setUiLang(lang);
    await chrome.storage.local.set({ [UI_LANG_STORAGE_KEY]: getUiLang() });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => listeners.delete(listener);
}

/** Subscribes the calling component to panel-language changes (re-renders on switch). */
export function useUiLang(): UiLang {
    return useSyncExternalStore(subscribe, () => currentLang);
}

export function t(key: MessageKey): string {
    return MESSAGES[currentLang][key] ?? MESSAGES.en[key];
}

/** Component-scoped `t()` that re-renders the caller when the panel language changes. */
export function useT(): typeof t {
    useUiLang();
    return t;
}
