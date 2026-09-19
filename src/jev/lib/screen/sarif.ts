import { logger } from "@genesiscz/utils/logger";
import { type CustomTemplate, customAsTemplate } from "./custom";
import type { GateVerdict } from "./gate";
import { CLAIM_QUESTIONS, type PurposeTemplate, templateById } from "./templates";
import type { ClaimScore } from "./verify";

/**
 * SARIF 2.1.0 for `--sarif`, so a verify or screen run can be uploaded as a code-scanning result.
 *
 * A gate reason becomes an `error`; a boolean question over `REPORT_THRESHOLD` that no gate covers
 * becomes a `warning`; a contradicted or sensitive claim becomes a `warning` naming the claim.
 * PR #410 emitted gate reasons only, so a run that found names and contact details but blocked on
 * nothing produced an empty `results` array.
 */
const REPORT_THRESHOLD = 0.5;
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const DRIVER_NAME = "tools-jev";

export interface SarifResult {
    ruleId: string;
    level: "error" | "warning" | "note";
    message: { text: string };
    locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
    properties: Record<string, unknown>;
}

export interface SarifRule {
    id: string;
    name: string;
    shortDescription: { text: string };
}

export interface SarifLog {
    version: "2.1.0";
    $schema: string;
    runs: Array<{
        tool: { driver: { name: string; informationUri: string; rules: SarifRule[] } };
        results: SarifResult[];
    }>;
}

export function ruleIdFor(templateId: string, questionId: string): string {
    return `${templateId}/${questionId}`;
}

export interface SarifSubject {
    uri: string;
    document: Record<string, number | null>;
    gate: GateVerdict;
    claims?: ClaimScore[];
}

export function toSarif(options: {
    subjects: SarifSubject[];
    purposes: PurposeTemplate[];
    custom?: CustomTemplate[];
}): SarifLog {
    const templates = [...options.purposes, ...(options.custom ?? []).map(customAsTemplate)];
    const results: SarifResult[] = [];
    for (const subject of options.subjects) {
        results.push(...gateResults(subject));
        results.push(...questionResults(subject, templates));
        results.push(...claimResults(subject));
    }

    const log: SarifLog = {
        version: "2.1.0",
        $schema: SARIF_SCHEMA,
        runs: [
            {
                tool: {
                    driver: {
                        name: DRIVER_NAME,
                        informationUri: "https://github.com/genesiscz/GenesisTools",
                        rules: rulesFor(results, templates),
                    },
                },
                results,
            },
        ],
    };
    logger.info(
        { subjects: options.subjects.length, results: results.length, rules: log.runs[0]?.tool.driver.rules.length },
        "Built SARIF report"
    );
    return log;
}

function gateResults(subject: SarifSubject): SarifResult[] {
    return subject.gate.reasons.map((reason) => ({
        ruleId: ruleIdFor(reason.templateId, reason.questionId),
        level: "error" as const,
        message: {
            text: `Gate '${reason.id}' fired: ${reason.score} reached the threshold ${reason.threshold}. ${reason.description}`,
        },
        locations: [{ physicalLocation: { artifactLocation: { uri: reason.file ?? subject.uri } } }],
        properties: { gate: true, score: reason.score, threshold: reason.threshold },
    }));
}

function questionResults(subject: SarifSubject, templates: PurposeTemplate[]): SarifResult[] {
    const gated = new Set(subject.gate.reasons.map((reason) => reason.key));
    const results: SarifResult[] = [];
    for (const template of templates) {
        for (const question of template.questions) {
            const key = `${template.id}__${question.id}`;
            const score = subject.document[key];

            if (gated.has(key) || typeof score !== "number" || question.type !== "boolean") {
                continue;
            }

            if (score < REPORT_THRESHOLD) {
                continue;
            }

            results.push({
                ruleId: ruleIdFor(template.id, question.id),
                level: "warning",
                message: { text: `${question.instructions} Jev answered yes with probability ${score}.` },
                locations: [{ physicalLocation: { artifactLocation: { uri: subject.uri } } }],
                properties: { gate: false, score },
            });
        }
    }

    return results;
}

function claimResults(subject: SarifSubject): SarifResult[] {
    const results: SarifResult[] = [];
    for (const claim of subject.claims ?? []) {
        const findings: Array<[string, number | null]> = [
            ["contradicted", claim.contradicted],
            ["sensitive", claim.sensitive],
        ];
        for (const [questionId, score] of findings) {
            if (typeof score !== "number" || score < REPORT_THRESHOLD) {
                continue;
            }

            results.push({
                ruleId: ruleIdFor("claim", questionId),
                level: "warning",
                message: { text: `Claim ${claim.id} scored ${score} on '${questionId}': ${claim.text}` },
                locations: [{ physicalLocation: { artifactLocation: { uri: subject.uri } } }],
                properties: { gate: false, score, claimId: claim.id },
            });
        }
    }

    return results;
}

function rulesFor(results: SarifResult[], templates: PurposeTemplate[]): SarifRule[] {
    const rules = new Map<string, SarifRule>();
    for (const result of results) {
        if (rules.has(result.ruleId)) {
            continue;
        }

        const [templateId = "", questionId = ""] = result.ruleId.split("/");
        const template = templates.find((entry) => entry.id === templateId) ?? templateById(templateId);
        const question =
            templateId === "claim"
                ? CLAIM_QUESTIONS.find((entry) => entry.id === questionId)
                : template?.questions.find((entry) => entry.id === questionId);
        rules.set(result.ruleId, {
            id: result.ruleId,
            name: result.ruleId,
            shortDescription: {
                text: question?.instructions ?? template?.summary ?? `Jev ${templateId} question '${questionId}'.`,
            },
        });
    }

    return [...rules.values()];
}
