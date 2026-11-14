import { parsePairingPayload } from "@dd/contract";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyPairingUri, type PairingSecrets } from "@/lib/apply-pairing";
import { asksForPassword } from "@/transport/probe";
import { TIERS } from "@/transport/tiers";

/** The query of a `devdashboard://pair?…` link, as the router hands it over (a type alias, so it fits the router's params). */
export type PairingLinkParams = {
    tier?: string;
    baseUrl?: string;
    username?: string;
    pk?: string;
    apk?: string;
};

/** The canonical pairing URI of a link's query; `pk` is the agent key, the older `apk` name is still read. */
export function pairingUriOf(params: PairingLinkParams): string {
    const query = new URLSearchParams();

    for (const key of ["tier", "baseUrl", "username"] as const) {
        const value = params[key];

        if (typeof value === "string" && value.length > 0) {
            query.set(key, value);
        }
    }

    const key = params.pk ?? params.apk;

    if (typeof key === "string" && key.length > 0) {
        query.set("pk", key);
    }

    return `devdashboard://pair?${query.toString()}`;
}

type PairOutcome = "paired" | "failed" | "replaced";

const NOT_A_PAIRING_LINK = "That is not a DevDashboard pairing link.";

/**
 * The pair screen's state (F5). Every link, a tunnel's or a managed one, first shows its address and waits for a
 * confirm, so a link from anyone cannot point the phone at their server unseen. A tunnel then connects without a
 * secret and asks for its password only when the Mac answered 401; a managed link asks for the one-time code.
 *
 * A new link replaces the old one on screen: it clears what the old link left, and the old link's attempt can no
 * longer navigate or write this screen's state. That attempt is not cancelled: the user confirmed it, so the
 * connection store may still commit it, and its own latest-attempt check fences it against a newer connect.
 */
export function usePairingLink(params: PairingLinkParams) {
    const { tier, baseUrl, username, pk, apk } = params;
    const uri = useMemo(() => pairingUriOf({ tier, baseUrl, username, pk, apk }), [tier, baseUrl, username, pk, apk]);
    const pairing = useMemo(() => parsePairingPayload(uri), [uri]);
    const needsCode = pairing ? TIERS[pairing.tier].pairing === "device-code" : false;
    // The first link starts in its own state; the effect below resets it for every later link.
    const [error, setError] = useState<string | null>(pairing ? null : NOT_A_PAIRING_LINK);
    const [busy, setBusy] = useState(false);
    const [asking, setAsking] = useState(false);
    const [confirming, setConfirming] = useState(pairing !== null);
    const [secret, setSecret] = useState("");
    const generation = useRef(0);

    useEffect(() => {
        generation.current += 1;
        setBusy(false);
        setAsking(false);
        setSecret("");
        setConfirming(pairing !== null);
        setError(pairing ? null : NOT_A_PAIRING_LINK);
    }, [pairing]);

    const pair = useCallback(
        async (secrets: PairingSecrets): Promise<PairOutcome> => {
            const mine = generation.current;
            setBusy(true);
            setError(null);
            let result: Awaited<ReturnType<typeof applyPairingUri>>;

            try {
                result = await applyPairingUri(uri, secrets);
            } catch (err) {
                result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            if (mine !== generation.current) {
                return "replaced";
            }

            setBusy(false);

            if (result.ok) {
                router.replace("/");
                return "paired";
            }

            setError(result.error ?? "Could not reach the agent with that pairing.");
            return "failed";
        },
        [uri]
    );

    const submit = useCallback(() => {
        void pair(needsCode ? { deviceCode: secret } : { password: secret });
    }, [pair, needsCode, secret]);

    const confirm = useCallback(() => {
        setConfirming(false);

        if (!pairing) {
            return;
        }

        if (needsCode) {
            setAsking(true);
            return;
        }

        const mine = generation.current;
        void pair({}).then(async (outcome) => {
            if (outcome !== "failed") {
                return;
            }

            // Only a Mac that refused for want of a password gets one; an unreachable one would not use it.
            const asks = await asksForPassword(pairing.baseUrl);

            if (mine === generation.current) {
                setAsking(asks);
            }
        });
    }, [pairing, needsCode, pair]);

    return { pairing, needsCode, error, busy, asking, confirming, secret, setSecret, submit, confirm };
}
