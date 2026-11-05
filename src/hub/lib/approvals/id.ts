import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { ApprovalBackend, ApprovalTarget } from "./types";

const BACKENDS: Readonly<Record<ApprovalBackend, true>> = { pane: true, "codex-worker": true };

/** `<backend>|<provider>|<session>|<call id>`; the call id may hold any character but the first three cannot hold `|`. */
export function approvalId(target: ApprovalTarget): string {
    return [target.backend, target.provider, target.session, target.callId].join("|");
}

function isBackend(value: string): value is ApprovalBackend {
    return Object.hasOwn(BACKENDS, value);
}

export function parseApprovalId(id: string): ApprovalTarget | null {
    const [backend, provider, session, ...rest] = id.split("|");
    const callId = rest.join("|");

    if (!backend || !isBackend(backend) || !provider || !isAccountProviderAlias(provider) || !session || !callId) {
        return null;
    }

    return { backend, provider, session, callId };
}
