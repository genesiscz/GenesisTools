import { expect, test } from "bun:test";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { screenFiles } from "./batch";
import { changedFiles } from "./changed";
import { parseCustomTemplates } from "./custom";
import { evaluateGate } from "./gate";
import { emitReport, GATE_EXIT_CODE } from "./report";
import { toSarif } from "./sarif";
import { documentQuestionKey, PURPOSE_IDS, PURPOSE_TEMPLATES, parsePurposes, templateById } from "./templates";
import { parseClaims, verifyClaims } from "./verify";

function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}

/** Answers every asked question, so a missing answer can only come from a missing question. */
function answerEverything(probabilities: Record<string, number> = {}): Evaluator {
    return async (call) => {
        const request = evaluationSchema.parse(call.input);
        const answers: EvaluationResponse["answers"] = {};
        for (const [id, question] of Object.entries(request.questions)) {
            answers[id] =
                question.type === "score"
                    ? { type: "score", score: probabilities[id] ?? 0 }
                    : { type: "boolean", probability: probabilities[id] ?? 0.05 };
        }

        return evaluation(answers);
    };
}

const PR410_TEMPLATE_IDS = [
    "pii-names",
    "pii-contact",
    "secrets",
    "prompt-injection",
    "relevance",
    "risk",
    "accuracy",
    "contradiction",
    "license-ok",
    "focus-safety",
];

const PR411_TEMPLATE_IDS = [
    "focus-safety",
    "secrets",
    "pr-review",
    "control-refusal",
    "compact-safe",
    "license",
    "public-api-break",
    "macos-tcc",
    "test-accounts",
];

test("the template registry has no duplicate ids and every question carries instruction text", () => {
    expect(new Set(PURPOSE_IDS).size).toBe(PURPOSE_IDS.length);
    for (const template of PURPOSE_TEMPLATES) {
        expect(template.summary.length).toBeGreaterThan(0);
        expect(template.questions.length).toBeGreaterThan(0);
        expect(new Set(template.questions.map((question) => question.id)).size).toBe(template.questions.length);
        for (const question of template.questions) {
            expect(question.instructions.length).toBeGreaterThan(10);

            if (question.type === "score") {
                expect(question.criteria?.length ?? 0).toBeGreaterThanOrEqual(2);
            }
        }
    }
});

test("every PR 410 and PR 411 template survives under exactly one id", () => {
    for (const id of [...PR410_TEMPLATE_IDS, ...PR411_TEMPLATE_IDS]) {
        expect(templateById(id)).toBeDefined();
    }

    expect(templateById("license-ok")?.id).toBe("license");
    expect(templateById("license")?.id).toBe("license");
    expect(PURPOSE_IDS).not.toContain("license-ok");
    expect(parsePurposes("license-ok,license").map((template) => template.id)).toEqual(["license"]);
});

test("screen batches 21 files into two evaluate calls and never asks for a comment", async () => {
    let calls = 0;
    const evaluate: Evaluator = async (call) => {
        calls += 1;
        const request = evaluationSchema.parse(call.input);
        expect(SafeJSON.stringify(request.questions)).not.toContain("write a review");
        const answers: EvaluationResponse["answers"] = {};
        for (const id of Object.keys(request.questions)) {
            answers[id] = { type: "boolean", probability: id.includes("risky") ? 0.9 : 0.1 };
        }

        return evaluation(answers);
    };
    const files = Array.from({ length: 21 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        text: "export const x = 1;",
    }));
    const result = await screenFiles({ files, purposes: parsePurposes("focus-safety"), evaluate });
    expect(result.batches).toBe(2);
    expect(result.scores).toHaveLength(21);
    expect(result.scores[0]?.answers[documentQuestionKey("focus-safety", "risky")]).toBe(0.9);
    expect(result.missingAnswers).toEqual([]);
    expect(calls).toBe(2);
});

