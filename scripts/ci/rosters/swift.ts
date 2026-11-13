/**
 * Swift rosters. ast-grep has no Swift grammar, so a Swift roster is a regex per line, on source whose comments are
 * hidden. Six of the ten read what a string literal says (`"GENESIS_TOOLS_HOME"`, `"--review"`), so `strings: true`
 * keeps string text; the others run on code alone, strings hidden too. A line counts once, as `checkSwiftSource`
 * reports. Test targets are left out. The manifest and its rule are the pattern rosters' (`rosters.json`).
 *
 * The patterns come from the Swift half of the architecture plan (candidates C04, C25, C46, C52) and from owners the
 * app already has (the two socket clients, `GenesisToolsHome`, `PathOpener`, `Clipboard`).
 */
export interface SwiftRoster {
    name: string;
    candidate: string;
    message: string;
    pattern: RegExp;
    /** The pattern reads string literal text. Comments are hidden either way. */
    strings?: boolean;
    onlyIn?: RegExp;
    /** The owner: never a finding. */
    allowedIn?: RegExp;
}

const file = (...names: string[]) => new RegExp(`(?:^|/)(?:${names.join("|")})\\.swift$`);

export const SWIFT_ROSTERS: readonly SwiftRoster[] = [
    {
        name: "roster-swift-tools-server-client-outside-bridge",
        candidate: "C04",
        message:
            "Reach the tools server through ToolsBridge. A ToolsServerClient built elsewhere picks the resident " +
            "server without the sandbox guard.",
        pattern: /\bToolsServerClient\(/,
        allowedIn: file("ToolsServerClient", "ToolsBridge"),
    },
    {
        name: "roster-swift-cli-runner-type-outside-bridge",
        candidate: "C04",
        message: "ToolsBridge is the one runner of the tools CLI. Do not declare another *CLIRunner type.",
        pattern: /\b(?:enum|struct|class|actor)\s+\w*CLIRunner\b/,
        allowedIn: file("ToolsBridge"),
    },
    {
        name: "roster-swift-forge-kind-compare-outside-forge",
        candidate: "C25",
        message:
            'Do not compare a forge kind with "gitlab" or "github" by hand. `Forge` (ForgeBadge.swift) has ' +
            "`init?(kind:)`, `label(_:)`, `noun` and `name`.",
        pattern: /[!=]=\s*"(?:gitlab|github)"|"(?:gitlab|github)"\s*[!=]=/,
        strings: true,
        allowedIn: file("ForgeBadge"),
    },
    {
        name: "roster-swift-review-argv-outside-review-launch",
        candidate: "C46",
        message:
            'An argv that starts with "--review" is written by ReviewLaunch, which also reads it. A hand-built one ' +
            "drifts from the decoder.",
        pattern: /\[\s*"--review"\s*,/,
        strings: true,
        allowedIn: file("ReviewWindow", "ReviewLaunch"),
    },
    {
        name: "roster-swift-inline-page-script",
        candidate: "C52",
        message:
            "A page's script and style are files under the webview resources, loaded by `<script src=…>`. Do not " +
            "put an inline <script> or <style> into a Swift string.",
        pattern: /<script(?:\s+(?:type|nonce|id)=[^>]*)?>|<style(?:\s+[a-z-]+=[^>]*)?>/,
        strings: true,
    },
    {
        name: "roster-swift-unix-socket-outside-rpc-clients",
        candidate: "D16",
        message:
            "A UNIX socket is opened by JSONRPCSocketClient or ToolsServerClient. A third client repeats the " +
            "framing and the sandbox-home rule.",
        pattern: /\bsocket\(\s*(?:AF|PF)_UNIX\b/,
        allowedIn: file("JSONRPCSocketClient", "ToolsServerClient"),
    },
    {
        name: "roster-swift-hand-built-genesis-tools-path",
        candidate: "D16",
        message:
            "Build a path into the GenesisTools home from `GenesisToolsHome`, never from a `.genesis-tools/` " +
            "string: GENESIS_TOOLS_HOME moves the folder.",
        // `appendingPathComponent(".genesis-tools…` is the older rule `swift-hand-joined-genesis-tools`: one finding each.
        pattern: /(?:\\\([^)]*\)\/|(?<!appendingPathComponent\()")\.genesis-tools\//,
        strings: true,
        allowedIn: file("GenesisToolsHome"),
    },
    {
        name: "roster-swift-genesis-tools-home-name-outside-owner",
        candidate: "D16",
        message:
            "Read the home through `GenesisToolsHome` (`GenesisToolsHome.variable` is the name). Do not spell " +
            '"GENESIS_TOOLS_HOME" again.',
        pattern: /"GENESIS_TOOLS_HOME"/,
        strings: true,
        allowedIn: file("GenesisToolsHome", "ToolsBridge"),
    },
    {
        name: "roster-swift-reveal-in-finder-outside-path-opener",
        candidate: "D16",
        message: "Reveal a file in Finder through PathOpener. Views never call NSWorkspace for this.",
        pattern: /\bNSWorkspace\.shared\.activateFileViewerSelecting\(/,
        allowedIn: file("PathOpener"),
    },
    {
        name: "roster-swift-pasteboard-copy-outside-clipboard",
        candidate: "D16",
        message: "Copy text through `Clipboard.copy(_:what:)`, which also tells the person what was copied.",
        pattern: /\bNSPasteboard\.general\.setString\(/,
        allowedIn: file("Clipboard"),
    },
];

/** Test targets hold fixtures that spell these patterns on purpose. */
const SWIFT_TESTS = /(?:^|\/)Tests\//;

export function swiftRosterApplies(roster: SwiftRoster, path: string): boolean {
    return (
        path.endsWith(".swift") &&
        !SWIFT_TESTS.test(path) &&
        (roster.onlyIn?.test(path) ?? true) &&
        !(roster.allowedIn?.test(path) ?? false)
    );
}

/**
 * The 1-based lines of one file that hold the pattern. `code` is the source with comments and strings hidden,
 * `withStrings` the source with only comments hidden; both keep every line and column where it was.
 */
export function swiftRosterLines(
    roster: SwiftRoster,
    masks: { code: readonly string[]; withStrings: readonly string[] },
    isSuppressed: (line: number) => boolean
): Array<{ line: number; column: number }> {
    const lines = roster.strings ? masks.withStrings : masks.code;
    const found: Array<{ line: number; column: number }> = [];

    for (const [index, text] of lines.entries()) {
        const column = text.search(roster.pattern);

        if (column !== -1 && !isSuppressed(index + 1)) {
            found.push({ line: index + 1, column: column + 1 });
        }
    }

    return found;
}
