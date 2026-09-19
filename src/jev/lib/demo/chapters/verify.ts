import { PURPOSE_TEMPLATES } from "../../screen/templates";
import { verifyClaims } from "../../screen/verify";
import type { FixtureScript } from "../fixture-evaluator";
import { VERIFY_CLAIMS, VERIFY_DOCUMENT } from "../fixtures";
import { type Chapter, createEventLog, mismatch } from "./context";

const PURPOSE_IDS = ["secrets", "pii-contact", "accuracy"];

/**
 * The `secrets` document question is scripted above the gate rule's 0.5 threshold, so the gate
 * MUST block. A chapter that reported green here while the gate stayed open would be the
 * "demo is always green" bug in its purest form.
 */
export const VERIFY_SCRIPT: FixtureScript = {
    boolean: [
        [/^secrets__secrets$/, 0.95],
        [/^secrets__/, 0.1],
        [/^pii-contact__/, 0.9],
        [/^claim__c1__supported$/, 0.95],
        [/^claim__c2__contradicted$/, 0.92],
        [/^claim__/, 0.05],
    ],
    score: [[/risk/, 0]],
};

/** Claim scoring plus the document gate. `ok` means the gate behaved as the fixture expects. */
export const verifyChapter: Chapter = async (context) => {
    const log = createEventLog(context.now);
    const purposes = PURPOSE_TEMPLATES.filter((template) => PURPOSE_IDS.includes(template.id));
    log.add("templates", purposes.map((template) => template.id).join(","));
    const result = await verifyClaims({
        claims: VERIFY_CLAIMS,
        against: VERIFY_DOCUMENT,
        purposes,
        evaluate: context.evaluator(VERIFY_SCRIPT),
        signal: context.signal,
    });
    const reasons = result.gate.reasons.map((reason) => reason.id).join(",");
    log.add(`gate:${result.gate.block ? "block" : "open"}`, reasons || "no rule fired");
    const readback =
        result.gate.block &&
        result.gate.reasons.some((reason) => reason.id === "secrets") &&
        result.missingAnswers.length === 0 &&
        result.claims.every((claim) => claim.supported !== null);
    log.add("readback", `block=${result.gate.block} missing=${result.missingAnswers.length}`);
    return {
        readback,
        reason: readback
            ? "gate_blocked_on_secrets_as_scripted"
            : mismatch(
                  "gate block on secrets with every answer present",
                  `block=${result.gate.block} reasons=${reasons || "none"} missing=${result.missingAnswers.join(",") || "none"}`
              ),
        events: log.events(),
        result,
    };
};