test("screen keeps two templates that share a question id apart", async () => {
    const purposes = parsePurposes("focus-safety,pr-review");
    const evaluate: Evaluator = async (call) => {
        const request = evaluationSchema.parse(call.input);
        const answers: EvaluationResponse["answers"] = {};
        for (const id of Object.keys(request.questions)) {
            answers[id] = { type: "boolean", probability: id.includes("pr-review") ? 0.8 : 0.2 };
        }

        return evaluation(answers);
    };
    const result = await screenFiles({
        files: [{ path: "src/a.ts", text: "export const a = 1;" }],
        purposes,
        evaluate,
    });
    expect(result.scores[0]?.answers[documentQuestionKey("focus-safety", "risky")]).toBe(0.2);
    expect(result.scores[0]?.answers[documentQuestionKey("pr-review", "risky")]).toBe(0.8);
});

test("B12: per-claim answers are filled even when --purpose names only document templates", async () => {
    let askedQuestions: string[] = [];
    const evaluate: Evaluator = async (call) => {
        const request = evaluationSchema.parse(call.input);
        askedQuestions = Object.keys(request.questions);
        return answerEverything({
            claim__c1__supported: 0.93,
            claim__c1__contradicted: 0.02,
            claim__c1__sensitive: 0.88,
            claim__c2__supported: 0.11,
            claim__c2__contradicted: 0.71,
            claim__c2__sensitive: 0.64,
        })(call);
    };
    const claims = parseClaims(
        SafeJSON.stringify([
            { id: "c1", text: "The text names a person." },
            { id: "c2", text: "The text carries a deploy token." },
        ])
    );
    const result = await verifyClaims({
        claims,
        against: "Contact alice@example.com. The token is ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLE0000.",
        purposes: parsePurposes("pii-names,secrets"),
        evaluate,
    });

    expect(askedQuestions).toContain("claim__c1__supported");
    expect(askedQuestions).toContain("claim__c2__sensitive");
    expect(result.missingAnswers).toEqual([]);
    expect(result.claims).toHaveLength(2);
    for (const claim of result.claims) {
        expect(typeof claim.supported).toBe("number");
        expect(typeof claim.contradicted).toBe("number");
        expect(typeof claim.sensitive).toBe("number");
    }

    expect(result.claims[0]?.supported).toBe(0.93);
    expect(result.claims[1]?.contradicted).toBe(0.71);
});

test("a claim question the evaluator skipped is reported as missing, never as a zero", async () => {
    const evaluate: Evaluator = async () => evaluation({ claim__c1__supported: { type: "boolean", probability: 0.9 } });
    const result = await verifyClaims({
        claims: parseClaims("- the release notes list every breaking change"),
        against: "Release notes: nothing breaking.",
        purposes: parsePurposes("relevance"),
        evaluate,
    });
    expect(result.claims[0]?.supported).toBe(0.9);
    expect(result.claims[0]?.contradicted).toBeNull();
    expect(result.missingAnswers).toContain("claim__c1__contradicted");
    expect(result.missingAnswers).toContain("claim__c1__sensitive");
});

test("the gate blocks on secrets and stays quiet for a template nobody selected", async () => {
    const secretsKey = documentQuestionKey("secrets", "secrets");
    const blocked = evaluateGate({
        document: { [secretsKey]: 0.91 },
        selectedTemplateIds: ["secrets"],
        subject: "against.txt",
    });
    expect(blocked.block).toBe(true);
    expect(blocked.reasons.map((reason) => reason.id)).toEqual(["secrets"]);
    expect(blocked.reasons[0]?.file).toBe("against.txt");

    const unselected = evaluateGate({ document: { [secretsKey]: 0.91 }, selectedTemplateIds: ["relevance"] });
    expect(unselected.block).toBe(false);
});

test("--gate sets exit code 2 and names the reasons", () => {
    const previousExitCode = process.exitCode;
    try {
        const gate = evaluateGate({
            document: { [documentQuestionKey("secrets", "secrets")]: 0.97 },
            selectedTemplateIds: ["secrets"],
            subject: "against.txt",
        });
        emitReport({
            result: { gate },
            gate,
            subjects: [{ uri: "against.txt", document: {}, gate }],
            purposes: parsePurposes("secrets"),
            gateEnabled: true,
            sarif: false,
        });
        expect(process.exitCode).toBe(GATE_EXIT_CODE);
    } finally {
        process.exitCode = previousExitCode;
    }
});

