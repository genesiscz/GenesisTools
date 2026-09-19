import { SafeJSON } from "@genesiscz/utils/json";
import { type Expr, LanguageError, parse, type Statement, type Value } from "./language";

export interface Provider {
    write(prompt: string, value: Value | undefined, signal: AbortSignal): Promise<string>;
    judge(value: Value, labels: string[], signal: AbortSignal): Promise<Record<string, number>>;
}

export type Effect = { kind: "write" | "judge"; args: unknown; result: unknown; draw?: number };

export type Trace = {
    kind: "write" | "judge" | "print" | "assign" | "repeat";
    line: number;
    text: string;
    detail?: unknown;
};

export type Run = {
    version: 1;
    source: string;
    input: string;
    tape: Effect[];
    output: string[];
    trace: Trace[];
};

export type Options = {
    input?: string;
    replay?: Effect[];
    signal?: AbortSignal;
    onEvent?: (event: Trace) => void;
    random?: () => number;
};

export function distribution(raw: unknown, labels: string[]): Record<string, number> {
    if (!raw || typeof raw !== "object") {
        throw new Error("Judge returned no probabilities.");
    }

    const obj = raw as Record<string, unknown>;
    let sum = 0;

    for (const key of labels) {
        const n = obj[key];

        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) {
            throw new Error("Judge returned invalid probabilities.");
        }

        sum += n;
    }

    if (Math.abs(sum - 1) > 0.02) {
        throw new Error("Judge probabilities do not sum to one.");
    }

    return Object.fromEntries(labels.map((label) => [label, (obj[label] as number) / sum]));
}

