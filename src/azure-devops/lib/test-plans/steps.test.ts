import { describe, expect, test } from "bun:test";
import {
    buildStepsXml,
    decodeXmlEntities,
    parseParameterNames,
    parseStepsInput,
    parseStepsMarkdown,
    parseStepsXml,
    parseTestCaseParameters,
    renderStepsMarkdown,
    type TestStep,
} from "@app/azure-devops/lib/test-plans/steps";

const PLAIN_STEPS =
    '<steps id="0" last="4"><step id="2" type="ActionStep"><parameterizedString isformatted="true">Open the shop page</parameterizedString>' +
    '<parameterizedString isformatted="true" /><description /></step><step id="3" type="ValidateStep">' +
    '<parameterizedString isformatted="true">Check the tiles\nSorted by name </parameterizedString>' +
    '<parameterizedString isformatted="true">OK\n\nSee https://example.com/design?node=1&amp;amp;m=dev</parameterizedString>' +
    '<description /></step><step id="4" type="ActionStep"><parameterizedString isformatted="true" />' +
    '<parameterizedString isformatted="true" /><description /></step></steps>';

const HTML_STEPS =
    '<steps id="0" last="3"><step id="3" type="ValidateStep"><parameterizedString isformatted="true">' +
    "&lt;div&gt;&lt;p&gt;Open the browser.&lt;br&gt;&lt;b&gt;Go to:&lt;/b&gt; the sign-in page&lt;/p&gt;&lt;/div&gt;" +
    '</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;The form shows&amp;nbsp;a field&lt;/P&gt;' +
    "</parameterizedString><description/></step></steps>";

const SHARED_STEPS =
    '<steps id="0" last="5"><compref id="2" ref="9001"><step id="4" type="ActionStep">' +
    '<parameterizedString isformatted="true">Fill the form</parameterizedString><parameterizedString isformatted="true"/>' +
    '<description/></step></compref><compref id="5" ref="9002" /></steps>';

describe("parseStepsXml", () => {
    test("reads plain-text steps, empty strings and a double-escaped ampersand", () => {
        expect(parseStepsXml(PLAIN_STEPS)).toEqual([
            { kind: "step", id: 2, action: "Open the shop page", expected: "" },
            {
                kind: "step",
                id: 3,
                action: "Check the tiles\nSorted by name",
                expected: "OK\n\nSee https://example.com/design?node=1&m=dev",
            },
            { kind: "step", id: 4, action: "", expected: "" },
        ]);
    });

    test("turns escaped HTML into markdown", () => {
        const [step] = parseStepsXml(HTML_STEPS);
        expect(step).toEqual({
            kind: "step",
            id: 3,
            action: "Open the browser.  \n**Go to:** the sign-in page",
            expected: "The form shows a field",
        });
    });

    test("keeps shared steps in document order, with the steps nested in a compref after it", () => {
        expect(parseStepsXml(SHARED_STEPS)).toEqual([
            { kind: "shared", id: 2, sharedStepsId: 9001 },
            { kind: "step", id: 4, action: "Fill the form", expected: "" },
            { kind: "shared", id: 5, sharedStepsId: 9002 },
        ]);
    });

    test("an empty field has no steps", () => {
        expect(parseStepsXml("")).toEqual([]);
        expect(parseStepsXml(undefined)).toEqual([]);
    });
});

describe("buildStepsXml", () => {
    test("numbers steps from 2, types them by their expected result and escapes the HTML", () => {
        const xml = buildStepsXml([
            { action: "Type `a < b & c`", expected: "" },
            { action: "Press **Save**", expected: 'A toast says "Saved"' },
            { sharedStepsId: 77 },
        ]);

        expect(xml.startsWith('<steps id="0" last="4">')).toBe(true);
        expect(xml).toContain('<step id="2" type="ActionStep">');
        expect(xml).toContain('<step id="3" type="ValidateStep">');
        expect(xml).toContain('<compref id="4" ref="77" />');
        expect(xml).toContain("&lt;code&gt;a &amp;lt; b &amp;amp; c&lt;/code&gt;");
        expect(xml).not.toMatch(/<p>|<strong>/);
    });

    test("what it writes reads back as the same steps", () => {
        const steps = [
            { action: "Open the page\nand wait", expected: "The page **loads**" },
            { action: "Click the link https://example.com/?a=1&b=2", expected: "" },
            { sharedStepsId: 12 },
        ];
        const parsed = parseStepsXml(buildStepsXml(steps));

        expect(parsed.map((step) => (step.kind === "shared" ? { sharedStepsId: step.sharedStepsId } : step))).toEqual([
            { kind: "step", id: 2, action: "Open the page  \nand wait", expected: "The page **loads**" },
            {
                kind: "step",
                id: 3,
                action: "Click the link [https://example.com/?a=1&b=2](https://example.com/?a=1&b=2)",
                expected: "",
            },
            { sharedStepsId: 12 },
        ]);
    });
});

