import { expect, test } from "bun:test";
import { isClickableRole, isFillableRole, parsePageSnapshot, snapshotPage } from "./page-snapshot";

/** Recorded from chrome-devtools-mcp 1.6 `take_snapshot` against a local fixture page. */
const FIXTURE_SNAPSHOT = `## Latest page snapshot
uid=1_0 RootWebArea "Jev fixture page" url="http://127.0.0.1:3990/"
  uid=1_1 heading "Jev fixture" level="1"
  uid=1_2 StaticText "idle"
  uid=1_3 link "Learn more" url="http://127.0.0.1:3990/second"
    uid=1_4 StaticText "Learn more"
  uid=1_5 button "Export report"
  uid=1_6 form
    uid=1_7 StaticText "Name"
    uid=1_8 textbox "Name"
    uid=1_9 button "Submit"
`;

/** Recorded from the same server against an invented sign-in page. */
const LOGIN_SNAPSHOT = `## Latest page snapshot
uid=2_0 RootWebArea "Login fixture" url="https://example.test/login"
  uid=2_1 heading "Sign in" level="1"
  uid=2_2 form
    uid=2_3 StaticText "Email"
    uid=2_4 textbox "Email"
    uid=2_5 StaticText "Password"
    uid=2_6 textbox "Password"
    uid=2_7 combobox expandable haspopup="menu" value="Basic"
      uid=2_8 option "Basic" selectable selected value="Basic"
      uid=2_9 option "Pro" selectable value="Pro"
    uid=2_10 button "Sign in"
    uid=2_11 button "Disabled" disableable disabled
`;

/** `take_snapshot { verbose: true }` wraps the tree in `ignored` container nodes. */
const VERBOSE_SNAPSHOT = `## Latest page snapshot
uid=3_0 RootWebArea "Example Domain" url="https://example.test/"
  uid=3_1 ignored
    uid=3_2 ignored
      uid=3_4 heading "Example Domain" level="1"
        uid=3_5 StaticText "Example Domain"
      uid=3_9 link "Learn more" url="https://example.test/more"
`;

test("reads uid, role, name, depth and attributes from a recorded snapshot", () => {
    const nodes = parsePageSnapshot(FIXTURE_SNAPSHOT);
    expect(nodes.map((node) => node.uid)).toEqual([
        "1_0",
        "1_1",
        "1_2",
        "1_3",
        "1_4",
        "1_5",
        "1_6",
        "1_7",
        "1_8",
        "1_9",
    ]);
    expect(nodes[3]).toEqual({
        uid: "1_3",
        role: "link",
        name: "Learn more",
        depth: 1,
        href: "http://127.0.0.1:3990/second",
    });
    expect(nodes[5]).toEqual({ uid: "1_5", role: "button", name: "Export report", depth: 1 });
    expect(nodes[6]).toEqual({ uid: "1_6", role: "form", name: "", depth: 1 });
    expect(nodes[8]).toEqual({ uid: "1_8", role: "textbox", name: "Name", depth: 2 });
    expect(snapshotPage(nodes)).toEqual({ url: "http://127.0.0.1:3990/", title: "Jev fixture page" });
});

test("never reads the MCP wrapper heading as a node", () => {
    for (const text of [FIXTURE_SNAPSHOT, LOGIN_SNAPSHOT, VERBOSE_SNAPSHOT]) {
        const nodes = parsePageSnapshot(text);
        expect(nodes.some((node) => node.name.includes("page snapshot"))).toBe(false);
        expect(nodes.some((node) => node.role.startsWith("#"))).toBe(false);
    }
    expect(parsePageSnapshot("## Latest page snapshot\n## Page content\n")).toEqual([]);
});

test("marks password fields, disabled nodes and combobox values", () => {
    const nodes = parsePageSnapshot(LOGIN_SNAPSHOT);
    const byUid = new Map(nodes.map((node) => [node.uid, node]));
    expect(byUid.get("2_6")?.password).toBe(true);
    expect(byUid.get("2_4")?.password).toBeUndefined();
    expect(byUid.get("2_11")?.disabled).toBe(true);
    expect(byUid.get("2_10")?.disabled).toBeUndefined();
    expect(byUid.get("2_7")).toEqual({ uid: "2_7", role: "combobox", name: "", depth: 2, value: "Basic" });
    expect(byUid.get("2_9")).toEqual({ uid: "2_9", role: "option", name: "Pro", depth: 3, value: "Pro" });
});

test("keeps the verbose ignored wrappers as nodes and still finds the real rows", () => {
    const nodes = parsePageSnapshot(VERBOSE_SNAPSHOT);
    expect(nodes.filter((node) => node.role === "ignored")).toHaveLength(2);
    const link = nodes.find((node) => node.role === "link");
    expect(link).toEqual({ uid: "3_9", role: "link", name: "Learn more", depth: 3, href: "https://example.test/more" });
});

test("parses the JSON branch and an explicit password type", () => {
    const nodes = parsePageSnapshot(
        `[{"uid":"a","role":"button","name":"Go"},{"uid":"b","role":"textbox","name":"Secret","type":"password"},{"role":"link"}]`
    );
    expect(nodes).toEqual([
        { uid: "a", role: "button", name: "Go", depth: 0 },
        { uid: "b", role: "textbox", name: "Secret", depth: 0, password: true },
    ]);
});

test("rejects empty snapshots and classifies roles", () => {
    expect(parsePageSnapshot("")).toEqual([]);
    expect(parsePageSnapshot("   \n\n")).toEqual([]);
    expect(isClickableRole("button")).toBe(true);
    expect(isClickableRole("StaticText")).toBe(false);
    expect(isFillableRole("textbox")).toBe(true);
    expect(isFillableRole("Combobox")).toBe(true);
    expect(isFillableRole("form")).toBe(false);
});