export async function run(source: string, provider: Provider, options: Options = {}): Promise<Run> {
    const ast = parse(source);
    const input = options.input || "";

    if (input.length > 6000) {
        throw new Error("Input exceeds 6,000 characters.");
    }

    const scopes: Array<Map<string, Value>> = [new Map()];
    const tape: Effect[] = [];
    const output: string[] = [];
    const trace: Trace[] = [];
    let steps = 0;
    let calls = 0;
    let cursor = 0;
    const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)])
        : AbortSignal.timeout(90000);
    const emit = (e: Trace) => {
        trace.push(e);
        options.onEvent?.(e);
    };
    const scopeOf = (name: string) => scopes.find((s) => s.has(name));
    const effect = async (
        kind: Effect["kind"],
        args: unknown,
        call: () => Promise<unknown>,
        chaos = false
    ): Promise<Effect> => {
        signal.throwIfAborted();

        if (++calls > 12) {
            throw new Error("Run stopped at the 12 model-call limit.");
        }

        let e: Effect;

        if (options.replay) {
            const saved = options.replay[cursor++];

            if (!saved || saved.kind !== kind || SafeJSON.stringify(saved.args) !== SafeJSON.stringify(args)) {
                throw new Error("Replay does not match this program and input.");
            }

            e = structuredClone(saved);
        } else {
            e = {
                kind,
                args,
                result: await call(),
                ...(chaos ? { draw: (options.random || Math.random)() } : {}),
            };
        }

        if (chaos && (typeof e.draw !== "number" || e.draw < 0 || e.draw >= 1)) {
            throw new Error("Invalid chaos draw in replay.");
        }

        tape.push(e);
        return e;
    };
    const evalExpr = async (e: Expr, line: number): Promise<Value> => {
        if (e.kind === "literal") {
            return e.value;
        }

        if (e.kind === "input") {
            return input;
        }

        if (e.kind === "variable") {
            const scope = scopeOf(e.name);

            if (!scope) {
                throw new LanguageError(`Unknown variable ${e.name}.`, line);
            }

            return scope.get(e.name)!;
        }

        const value = e.using ? await evalExpr(e.using, line) : undefined;
        const args = { prompt: e.prompt, ...(value === undefined ? {} : { value }) };
        const record = await effect("write", args, () => provider.write(e.prompt, value, signal));

        if (typeof record.result !== "string" || record.result.length > 12000) {
            throw new Error("Writer returned invalid or oversized text.");
        }

        emit({ kind: "write", line, text: record.result, detail: args });
        return record.result;
    };
    const choose = async (value: Value, labels: string[], line: number, chaos: boolean, threshold = 0.5) => {
        const record = await effect("judge", { value, labels }, () => provider.judge(value, labels, signal), chaos);
        const probabilities = distribution(record.result, labels);
        let chosen = labels.reduce(
            (best, label) => (probabilities[label] > probabilities[best] ? label : best),
            labels[0]
        );
        const uncertain = probabilities[chosen] < threshold;

        if (chaos && !uncertain) {
            let remaining = record.draw!;
            chosen = labels[labels.length - 1];

            for (const label of labels) {
                remaining -= probabilities[label];

                if (remaining < 0) {
                    chosen = label;
                    break;
                }
            }
        }

        emit({
            kind: "judge",
            line,
            text: uncertain
                ? "Uncertain → otherwise maybe"
                : `${chosen} → ${Math.round(probabilities[chosen] * 100)}%${chaos ? " · sampled" : " · highest probability"}`,
            detail: {
                value,
                probabilities,
                chosen: uncertain ? null : chosen,
                threshold,
                ...(chaos ? { draw: record.draw } : {}),
            },
        });
        return uncertain ? null : chosen;
    };
    const execute = async (body: Statement[], chaos = false, nested = false): Promise<void> => {
        if (nested) {
            scopes.unshift(new Map());
        }

        try {
            for (const s of body) {
                signal.throwIfAborted();

                if (++steps > 200) {
                    throw new Error("Run stopped at the 200 statement limit.");
                }

                switch (s.kind) {
                    case "let":
                    case "set": {
                        const scope = s.kind === "let" ? scopes[0] : scopeOf(s.name);

                        if (!scope) {
                            throw new LanguageError(`Unknown variable ${s.name}. Use let first.`, s.line);
                        }

                        if (s.kind === "let" && scope.has(s.name)) {
                            throw new LanguageError(`${s.name} is already declared in this block.`, s.line);
                        }

                        const value = await evalExpr(s.value, s.line);
                        scope.set(s.name, value);
                        emit({ kind: "assign", line: s.line, text: s.name, detail: { value } });
                        break;
                    }
                    case "print": {
                        const value = String(await evalExpr(s.value, s.line));
                        output.push(value);
                        emit({ kind: "print", line: s.line, text: value });
                        break;
                    }
                    case "if": {
                        const value = await evalExpr(s.value, s.line);
                        const yes = s.question;
                        const no = `NOT: ${s.question}`;
                        const selected = await choose(value, [yes, no], s.line, chaos, s.confidence);
                        await execute(selected === null ? s.maybe : selected === yes ? s.yes : s.no, chaos, true);
                        break;
                    }
                    case "match": {
                        const selected = await choose(
                            await evalExpr(s.value, s.line),
                            s.branches.map((b) => b.label),
                            s.line,
                            chaos,
                            0
                        );
                        await execute(s.branches.find((b) => b.label === selected)!.body, chaos, true);
                        break;
                    }
                    case "while": {
                        let i = 0;

                        while (true) {
                            const selected = await choose(
                                await evalExpr(s.value, s.line),
                                [s.question, `NOT: ${s.question}`],
                                s.line,
                                chaos
                            );

                            if (selected !== s.question) {
                                break;
                            }

                            if (i === 5) {
                                throw new LanguageError(
                                    "Loop still feels true after 5 iterations. Try a different rewrite instruction.",
                                    s.line
                                );
                            }

                            emit({ kind: "repeat", line: s.line, text: `Iteration ${++i} of at most 5` });
                            await execute(s.body, chaos, true);
                        }

                        break;
                    }
                    case "repeat":
                        for (let i = 0; i < s.count; i++) {
                            emit({ kind: "repeat", line: s.line, text: `Iteration ${i + 1} of ${s.count}` });
                            await execute(s.body, chaos, true);
                        }

                        break;
                    case "chaos":
                        await execute(s.body, true, true);
                        break;
                }
            }
        } finally {
            if (nested) {
                scopes.shift();
            }
        }
    };

    await execute(ast);

    if (options.replay && cursor !== options.replay.length) {
        throw new Error("Replay has unused model results.");
    }

    return { version: 1, source, input, tape, output, trace };
}