test("SARIF output carries version, schema, driver rules and located results", async () => {
    const purposes = parsePurposes("secrets,pii-names");
    const evaluate = answerEverything({
        [`${documentQuestionKey("secrets", "secrets")}`]: 0.96,
        [`${documentQuestionKey("pii-names", "names")}`]: 0.82,
        claim__c1__contradicted: 0.77,
    });
    const result = await verifyClaims({
        claims: parseClaims(SafeJSON.stringify([{ id: "c1", text: "no credentials are present" }])),
        against: "token ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLE0000 belongs to alice@example.com",
        purposes,
        uri: "against.txt",
        evaluate,
    });
    const log = toSarif({
        subjects: [{ uri: "against.txt", document: result.document, gate: result.gate, claims: result.claims }],
        purposes,
    });

    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-2.1.0");
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];

    if (!run) {
        throw new Error("SARIF run missing");
    }

    expect(run.tool.driver.rules.length).toBeGreaterThan(0);
    expect(run.results.length).toBeGreaterThan(0);
    for (const entry of run.results) {
        expect(entry.ruleId.length).toBeGreaterThan(0);
        expect(["error", "warning", "note"]).toContain(entry.level);
        expect(entry.message.text.length).toBeGreaterThan(0);
        expect(entry.locations[0]?.physicalLocation.artifactLocation.uri).toBe("against.txt");
        expect(run.tool.driver.rules.some((rule) => rule.id === entry.ruleId)).toBe(true);
    }

    const secretsResult = run.results.find((entry) => entry.ruleId === "secrets/secrets");
    expect(secretsResult?.level).toBe("error");
    expect(run.results.some((entry) => entry.ruleId === "claim/contradicted")).toBe(true);
});

test("a custom template id that collides with a builtin throws, and a duplicate inside the file throws", () => {
    expect(() =>
        parseCustomTemplates(
            SafeJSON.stringify([{ id: "secrets", type: "boolean", instructions: "Does it leak a key?" }])
        )
    ).toThrow(/collides with a builtin/);
    expect(() =>
        parseCustomTemplates(
            SafeJSON.stringify([{ id: "license-ok", type: "boolean", instructions: "Does it change a license?" }])
        )
    ).toThrow(/collides with a builtin/);
    expect(() =>
        parseCustomTemplates(
            SafeJSON.stringify([
                { id: "house-style", type: "boolean", instructions: "Does it follow the house style?" },
                { id: "house-style", type: "boolean", instructions: "Does it follow the house style again?" },
            ])
        )
    ).toThrow(/appears twice/);
});

test("a custom template is asked and can carry its own gate", async () => {
    const custom = parseCustomTemplates(
        SafeJSON.stringify([
            { id: "house-style", type: "boolean", instructions: "Does the text break the house style?", gate: 0.6 },
        ])
    );
    const evaluate = answerEverything({ "house-style__answer": 0.81 });
    const result = await verifyClaims({
        claims: parseClaims("- the file follows the house style"),
        against: "const x=1",
        purposes: parsePurposes("relevance"),
        custom,
        evaluate,
    });
    expect(result.document["house-style__answer"]).toBe(0.81);
    expect(result.gate.block).toBe(true);
    expect(result.gate.reasons.map((reason) => reason.id)).toEqual(["house-style"]);
});

test("only-changed keeps paths from git diff --name-only", () => {
    expect(changedFiles("src", () => "src/jev/lib/screen/verify.ts\nREADME.md\n")).toEqual([
        "src/jev/lib/screen/verify.ts",
    ]);
    expect(changedFiles("src/jev", () => "src/jev/lib/screen/gate.ts\nsrc/control/index.ts\n")).toEqual([
        "src/jev/lib/screen/gate.ts",
    ]);
});

test("screen refuses a claim-only purpose because it has no document question", async () => {
    await expect(
        screenFiles({
            files: [{ path: "src/a.ts", text: "export const a = 1;" }],
            purposes: parsePurposes("accuracy,contradiction"),
            evaluate: answerEverything(),
        })
    ).rejects.toThrow(/at least one document template/);
});

test("an unknown purpose names the valid ids instead of silently scoring nothing", () => {
    expect(() => parsePurposes("not-a-template")).toThrow(/Unknown purpose template/);
    expect(() => parsePurposes("not-a-template")).toThrow(/focus-safety/);
});
