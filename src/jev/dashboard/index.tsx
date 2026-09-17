import { Badge, Callout, CodeBlock, JsonView, Meter } from "@artifact/kit";
import { SafeJSON } from "@genesiscz/utils/json";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import { DashboardLayout } from "@ui/layouts/DashboardLayout";
import {
    Braces,
    CheckCheck,
    Code2,
    Download,
    FlaskConical,
    Gamepad2,
    Play,
    RefreshCw,
    RotateCcw,
    Square,
    StepForward,
    Terminal,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CompileResult } from "../lib/compiler";
import type { ExperimentStep } from "../lib/experiment";
import { generationMode } from "../lib/generation";
import { languages } from "../lib/languages";
import type { EvaluationResponse } from "../lib/service";
import { type TypeScriptRequest, typescriptPresets } from "../lib/typescript-grammar";
import { ArenaLab } from "./ArenaLab";
import { api, download, errorMessage } from "./client";
import "./styles.css";

const DEFAULT_STATE = "The support agent issued a full refund to the customer.";
const DEFAULT_REQUEST = {
    state: "My card was charged twice for one order. Please refund the duplicate charge. Delivery was fine.",
    questions: {
        refundRequested: { type: "boolean", instructions: "Is a refund requested?" },
        route: {
            type: "choice",
            instructions: "Which team should handle this ticket?",
            criteria: { billing: "payments and charges", shipping: "delivery problems", technical: "application bugs" },
        },
        urgency: { type: "score", instructions: "Rate urgency.", criteria: ["low", "medium", "high"] },
    },
};
const percent = (value: number | undefined) => (value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);
const tokenLabel = (token: string) =>
    token === "\n" ? "\\n" : token === "\t" ? "\\t" : token === " " ? "space" : token;

function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
    return (
        <Card variant="default">
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-4">
                <CardTitle className="text-sm">{title}</CardTitle>
                {extra}
            </CardHeader>
            <CardContent className="space-y-5">{children}</CardContent>
        </Card>
    );
}
function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }) {
    return (
        <div className="jev-field">
            <label htmlFor={id}>{label}</label>
            {children}
            {hint && <p className="jev-help">{hint}</p>}
        </div>
    );
}
function ErrorNotice({ message }: { message: string }) {
    return message ? (
        <div role="alert" className="jev-error">
            <Callout tone="err" title="Request could not finish">
                {message}
            </Callout>
        </div>
    ) : null;
}
function Zdr({
    checked,
    onChange,
    disabled,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked)}
            />
            Require Zero Data Retention <span className="text-primary">Pro / Enterprise</span>
        </label>
    );
}

function Answers({ result }: { result?: EvaluationResponse }) {
    if (!result) {
        return (
            <div className="jev-empty">
                <CheckCheck size={32} />
                <h2 className="text-foreground">A decision starts with context</h2>
                <p className="text-sm">Run a question to inspect Jev's answer and probabilities here.</p>
            </div>
        );
    }

    return (
        <div className="jev-stack">
            {Object.entries(result.answers).map(([id, answer]) => (
                <Panel key={id} title={id} extra={<Badge>{answer.type}</Badge>}>
                    {answer.type === "boolean" ? (
                        <>
                            <div className="jev-metric">
                                {percent(answer.probability)}{" "}
                                <span className="text-xs text-muted-foreground">probability of true</span>
                            </div>
                            <Meter
                                value={answer.probability}
                                max={1}
                                display={percent(answer.probability)}
                                tone="info"
                            />
                        </>
                    ) : (
                        <>
                            <div className="jev-metric">
                                {answer.type === "choice" ? answer.choice : answer.score.toFixed(3)}
                            </div>
                            {Object.entries(answer.probabilities ?? {}).map(([label, value]) => (
                                <Meter
                                    key={label}
                                    label={label}
                                    value={value}
                                    max={1}
                                    display={percent(value)}
                                    tone="info"
                                />
                            ))}
                        </>
                    )}
                </Panel>
            ))}
            <div className="flex flex-wrap gap-5 text-xs text-muted-foreground">
                <span>Input tokens: {result.usage.inputTokens ?? "n/a"}</span>
                <span>Output tokens: {result.usage.outputTokens ?? "n/a"}</span>
            </div>
            <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                    Full response and provider confidence
                </summary>
                <JsonView value={result} open={2} />
            </details>
            <Button
                variant="outline"
                size="sm"
                onClick={() => download({ filename: "jev-result.json", content: SafeJSON.stringify(result, null, 2) })}
            >
                <Download />
                Export result
            </Button>
        </div>
    );
}

