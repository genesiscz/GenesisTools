import type { ListenCandidate } from "./verbs";

/**
 * Narrowing rows. They act on nothing: choosing one restricts what the NEXT utterance may choose
 * between, which is how an ambiguous ask becomes a short exchange instead of a refusal. Every
 * filter is a property of the observed rows, so a narrowed set is still only things that are
 * really on screen.
 */
export const NARROW_KINDS = ["buttons", "links", "fields", "menus", "apps", "all"] as const;
export type NarrowKind = (typeof NARROW_KINDS)[number];

const DESCRIPTIONS: Record<NarrowKind, string> = {
    buttons: "show only the buttons",
    links: "show only the links",
    fields: "show only the text fields",
    menus: "show only the menu items",
    apps: "show only the apps to switch to",
    all: "show everything again",
};

/**
 * Below this many candidates a screen is not ambiguous enough to be worth narrowing, and the rows
 * would only be five more things to choose wrongly between. A narrowing already in force always
 * offers its way out, whatever the count.
 */
export const NARROW_MIN_CANDIDATES = 25;

export function narrowCandidates(active: NarrowKind | null, offered: number, at?: number): ListenCandidate[] {
    if (active === null && offered < (at ?? NARROW_MIN_CANDIDATES)) {
        return [];
    }

    return NARROW_KINDS.filter((kind) => (kind === "all" ? active !== null : kind !== active)).map((kind) => ({
        id: `narrow:${kind}`,
        label: DESCRIPTIONS[kind],
        action: "narrow" as const,
        element: -1,
        narrow: kind,
    }));
}

const BUTTON_ROLES = /button|AXButton|AXPopUpButton|AXMenuButton|AXRadioButton|AXCheckBox|switch|tab/i;
const LINK_ROLES = /link|AXLink/i;
const FIELD_ROLES = /textbox|searchbox|combobox|textarea|AXTextField|AXTextArea|AXComboBox/i;

/**
 * Apply the active narrowing. A row whose role is unknown is kept, because dropping it would hide
 * a real target on the basis of a missing attribute; the point is to shorten the list, not to
 * decide the answer.
 */
export function applyNarrow(candidates: ListenCandidate[], active: NarrowKind | null): ListenCandidate[] {
    if (active === null || active === "all") {
        return candidates;
    }

    const kept = candidates.filter((candidate) => matches(candidate, active));
    return kept.length === 0 ? candidates : kept;
}

function matches(candidate: ListenCandidate, active: NarrowKind): boolean {
    if (active === "menus") {
        return candidate.action === "menu";
    }

    if (active === "apps") {
        return candidate.action === "app";
    }

    if (active === "fields") {
        return candidate.action === "set" || test(candidate, FIELD_ROLES);
    }

    // A pressable row whose role the surface did not report could be either, so it stays in both.
    // Hiding a real target because an attribute was missing is the one failure this must not have.
    const unknown = candidate.action === "press" && (candidate.role ?? "").length === 0;
    if (active === "links") {
        return unknown || test(candidate, LINK_ROLES);
    }

    return candidate.action === "press" && !test(candidate, LINK_ROLES) && (unknown || test(candidate, BUTTON_ROLES));
}

function test(candidate: ListenCandidate, pattern: RegExp): boolean {
    const role = candidate.role ?? "";
    return role.length > 0 && pattern.test(role);
}
