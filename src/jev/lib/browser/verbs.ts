export const BROWSER_VERBS = [
    "click",
    "fill",
    "select",
    "scroll_down",
    "scroll_up",
    "back",
    "reload",
    "navigate",
    "wait",
] as const;
export type BrowserVerb = (typeof BROWSER_VERBS)[number];

export const VERB_DESCRIPTIONS: Record<BrowserVerb, string> = {
    click: "Activate the chosen page element.",
    fill: "Write a user-supplied value into the chosen field.",
    select: "Choose an option in the chosen list.",
    scroll_down: "Scroll the page down by most of a viewport.",
    scroll_up: "Scroll the page up by most of a viewport.",
    back: "Go back one entry in the page history.",
    reload: "Reload the current page.",
    navigate: "Open the same-origin URL the caller supplied.",
    wait: "Wait for the page to settle, then observe again.",
};
