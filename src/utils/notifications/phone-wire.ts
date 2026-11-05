/**
 * The push wire between the Mac's phone channel and the phone: what a push carries under `gt`, how the notification
 * categories are named, and what a device sends when it registers. Pure (no imports), because the phone bundle reads
 * it through the dev-dashboard contract (`@dd/contract/push`).
 */

/** The key of the GenesisTools block in a push payload, beside Apple's `aps`. */
export const PUSH_DATA_KEY = "gt";

/** The most answer buttons one notice carries; a decision with more options opens the app instead. */
export const MAX_ANSWER_LETTERS = 6;

/** A NaCl box (X25519 + XSalsa20-Poly1305) from the Mac's push key to one device's key, both parts base64. */
export interface SealedBox {
    nonce: string;
    box: string;
}

/** What a sealed box opens to: the act token of each answer letter. */
export interface PushSecrets {
    tokens: Record<string, string>;
}

/** A visible notice. With `letters`, the category carries one button per letter and `sealed` holds their tokens. */
export interface PushNoticeData {
    v: 1;
    kind: "notice";
    noticeId?: string;
    letters?: string[];
    sealed?: SealedBox;
}

/** A silent push: take these notices off the lock screen, because what they asked about is closed. */
export interface PushRetractData {
    v: 1;
    kind: "retract";
    noticeIds: string[];
}

export type PushData = PushNoticeData | PushRetractData;

/** The category of a notice with `count` answer letters, the recommended one marked; one id per shape. */
export function answerCategoryId(count: number, recommended?: string): string {
    const marked = recommended && letterIndex(recommended) < count ? `-${recommended}` : "";
    return `gt-answer-${count}${marked}`;
}

/** Every category the phone registers at start: 1 to MAX letters, each with no mark or one letter marked. */
export function answerCategories(): { id: string; letters: string[]; recommended?: string }[] {
    const categories: { id: string; letters: string[]; recommended?: string }[] = [];

    for (let count = 1; count <= MAX_ANSWER_LETTERS; count++) {
        const letters = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
        categories.push({ id: answerCategoryId(count), letters });

        for (const recommended of letters) {
            categories.push({ id: answerCategoryId(count, recommended), letters, recommended });
        }
    }

    return categories;
}

/** The action id of one answer button. */
export function answerActionId(letter: string): string {
    return `answer:${letter}`;
}

/** The Reply field of an answer category: a text answer, sent with the token under `REPLY_TOKEN_KEY`. */
export const REPLY_ACTION_ID = "answer:reply";
/** The key of the reply token in `PushSecrets.tokens`, beside the letters. */
export const REPLY_TOKEN_KEY = "reply";

/** The letter an answer button stands for, or null for any other action (a plain tap, a dismiss). */
export function letterOfAction(actionId: string): string | null {
    const match = /^answer:([a-z])$/.exec(actionId);
    return match ? match[1] : null;
}

function letterIndex(letter: string): number {
    return letter.trim().toLowerCase().charCodeAt(0) - 97;
}

/**
 * What a phone sends to `POST /api/push/devices`. A real phone names its APNs token; a simulator has none and names its
 * simulator id, which `xcrun simctl push` delivers to.
 */
export interface PushDeviceRegistration {
    /** Stable per install. */
    id: string;
    name: string;
    bundleId: string;
    /** The device's own box public key (base64); the Mac seals answer tokens to it. */
    publicKey: string;
    apns?: { token: string };
    simulator?: { udid: string };
}

export interface PushDeviceReceipt {
    id: string;
    /** The Mac's push public key (base64), which opens the sealed tokens on the device. */
    macPublicKey: string;
    /** How the Mac reaches this device. */
    route: "apns" | "simctl";
}
