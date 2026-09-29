import type { Observation } from "../observation";

/**
 * A realistic settings window for the request-size golden test: a toolbar, two groups of
 * checkboxes with explanatory text, a pop-up and footer buttons. 41 rows, 19 pressable.
 */
export function settingsWindowObservation(): Observation {
    const elements: Observation["elements"] = [
        { index: 0, depth: 0, role: "AXWindow", AXTitle: "Editor Settings", visible: true, actions: ["AXRaise"] },
        { index: 1, depth: 1, role: "AXToolbar", visible: true, actions: [] },
    ];
    const toolbar = ["General", "Appearance", "Editing", "Keymap", "Extensions"];
    toolbar.forEach((label, offset) => {
        elements.push({
            index: elements.length,
            depth: 2,
            role: "AXButton",
            AXTitle: label,
            AXEnabled: "1",
            visible: true,
            actions: ["AXPress"],
        });
        void offset;
    });
    const groups: Array<{ title: string; options: string[] }> = [
        {
            title: "Text editing",
            options: ["Show line numbers", "Highlight current line", "Wrap long lines", "Show invisible characters"],
        },
        {
            title: "Saving",
            options: ["Save automatically on focus change", "Trim trailing whitespace", "Insert final newline"],
        },
    ];
    for (const group of groups) {
        elements.push({ index: elements.length, depth: 2, role: "AXGroup", AXTitle: group.title, visible: true });
        for (const option of group.options) {
            elements.push({
                index: elements.length,
                depth: 3,
                role: "AXCheckBox",
                AXTitle: option,
                AXValue: "0",
                AXEnabled: "1",
                visible: true,
                actions: ["AXPress"],
            });
            elements.push({
                index: elements.length,
                depth: 3,
                role: "AXStaticText",
                AXValue: `Controls whether the editor will ${option.toLowerCase()} in every open document.`,
                visible: true,
            });
        }
    }
    elements.push({
        index: elements.length,
        depth: 2,
        role: "AXPopUpButton",
        AXTitle: "Theme",
        AXValue: "Light",
        AXEnabled: "1",
        visible: true,
        actions: ["AXPress", "AXShowMenu"],
    });
    for (const label of ["Reset to defaults", "Import…", "Export…", "Help", "Cancel", "Apply", "OK"]) {
        elements.push({
            index: elements.length,
            depth: 2,
            role: "AXButton",
            AXTitle: label,
            AXEnabled: "1",
            visible: true,
            actions: ["AXPress"],
        });
    }
    return {
        ok: true,
        app: "Editor",
        pid: 4242,
        snapshot: "tok-settings",
        window: { id: 7, title: "Editor Settings" },
        scope: "window",
        elements,
    };
}
