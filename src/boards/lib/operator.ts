import { Storage } from "@app/utils/storage/storage";

const TOOL_NAME = "boards";
const OPERATOR_KEY = "operator";
const MAX_LEN = 40;

/** Fresh each call so tests that flip GENESIS_TOOLS_HOME see the new root (Storage reads it
 *  at construction). Production only ever has one root, so the extra construct is negligible. */
function boardsStorage(): Storage {
    return new Storage(TOOL_NAME);
}

/** Strip control characters (mirrors the server's actor sanitization intent) and cap length. */
export function sanitizeOperator(name: string): string {
    const printable = [...name]
        .filter((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code >= 0x20 && code !== 0x7f;
        })
        .slice(0, MAX_LEN)
        .join("");
    return printable.trim();
}

export async function readLocalOperator(): Promise<string> {
    return (await boardsStorage().getConfigValue<string>(OPERATOR_KEY)) ?? "";
}

export async function writeLocalOperator(name: string): Promise<void> {
    await boardsStorage().setConfigValue(OPERATOR_KEY, name);
}

/** Actor for a CLI write: `--actor` flag > the persisted local operator > none. */
export async function resolveActor(flag?: string): Promise<string | undefined> {
    if (flag) {
        return sanitizeOperator(flag) || undefined;
    }
    const local = await readLocalOperator();
    return local || undefined;
}
