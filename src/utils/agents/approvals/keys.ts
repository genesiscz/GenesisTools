import type { DialogKeyPress } from "@genesiscz/utils/agents/dialogs/keys";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import type { HarnessId } from "@genesiscz/utils/harness/types";

/** What a person answers to a waiting tool call. */
export type ApprovalVerdict = "allow" | "allow-always" | "deny";

export const APPROVAL_VERDICTS: readonly ApprovalVerdict[] = ["allow", "allow-always", "deny"];

/** The two dialogs a pane can show for a tool call: a permission prompt, or a plan to approve. */
export type ApprovalDialogKind = "permission" | "plan";

/** A verdict the keys cannot give, with the reason the receipt shows. */
export interface ApprovalKeyRefusal {
    refused: string;
}

/** The presses that answer one dialog kind of one harness, measured live in a scratch session. */
export interface ApprovalDialogKeys {
    allow: DialogKeyPress[];
    allowAlways: DialogKeyPress[] | ApprovalKeyRefusal;
    /** A deny with no words. */
    deny: DialogKeyPress[];
    /** A deny that hands `reason` (one line) to the agent inside the same dialog. */
    denyWithReason: (reason: string) => DialogKeyPress[];
}

export type ApprovalKeySet = ({ supported: true } & ApprovalDialogKeys) | { supported: false; reason: string };

/** The harness driver's `approval` part: one key set per dialog kind. */
export type ApprovalKeyMap = Record<ApprovalDialogKind, ApprovalKeySet>;

export function approvalKeysOf(provider: HarnessId, kind: ApprovalDialogKind): ApprovalKeySet {
    return harnessDriver(provider).parts.approval[kind];
}

export type ApprovalKeyPlan = { ok: true; presses: DialogKeyPress[] } | { ok: false; reason: string };

/** Typed text is one line: a newline in a pane dialog would submit it early. */
export function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** The presses for one verdict, or why the harness cannot give it in its pane. */
export function planApprovalKeys({
    provider,
    kind,
    verdict,
    reason,
}: {
    provider: HarnessId;
    kind: ApprovalDialogKind;
    verdict: ApprovalVerdict;
    reason?: string;
}): ApprovalKeyPlan {
    const keys = approvalKeysOf(provider, kind);

    if (!keys.supported) {
        return { ok: false, reason: keys.reason };
    }

    if (verdict === "allow") {
        return { ok: true, presses: keys.allow };
    }

    if (verdict === "allow-always") {
        return "refused" in keys.allowAlways
            ? { ok: false, reason: keys.allowAlways.refused }
            : { ok: true, presses: keys.allowAlways };
    }

    const words = reason ? oneLine(reason) : "";
    return { ok: true, presses: words ? keys.denyWithReason(words) : keys.deny };
}