function Playground({ advanced = false }: { advanced?: boolean }) {
    const [state, setState] = useState(DEFAULT_STATE);
    const [question, setQuestion] = useState("Was a refund issued?");
    const [type, setType] = useState("boolean");
    const [criteria, setCriteria] = useState(
        "billing: payment problems\nshipping: delivery problems\ntechnical: application bugs"
    );
    const [raw, setRaw] = useState(SafeJSON.stringify(DEFAULT_REQUEST, null, 2));
    const [zdr, setZdr] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<EvaluationResponse>();
    const [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const run = async () => {
        if (controller.current) {
            return;
        }
        const current = new AbortController();
        controller.current = current;
        setBusy(true);
        setError("");
        setResult(undefined);
        try {
            const options =
                type === "choice"
                    ? Object.fromEntries(
                          criteria
                              .split("\n")
                              .filter((line) => line.trim())
                              .map((line) => {
                                  const colon = line.indexOf(":");
                                  return colon < 0
                                      ? [line.trim(), line.trim()]
                                      : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
                              })
                      )
                    : type === "score"
                      ? criteria.split("\n").filter((line) => line.trim())
                      : undefined;
            const input: unknown = advanced
                ? SafeJSON.parse(raw)
                : {
                      state,
                      questions: {
                          answer: { type, instructions: question, ...(options ? { criteria: options } : {}) },
                      },
                  };
            setResult(
                await api<EvaluationResponse>({
                    route: "/evaluate",
                    body: { input, zeroDataRetention: zdr },
                    signal: current.signal,
                })
            );
        } catch (failure) {
            setError(current.signal.aborted ? "Evaluation stopped." : errorMessage(failure));
        } finally {
            controller.current = null;
            setBusy(false);
        }
    };
    return (
        <>
            <div className="jev-heading">
                <div>
                    <h1>{advanced ? "Ask several questions at once" : "Give context. Get a decision."}</h1>
                    <p className="jev-subtitle">
                        {advanced
                            ? "Mix boolean, choice, and score questions against the same state. Question IDs stay intact in the response."
                            : "Explore Jev's typed answers. It selects, scores, and estimates probabilities from the state you provide."}
                    </p>
                </div>
                <Badge>typesafe-ai/jev</Badge>
            </div>
            <div className="jev-columns">
                <Panel title={advanced ? "Request editor" : "Your question"}>
                    {advanced ? (
                        <>
                            <Field label="Request JSON / JSONC" id="request-json">
                                <Textarea
                                    id="request-json"
                                    className="jev-code min-h-[430px]"
                                    variant="default"
                                    value={raw}
                                    onChange={(e) => setRaw(e.target.value)}
                                    spellCheck={false}
                                    disabled={busy}
                                />
                            </Field>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => setRaw(SafeJSON.stringify(DEFAULT_REQUEST, null, 2))}
                            >
                                Load support triage example
                            </Button>
                        </>
                    ) : (
                        <>
                            <Field label="Question type" id="question-type">
                                <select
                                    className="jev-select"
                                    id="question-type"
                                    value={type}
                                    disabled={busy}
                                    onChange={(e) => {
                                        setType(e.target.value);
                                        if (e.target.value === "score") {
                                            setCriteria("poor\nfair\ngood\nexcellent");
                                            setQuestion("Rate the quality of this response.");
                                        } else if (e.target.value === "choice") {
                                            setCriteria(
                                                "billing: payment problems\nshipping: delivery problems\ntechnical: application bugs"
                                            );
                                            setQuestion("Which team should handle this ticket?");
                                        } else {
                                            setQuestion("Was a refund issued?");
                                        }
                                    }}
                                >
                                    <option value="boolean">Boolean · probability of true</option>
                                    <option value="choice">Choice · select an option</option>
                                    <option value="score">Score · rate an ordered scale</option>
                                </select>
                            </Field>
                            <Field label="State / context" id="evaluation-state">
                                <Textarea
                                    id="evaluation-state"
                                    variant="default"
                                    className="min-h-[150px]"
                                    value={state}
                                    onChange={(e) => setState(e.target.value)}
                                    disabled={busy}
                                />
                            </Field>
                            <Field label="Question" id="evaluation-question">
                                <Textarea
                                    id="evaluation-question"
                                    variant="default"
                                    value={question}
                                    onChange={(e) => setQuestion(e.target.value)}
                                    disabled={busy}
                                />
                            </Field>
                            {type !== "boolean" && (
                                <Field
                                    label={type === "choice" ? "Options" : "Scale, lowest to highest"}
                                    id="criteria"
                                    hint={
                                        type === "choice"
                                            ? "One option per line: key: description"
                                            : "One label per line. Scores start at 0."
                                    }
                                >
                                    <Textarea
                                        id="criteria"
                                        variant="default"
                                        className="jev-code min-h-[110px]"
                                        value={criteria}
                                        onChange={(e) => setCriteria(e.target.value)}
                                        disabled={busy}
                                    />
                                </Field>
                            )}
                        </>
                    )}
                    <Zdr checked={zdr} onChange={setZdr} disabled={busy} />
                    <div className="jev-actions">
                        <Button variant="nexus" disabled={busy} onClick={() => void run()}>
                            <Play />
                            {busy ? "Evaluating…" : "Evaluate"}
                        </Button>
                        {busy && (
                            <Button variant="outline" onClick={() => controller.current?.abort()}>
                                <Square />
                                Stop
                            </Button>
                        )}
                    </div>
                    <p className="jev-help">
                        Uses your saved gateway key. Each evaluation makes one paid model request.
                    </p>
                    <ErrorNotice message={error} />
                </Panel>
                <Answers result={result} />
            </div>
        </>
    );
}

