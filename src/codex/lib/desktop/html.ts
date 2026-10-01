const START = "<!-- genesis-tools-desktop-patch -->";
const END = "<!-- /genesis-tools-desktop-patch -->";
const SCRIPT_ANCHOR = '<script type="module" crossorigin';
const ROOT_ANCHOR = "#root {";

const BLOCK = `${START}
    <link rel="stylesheet" href="./genesis-tools-desktop.css">
    <script src="./genesis-tools-desktop.js"></script>
    ${END}`;

/** Insert the shared patch stylesheet and script in front of the webview module script. */
export function injectDesktopPatchLinks(html: string): string {
    if (!html.includes(ROOT_ANCHOR) || !html.includes(SCRIPT_ANCHOR)) {
        throw new Error("This Codex build has an unknown webview layout; no patch was applied.");
    }

    if (html.includes(START)) {
        const pattern = /<!-- genesis-tools-desktop-patch -->[\s\S]*?<!-- \/genesis-tools-desktop-patch -->/;
        if (!pattern.test(html)) {
            throw new Error("desktop patch start marker has no end marker");
        }

        return html.replace(pattern, BLOCK);
    }

    return html.replace(SCRIPT_ANCHOR, `${BLOCK}\n    ${SCRIPT_ANCHOR}`);
}
