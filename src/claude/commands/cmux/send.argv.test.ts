import { afterAll, expect, spyOn, test } from "bun:test";
import { deliverToSession } from "@app/question/lib/decisions/deliver";
import { livePaneTargets } from "@app/question/lib/decisions/deliver.fixtures";
import { Command } from "commander";
import { registerCmuxCommand } from "./index";
import * as sendModule from "./send";

interface ParsedSend {
    query: string;
    text: string;
    opts: sendModule.SendOptions;
}

const parsed: ParsedSend[] = [];
const sendDoor = spyOn(sendModule, "sendDoor").mockImplementation(async (query, text, opts) => {
    parsed.push({ query, text, opts });
});

afterAll(() => {
    sendDoor.mockRestore();
});

const SESSION = "11111111-1111-4111-8111-111111111111";

/** `tools claude <args>` through the real `cmux send` registration, with only the pane typing replaced. */
async function parseThroughTheRealCli(args: string[]): Promise<ParsedSend> {
    const program = new Command("claude");
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerCmuxCommand(program);
    parsed.length = 0;
    await program.parseAsync(args.slice(1), { from: "user" });
    const [only] = parsed;

    if (!only) {
        throw new Error("the cmux send action did not run");
    }

    return only;
}

async function argsDeliverToSessionRuns(text: string): Promise<string[]> {
    const calls: string[][] = [];
    await deliverToSession(
        { session: SESSION, provider: "claude-code", text },
        {
            findTargets: livePaneTargets,
            runTool: async (args) => {
                calls.push(args);
                return { success: true, stderr: "", stdout: '{"sent":true}' };
            },
        }
    );

    const [only] = calls;

    if (!only) {
        throw new Error("deliverToSession ran no tool");
    }

    return only;
}

test.each(["- fix the typo", "-1 on option b", "--force it"])(
    "a widget follow-up %p reaches `claude cmux send` as the message text, not as an option",
    async (text) => {
        const result = await parseThroughTheRealCli(await argsDeliverToSessionRuns(text));

        expect(result.query).toBe(SESSION);
        expect(result.text).toBe(text);
        expect(result.opts).toMatchObject({ json: true, paste: true, exactSession: true });
    }
);

test("an ordinary message is parsed the same way (control)", async () => {
    const result = await parseThroughTheRealCli(await argsDeliverToSessionRuns("DECISION 1: a) yes"));

    expect(result.query).toBe(SESSION);
    expect(result.text).toBe("DECISION 1: a) yes");
    expect(result.opts).toMatchObject({ json: true, paste: true, exactSession: true });
});