function TypeScriptLab() {
    const [generation, setGeneration] = useState<"grammar" | "characters">("grammar");
    const [goal, setGoal] = useState(typescriptPresets[0].goal);
    const [literalText, setLiteralText] = useState("Hello, World!");
    const [stdin, setStdin] = useState("");
    const [maxSteps, setMaxSteps] = useState(80);
    const [zdr, setZdr] = useState(false);
    const [tokens, setTokens] = useState<string[]>([]);
    const [steps, setSteps] = useState<ExperimentStep[]>([]);
    const [compiled, setCompiled] = useState<CompileResult>();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("Ready. Step makes one decision; Run continues until finished.");
    const [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const literals = literalText
        .split("\n")
        .filter(Boolean)
        .map((line) => (line === "\\n" ? "\n" : line === "\\t" ? "\t" : line));
    const language = languages.get("typescript");
    const last = steps.at(-1)?.decision;
    const request = (): TypeScriptRequest => ({
        language: "typescript",
        mode: generation,
        goal,
        literals,
        stdin,
        tokens,
        maxSteps,
        zeroDataRetention: zdr,
    });
    const state = generationMode(generation).state(language, request());
    const reset = () => {
        setTokens([]);
        setSteps([]);
        setCompiled(undefined);
        setError("");
        setMessage("Ready. Step makes one decision; Run continues until finished.");
    };
    const selectPreset = (index: number) => {
        const preset = typescriptPresets[index];
        setGoal(preset.goal);
        setLiteralText(preset.literals.map((literal) => (literal === "\n" ? "\\n" : literal)).join("\n"));
        setStdin(preset.stdin);
        reset();
    };
    const execute = async (mode: "step" | "run" | "compile") => {
        if (controller.current) {
            return;
        }
        const current = new AbortController();
        controller.current = current;
        setBusy(true);
        setError("");
        setCompiled(undefined);
        let input = request();
        const signal = AbortSignal.any([current.signal, AbortSignal.timeout(300000)]);
        try {
            if (mode !== "compile") {
                do {
                    setMessage(`Jev is choosing token ${input.tokens.length + 1}…`);
                    const step = await api<ExperimentStep>({ route: "/experiment/step", body: input, signal });
                    input = { ...input, tokens: step.tokens };
                    setTokens(step.tokens);
                    setSteps((previous) => [...previous, step]);
                    if (step.complete || mode === "step") {
                        break;
                    }
                } while (input.tokens.length < maxSteps);
            }

            if (generationMode(input.mode).state(language, input).complete) {
                setMessage("Program complete. Compiling and running…");
                const output = await api<CompileResult>({ route: "/experiment/compile", body: input, signal });
                setCompiled(output);
                setMessage(
                    output.build.exitCode === 0
                        ? `Compiled. Program exited with code ${output.run?.exitCode}.`
                        : "Compilation failed. Inspect compiler output."
                );
            } else {
                setMessage(
                    input.tokens.length >= maxSteps
                        ? "Step limit reached. Increase max steps to continue."
                        : "Paused after one decision. Step again or run to continue."
                );
            }
        } catch (failure) {
            if (current.signal.aborted) {
                setMessage("Stopped. The current program and decisions are preserved.");
            } else {
                setError(errorMessage(failure));
                setMessage("Experiment paused after an error.");
            }
        } finally {
            controller.current = null;
            setBusy(false);
        }
    };
    return (
        <>
            <div className="jev-heading">
                <div>
                    <h1>TypeScript experiment lab</h1>
                    <p className="jev-subtitle">
                        Compare grammar-constrained tokens with experimental character choices. Watch each decision,
                        then type-check and run the result.
                    </p>
                </div>
                <Badge tone={state.complete ? "ok" : busy ? "warn" : "neutral"}>
                    {state.complete ? "Complete" : busy ? "Running" : tokens.length ? "Paused" : "Ready"}
                </Badge>
            </div>
            <div className="jev-lab">
                <Panel title="Experiment">
                    <Field label="Generation mode" id="generation-mode">
                        <select
                            className="jev-select"
                            id="generation-mode"
                            value={generation}
                            disabled={busy}
                            onChange={(event) => {
                                const value = event.target.value === "characters" ? "characters" : "grammar";
                                setGeneration(value);
                                setMaxSteps(value === "characters" ? 256 : 80);
                                reset();
                            }}
                        >
                            <option value="grammar">Constrained tokens</option>
                            <option value="characters">Free characters · experimental</option>
                        </select>
                    </Field>
                    {generation === "characters" && (
                        <Callout tone="info">
                            Jev chooses from a fixed character alphabet without a string vocabulary or grammar filter.
                            This is an experiment with a classifier, so it may produce invalid code. Checking and
                            execution use the macOS sandbox.
                        </Callout>
                    )}
                    <Field label="Starting point" id="typescript-preset">
                        <select
                            className="jev-select"
                            id="typescript-preset"
                            defaultValue="0"
                            disabled={busy}
                            onChange={(event) => selectPreset(Number(event.target.value))}
                        >
                            {typescriptPresets.map((preset, index) => (
                                <option key={preset.name} value={index}>
                                    {preset.name}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Goal" id="typescript-goal">
                        <Textarea
                            id="typescript-goal"
                            variant="default"
                            className="min-h-[130px]"
                            value={goal}
                            disabled={busy || tokens.length > 0}
                            onChange={(event) => setGoal(event.target.value)}
                        />
                    </Field>
                    {generation === "grammar" && (
                        <Field
                            label="String vocabulary"
                            id="typescript-literals"
                            hint="One string per line. Use \\n for a newline. Reset to change the goal or vocabulary."
                        >
                            <Textarea
                                id="typescript-literals"
                                variant="default"
                                className="jev-code"
                                value={literalText}
                                disabled={busy || tokens.length > 0}
                                onChange={(event) => setLiteralText(event.target.value)}
                            />
                        </Field>
                    )}
                    <Field label="Sample stdin" id="typescript-stdin">
                        <Textarea
                            id="typescript-stdin"
                            variant="default"
                            className="jev-code"
                            value={stdin}
                            disabled={busy}
                            onChange={(event) => setStdin(event.target.value)}
                            placeholder="Optional input for the compiled program"
                        />
                    </Field>
                    <Field
                        label="Max steps"
                        id="typescript-limit"
                        hint="One model request per token. Maximum 2048 steps; a run stops after five minutes."
                    >
                        <Input
                            id="typescript-limit"
                            type="number"
                            min={1}
                            max={2048}
                            value={maxSteps}
                            disabled={busy}
                            onChange={(event) => setMaxSteps(Number(event.target.value))}
                        />
                    </Field>
                    <Zdr checked={zdr} onChange={setZdr} disabled={busy} />
                    <div className="jev-actions">
                        <Button
                            variant="nexus"
                            disabled={busy || state.complete || tokens.length >= maxSteps}
                            onClick={() => void execute("run")}
                        >
                            <Play />
                            Run experiment
                        </Button>
                        <Button
                            variant="outline"
                            disabled={busy || state.complete || tokens.length >= maxSteps}
                            onClick={() => void execute("step")}
                        >
                            <StepForward />
                            Step
                        </Button>
                        {busy ? (
                            <Button variant="outline" onClick={() => controller.current?.abort()}>
                                <Square />
                                Stop
                            </Button>
                        ) : (
                            <Button variant="ghost" onClick={reset}>
                                <RotateCcw />
                                Reset
                            </Button>
                        )}
                    </div>
                </Panel>
                <div className="jev-stack">
                    <Panel title="Current file" extra={<span className="jev-help">main.ts</span>}>
                        <div className="flex justify-between gap-6">
                            <div>
                                <p className="jev-help">STEP</p>
                                <div className="jev-metric">
                                    {tokens.length}
                                    <span className="text-sm text-muted-foreground"> / {maxSteps}</span>
                                </div>
                            </div>
                            <div>
                                <p className="jev-help">DONE P</p>
                                <div className="jev-metric">{last ? percent(last.doneProbability) : "n/a"}</div>
                            </div>
                        </div>
                        <pre className="jev-source jev-code" aria-label="Generated TypeScript source">
                            {state.source || "// Your program will appear here, one token at a time."}
                        </pre>
                        <p role="status" className="text-xs text-muted-foreground">
                            {message}
                        </p>
                        <div className="jev-actions">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={!state.complete || busy}
                                onClick={() => void execute("compile")}
                            >
                                <Terminal />
                                Type-check & run
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={!tokens.length}
                                onClick={() =>
                                    download({ filename: "main.ts", content: state.source, type: "text/plain" })
                                }
                            >
                                <Download />
                                TypeScript
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={!tokens.length}
                                onClick={() =>
                                    download({
                                        filename: "jev-experiment.json",
                                        content: SafeJSON.stringify(request(), null, 2),
                                    })
                                }
                            >
                                Experiment JSON
                            </Button>
                        </div>
                        <ErrorNotice message={error} />
                    </Panel>
                    <Panel title="Type-check & stdout">
                        {compiled ? (
                            <>
                                <div className="jev-help">
                                    {compiled.compiler} · compile exit {compiled.build.exitCode}
                                    {compiled.build.timedOut ? " · timed out" : ""}
                                    {compiled.run
                                        ? ` · run exit ${compiled.run.exitCode}${compiled.run.timedOut ? " · timed out" : ""}`
                                        : ""}
                                </div>
                                {compiled.build.stdout && (
                                    <CodeBlock label="TypeScript diagnostics" wrap>
                                        {compiled.build.stdout}
                                    </CodeBlock>
                                )}
                                {compiled.build.stderr && (
                                    <CodeBlock label="Compiler diagnostics" wrap>
                                        {compiled.build.stderr}
                                    </CodeBlock>
                                )}
                                {compiled.run && (
                                    <CodeBlock label="stdout" wrap>
                                        {compiled.run.stdout || "(empty output)"}
                                    </CodeBlock>
                                )}
                                {compiled.run?.stderr && (
                                    <CodeBlock label="stderr" wrap>
                                        {compiled.run.stderr}
                                    </CodeBlock>
                                )}
                            </>
                        ) : (
                            <p className="jev-help">
                                Not compiled yet. A completed program compiles and runs automatically.
                            </p>
                        )}
                    </Panel>
                    <Panel title="Decision trace" extra={<Badge>{steps.length} decisions</Badge>}>
                        <div className="jev-trace">
                            <table className="jev-table">
                                <thead>
                                    <tr>
                                        <th>Step</th>
                                        <th>Token</th>
                                        <th>Probability</th>
                                        <th>Confidence</th>
                                        <th>Done P</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...steps].reverse().map(({ decision }) => (
                                        <tr key={decision.step}>
                                            <td>{decision.step}</td>
                                            <td className="jev-code">{tokenLabel(decision.token)}</td>
                                            <td>{percent(decision.probability)}</td>
                                            <td>{percent(decision.confidence)}</td>
                                            <td>{percent(decision.doneProbability)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {!steps.length && <p className="jev-help p-3">No decisions yet.</p>}
                        </div>
                        <p className="jev-help">
                            Done P estimates whether the goal is implemented before the selected token. It does not
                            prove correctness.
                        </p>
                    </Panel>
                </div>
                <div className="jev-stack">
                    <Panel
                        title={generation === "grammar" ? "Legal next tokens" : "Character alphabet"}
                        extra={<Badge>{state.candidates.length}</Badge>}
                    >
                        <p className="jev-help">Grammar slot: {state.slot}</p>
                        <div className="jev-chips max-h-48 overflow-auto">
                            {state.candidates.map((token) => (
                                <span className="jev-token" key={tokenLabel(token)}>
                                    {tokenLabel(token)}
                                </span>
                            ))}
                        </div>
                        {state.complete && <p className="text-sm text-primary">The program is closed.</p>}
                    </Panel>
                    <Panel title="Latest choice">
                        {last ? (
                            <>
                                <div className="jev-token text-primary">{tokenLabel(last.token)}</div>
                                {[...last.candidates]
                                    .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
                                    .slice(0, 12)
                                    .map((candidate) => (
                                        <Meter
                                            key={tokenLabel(candidate.token)}
                                            label={tokenLabel(candidate.token)}
                                            value={candidate.probability ?? 0}
                                            max={1}
                                            display={percent(candidate.probability)}
                                            tone={candidate.token === last.token ? "ok" : "neutral"}
                                        />
                                    ))}
                            </>
                        ) : (
                            <p className="jev-help">Run or step to inspect a token distribution.</p>
                        )}
                    </Panel>
                    <Panel title={generation === "grammar" ? "Grammar scope" : "Character mode"}>
                        {generation === "characters" ? (
                            <p className="jev-help">
                                Any printable ASCII character, tab, or newline can be chosen. No syntax rules or string
                                list are applied. TypeScript errors are shown after generation. The sandbox blocks
                                networking, process spawning, writes outside the run directory, and reads of unrelated
                                home and temporary files.
                            </p>
                        ) : (
                            <>
                                <p className="jev-help">
                                    Typed const/let declarations, numeric arithmetic, console.log, string literals, and
                                    numeric stdin parsed by Bun. No loops, imports, network calls, or arbitrary source
                                    input.
                                </p>
                                <p className="jev-help">
                                    Syntax is constrained. Whether the program meets your goal is still Jev's decision.
                                </p>
                            </>
                        )}
                    </Panel>
                </div>
            </div>
        </>
    );
}

interface GatewayStatus {
    configured: boolean;
    balance?: string;
    totalUsed?: string;
    error?: string;
}
export default function Dashboard() {
    const [tab, setTab] = useState(() => window.location.hash.slice(1) || "playground");
    const [status, setStatus] = useState<GatewayStatus>();
    const [refreshing, setRefreshing] = useState(false);
    const refresh = async () => {
        setRefreshing(true);
        try {
            setStatus(await api<GatewayStatus>({ route: "/status" }));
        } catch (error) {
            setStatus({ configured: false, error: errorMessage(error) });
        } finally {
            setRefreshing(false);
        }
    };
    useEffect(() => {
        document.documentElement.classList.add("cyberpunk");
        void refresh();
        const changed = () => {
            setTab(window.location.hash.slice(1) || "playground");
            window.scrollTo({ top: 0 });
        };
        window.addEventListener("hashchange", changed);
        return () => window.removeEventListener("hashchange", changed);
    }, []);
    return (
        <DashboardLayout
            title="JEV"
            titleAccent="LAB"
            icon={<FlaskConical size={17} />}
            navLinks={[
                { label: "Playground", href: "playground", icon: <CheckCheck size={15} /> },
                { label: "Request editor", href: "requests", icon: <Braces size={15} /> },
                { label: "TypeScript lab", href: "typescript", icon: <Code2 size={15} /> },
                { label: "Fly arena", href: "arena", icon: <Gamepad2 size={15} /> },
            ]}
            activePath={tab}
            onNavigate={(value) => {
                window.location.hash = value === "/" ? "playground" : value;
            }}
            rightSlot={
                <div className="flex items-center gap-2">
                    <span className="hidden sm:inline text-xs text-muted-foreground">
                        {status?.balance
                            ? `${Number(status.balance).toFixed(2)} credits`
                            : status?.configured
                              ? "Key loaded"
                              : "Local workbench"}
                    </span>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Refresh gateway status"
                        disabled={refreshing}
                        onClick={() => void refresh()}
                    >
                        <RefreshCw size={14} />
                    </Button>
                </div>
            }
        >
            <div className="jev-page">
                {status?.error && (
                    <div className="mb-6">
                        <ErrorNotice message={status.error} />
                    </div>
                )}
                {tab === "arena" ? (
                    <ArenaLab />
                ) : tab === "typescript" ? (
                    <TypeScriptLab />
                ) : (
                    <Playground key={tab} advanced={tab === "requests"} />
                )}
                <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t border-border pt-5 text-xs text-muted-foreground">
                    <span>Local Jev workbench · Powered by tools artifact</span>
                    <span>Credentials stay on this Mac. Requests go to Vercel AI Gateway.</span>
                </footer>
            </div>
        </DashboardLayout>
    );
}