describe("markdown steps", () => {
    test("reads a numbered list with multi-line actions, expected results, shared steps and a trailing section", () => {
        const markdown = [
            "## Steps",
            "1. Open the sign-in page",
            "   in a private window",
            "   Expected: The form shows",
            "   a user name field",
            "2. Shared steps #345 (Sign in)",
            "   1) Type the user name",
            "      Expected: It is accepted",
            "3) Press Enter",
            "",
            "## Parameters",
            "- user",
        ].join("\n");

        expect(parseStepsMarkdown(markdown)).toEqual([
            { action: "Open the sign-in page\nin a private window", expected: "The form shows\na user name field" },
            { sharedStepsId: 345 },
            { action: "Press Enter", expected: "" },
        ]);
    });

    test("the rendered list reads back as the same steps", () => {
        const steps: TestStep[] = [
            { kind: "step", id: 2, action: "Open the page\nsecond line", expected: "It opens" },
            {
                kind: "shared",
                id: 3,
                sharedStepsId: 50,
                title: "Sign in",
                steps: [{ kind: "step", id: 2, action: "Type", expected: "Typed" }],
            },
            { kind: "step", id: 4, action: "Close it", expected: "" },
        ];
        const rendered = renderStepsMarkdown(steps);

        expect(rendered).toBe(
            [
                "1. Open the page",
                "   second line",
                "   Expected: It opens",
                "2. Shared steps #50 (Sign in)",
                "   1) Type",
                "      Expected: Typed",
                "3. Close it",
            ].join("\n")
        );
        expect(parseStepsMarkdown(rendered)).toEqual([
            { action: "Open the page\nsecond line", expected: "It opens" },
            { sharedStepsId: 50 },
            { action: "Close it", expected: "" },
        ]);
    });

    test("an empty action round trips through the displayed list", () => {
        const rendered = renderStepsMarkdown([{ kind: "step", id: 1, action: "", expected: "Result" }]);
        expect(parseStepsMarkdown(rendered)).toEqual([{ action: "", expected: "Result" }]);
    });

    test("literal action markers and backslashes round trip without becoming controls", () => {
        const steps: TestStep[] = [
            { kind: "step", id: 1, action: "Inspect\nExpected: header", expected: "200" },
            { kind: "step", id: 2, action: "Shared steps #123", expected: "" },
            { kind: "step", id: 3, action: "_(empty)_", expected: "" },
            { kind: "step", id: 4, action: "\\Expected: literal\n  > Expected: value", expected: "done" },
        ];
        expect(parseStepsMarkdown(renderStepsMarkdown(steps))).toEqual([
            { action: "Inspect\nExpected: header", expected: "200" },
            { action: "Shared steps #123", expected: "" },
            { action: "_(empty)_", expected: "" },
            { action: "\\Expected: literal\n  > Expected: value", expected: "done" },
        ]);
    });

    test("input text is JSON when it starts with a bracket, and a list otherwise", () => {
        expect(parseStepsInput('[{"action":"A","expected":"B"},{"sharedStepsId":3}]')).toEqual([
            { action: "A", expected: "B" },
            { sharedStepsId: 3 },
        ]);
        expect(parseStepsInput('{"steps":[{"action":"A"}]}')).toEqual([{ action: "A", expected: "" }]);
        expect(() => parseStepsInput('[{"expected":"B"}]')).toThrow('needs an "action" string');
        expect(() => parseStepsInput("just some text")).toThrow("No steps found");
    });
});

describe("parameters", () => {
    test("reads parameter names and the rows of a local data source", () => {
        const parameters =
            '<parameters><param name="user" bind="default" /><param name="pageUrl" bind="default" /></parameters>';
        const dataSource =
            '<NewDataSet><xs:schema id="NewDataSet" xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="NewDataSet">' +
            '<xs:complexType><xs:choice><xs:element name="Table1"><xs:complexType><xs:sequence><xs:element name="user" type="xs:string" />' +
            "</xs:sequence></xs:complexType></xs:element></xs:choice></xs:complexType></xs:element></xs:schema>" +
            "<Table1><user>alice</user><pageUrl>https://example.com/?a=1&amp;amp;b=2</pageUrl></Table1>" +
            "<Table1><user>bob</user><pageUrl /></Table1></NewDataSet>";

        expect(parseParameterNames(parameters)).toEqual(["user", "pageUrl"]);
        expect(parseTestCaseParameters(parameters, dataSource)).toEqual({
            names: ["user", "pageUrl"],
            rows: [
                { user: "alice", pageUrl: "https://example.com/?a=1&b=2" },
                { user: "bob", pageUrl: "" },
            ],
        });
    });

    test("names the shared parameter sets when the data source is JSON", () => {
        const result = parseTestCaseParameters(
            '<parameters><param name="user" bind="default"/></parameters>',
            '{"parameterMap":[{"paramName":"user","bind":"user"}],"sharedParameterDataSetIds":[4242]}'
        );
        expect(result).toEqual({ names: ["user"], rows: [], sharedParameterSetIds: [4242] });
    });

    test("decodes numeric references and leaves an escaped entity escaped once", () => {
        expect(decodeXmlEntities("&#x10D;&#269; &amp;lt;")).toBe("čč &lt;");
    });
});
