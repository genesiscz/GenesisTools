import Storage from "expo-sqlite/kv-store";

export type TerminalDriverId = "webview-ttyd" | "webview-html" | "native";

interface Prefs {
    "dd.theme": "system" | "light" | "dark";
    "dd.terminalDriver": TerminalDriverId;
    "dd.lastSessionId": string;
}

export async function getPref<K extends keyof Prefs>(key: K): Promise<Prefs[K] | null> {
    const v = await Storage.getItem(key);

    return v === null ? null : (JSON.parse(v) as Prefs[K]);
}

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
    await Storage.setItem(key, JSON.stringify(value));
}

export async function removePref<K extends keyof Prefs>(key: K): Promise<void> {
    await Storage.removeItem(key);
}
