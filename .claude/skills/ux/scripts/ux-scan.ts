#!/usr/bin/env bun
/**
 * Lists candidate UX defects in Swift files, grouped by the passes of references/audit.md. A line here is a
 * candidate, not a finding: read it in context and check the shared components (audit.md section 0) before you
 * report it. The scan only reads files.
 *
 * Usage: bun .claude/skills/ux/scripts/ux-scan.ts <file or folder>... [--max <hits per check, default 60>]
 */
import { type Check, type CountFact, runCli, type ScanSet } from "./scan-engine.ts";

const CHECKS: Check[] = [
    // Pointer and targets
    {
        pass: "Pointer and targets",
        name: "bare-button",
        pattern: /\.buttonStyle\(\.(plain|borderless)\)|\.menuStyle\(\.borderlessButton\)/,
        hint: "no hover and no hand cursor, unless the label draws its own (open it)",
    },
    {
        pass: "Pointer and targets",
        name: "menu",
        pattern: /\bMenu\s*\{|\bMenu\(/,
        hint: "a SwiftUI Menu has no shared hover style; MenuButton or a .genHover style gives one",
        unless: /genHover|MenuButton/,
        near: 8,
    },
    {
        pass: "Pointer and targets",
        name: "tap-gesture",
        pattern: /\.onTapGesture(?!\(count: 2)/,
        hint: "acts on tap: needs hover, a hand cursor, a key path and an accessibility action",
    },
    {
        pass: "Pointer and targets",
        name: "small-frame",
        pattern: /\.frame\([^\n)]*\b(?:width|height):\s*(?:[01]?\d|2[01])(?:\.\d+)?(?=\s*[,)])/,
        hint: "a dimension under 22 pt if this frame is (or wraps) a control; inspect its padding and hit area",
    },
    {
        pass: "Pointer and targets",
        name: "small-glyph-button",
        pattern: /\.font\(\.system\(size:\s*(9|10|11|12)(\.\d+)?\)\)/,
        hint: "a small glyph that is a button: is its hit area padded to 22 pt?",
        unless: /IconButton|frame\(width:\s*(2\d|[3-9]\d)/,
        near: 3,
    },
    {
        pass: "Pointer and targets",
        name: "drop-target",
        pattern: /\.onDrop\(|\.dropDestination\(/,
        hint: "does it highlight while a drag is over it (isTargeted)?",
        unless: /isTargeted|targeted/,
        near: 4,
    },
    // Keyboard
    {
        pass: "Keyboard",
        name: "return-default",
        pattern: /keyboardShortcut\(\.defaultAction\)|keyboardShortcut\(\.return|keyEquivalent = "\\r"/,
        hint: "Return runs this: is it the safe, reversible choice (never Send, Delete, Approve, Discard)?",
    },
    {
        pass: "Keyboard",
        name: "bare-letter-key",
        pattern: /onKeyPress\(characters:|keyboardShortcut\("[a-z0-9]"\)/,
        hint: "a shortcut with no modifier: does it fire while a text field has focus?",
    },
    {
        pass: "Keyboard",
        name: "key-handler",
        pattern: /onKeyPress|onExitCommand|onMoveCommand|cancelAction/,
        hint: "where keys are handled: on a view that keeps focus, or only on the root or one field?",
    },
    {
        pass: "Keyboard",
        name: "context-menu",
        pattern: /\.contextMenu/,
        hint: "is each action here also a visible control or a key?",
    },
    {
        pass: "Keyboard",
        name: "text-field",
        pattern: /\bTextField\(|\bTextEditor\(/,
        hint: "focused on open? Esc reverts? a search field has a clear button? the whole box takes the click?",
    },
    // VoiceOver
    {
        pass: "VoiceOver",
        name: "hover-only",
        pattern: /if\s+(isHovering|hovering|isHovered|hovered|hover|live|isHot|hot)\b/,
        hint: "shown only on hover: needs an .accessibilityAction(named:) or a context-menu item",
    },
    {
        pass: "VoiceOver",
        name: "tooltip-only-meaning",
        pattern: /\.(instantTooltip|help)\(/,
        hint: "a tooltip sets no accessibility label: is this an icon, badge or count with no label?",
        unless: /accessibilityLabel|IconButton|Text\(/,
        near: 4,
    },
    {
        pass: "VoiceOver",
        name: "ignored-children",
        pattern: /accessibilityElement\(children: \.ignore\)/,
        hint: "does it re-add every action and state of the children it hides?",
    },
    {
        pass: "VoiceOver",
        name: "selection-look",
        pattern: /(isSelected|selected)\s*\?\s*"(checkmark|circle)|isSelected \?|selected \?/,
        hint: "is the selection exposed (.accessibilityAddTraits(.isSelected) or a value), not only drawn?",
        unless: /isSelected\)|accessibilityValue|accessibilityAddTraits/,
        near: 8,
    },
    // Feedback and errors
    {
        pass: "Feedback and errors",
        name: "raw-error-text",
        pattern:
            /Text\([^)]*\b(error|stderr|detail|failure|reason)\b|localizedDescription|stderr|\.suffix\(\d{3}\)|"\\\((error|failure)\)"/,
        hint: "machine words on screen? one sentence plus Retry, raw text behind Details",
    },
    {
        pass: "Feedback and errors",
        name: "tone-from-words",
        pattern: /\.contains\("(exited|failed|error|Error|denied)"\)/,
        hint: "a colour or tone guessed from the text: store the tone with the message",
    },
    {
        pass: "Feedback and errors",
        name: "long-timeout",
        pattern: /(timeout|Timeout|deadline)\w*\s*[:=]\s*(1[1-9]|[2-9]\d|\d{3,})(\.\d+)?\b/,
        hint: "a wait over 10 s: does the user see a reason or a Cancel before it ends?",
    },
    {
        pass: "Feedback and errors",
        name: "collapse-after-action",
        pattern: /;\s*collapse\(\)|^\s*collapse\(\)\s*$/,
        hint: "the panel closes right after an action: does a failure still reach the user?",
    },
    // Undo and destructive
    {
        pass: "Undo and destructive actions",
        name: "destructive",
        pattern: /role:\s*\.destructive|"(Discard|Delete|Remove|Dismiss|Clear|Forget)[^"]*"/,
        hint: "Undo, or a confirm that names the object? never on Return",
    },
    {
        pass: "Undo and destructive actions",
        name: "loss-verbs",
        pattern: /"[^"]*\b(discard|drop|delete|remove|trash|throw away)\b[^"]*"/i,
        hint: "list of loss verbs: one action should have one verb everywhere",
    },
    // Empty and loading
    {
        pass: "Empty and loading states",
        name: "empty-text",
        pattern: /"(No |Nothing|Empty\b|None yet)[^"]*"|"[^"]*(unavailable|not available)[^"]*"/,
        hint: "an empty or unknown state: says why, offers a button, not shown while still loading?",
    },
    {
        pass: "Empty and loading states",
        name: "cli-advice",
        pattern: /"[^"]*(\bRun |\brun |`)tools [a-z][^"]*"/,
        hint: "tells the user to type a command: a button belongs here",
    },
    {
        pass: "Empty and loading states",
        name: "progress",
        pattern: /ProgressView\(|SkeletonRows|\.redacted\(/,
        hint: "shown at once for short work? does every loading state end in content, empty or an error?",
    },
    // Motion
    {
        pass: "Motion and Reduce Motion",
        name: "reduce-motion-false",
        pattern: /reduceMotion:\s*false/,
        hint: "a hard-coded false where the Reduce Motion state belongs",
    },
    {
        pass: "Motion and Reduce Motion",
        name: "literal-animation",
        pattern:
            /withAnimation\(\.(easeInOut|easeOut|easeIn|spring|linear|smooth|snappy|bouncy)|\.animation\(\.(easeInOut|easeOut|easeIn|spring|linear|smooth|snappy|bouncy)|static let animation: Animation/,
        hint: "a literal curve: does this path check Reduce Motion?",
        unless: /reduceMotion|ReduceMotion|GenMotion/,
        near: 3,
    },
    {
        pass: "Motion and Reduce Motion",
        name: "loop-or-window-motion",
        pattern: /repeatForever|CABasicAnimation|NSAnimationContext|\.animator\(\)|setFrameOrigin\(/,
        hint: "a loop or an AppKit move: stops when hidden, still under Reduce Motion?",
    },
    // Attention
    {
        pass: "Things that appear by themselves",
        name: "literal-delay",
        pattern:
            /asyncAfter\(deadline: \.now\(\) \+ \d|Task\.sleep\(for: \.seconds\(\d|seconds: Double = \d|Timer\.scheduledTimer\(withTimeInterval: \d/,
        hint: "a duration the user notices, as a literal: a setting? a popup or note that cannot be closed early?",
    },
    {
        pass: "Things that appear by themselves",
        name: "sound-or-front",
        pattern: /NSSound|AudioServicesPlaySystemSound|orderFrontRegardless|activate\(ignoringOtherApps/,
        hint: "a sound or a window that comes forward by itself: a setting, a cause, a way to close it",
    },
    // Counts and words
    {
        pass: "Counts, words and text",
        name: "summed-count",
        pattern: /\b\w*(unread|count|Count|needs\w*|total)\w*\)?\s*\+\s*(max\()?\w/,
        hint: "a badge that adds two kinds of thing: does it count only what needs the user?",
    },
    {
        pass: "Counts, words and text",
        name: "all-caps",
        pattern: /(Text|label|caption|title)\("[A-Z][A-Z :·-]{4,}"|"[^"]*\b[A-Z]{5,}\b[^"]*"/,
        hint: "ALL-CAPS text: sentence case, unless a tiny kicker",
        unless: /JSON|HTTP|UUID|ASCII|HTML|CSV|PDF|URL/,
        near: 0,
    },
    {
        pass: "Counts, words and text",
        name: "raw-value-in-text",
        pattern:
            /\.capitalized\b|\.rawValue\b|"[^"]*\\\((\w+\.)*(id|Id|ID|state|status|kind|sourceId|sessionId|ci|detail|busy|reason|error|message)\)[^"]*"/,
        hint: "a value from the data shown as words: map it to a sentence",
    },
    {
        pass: "Counts, words and text",
        name: "tooltip-names-command",
        pattern: /(instantTooltip|help)\("[^"]*\btools [a-z]/,
        hint: "the tooltip says which command runs, not what happens",
    },
    {
        pass: "Counts, words and text",
        name: "dash-in-text",
        pattern: /"[^"]*[—–][^"]*"/,
        hint: "an em or en dash in a visible string",
    },
    {
        pass: "Counts, words and text",
        name: "small-or-faint-text",
        pattern:
            /\.font\(\.system\(size:\s*(7|8|8\.5|9|9\.5|10|10\.5)\b|foregroundStyle\([^)]*opacity\(0\.[2-5]\d?\)|\.foregroundStyle\(\.tertiary\)/,
        hint: "text under 11 pt or faint: is it something the user must read (4.5:1)?",
    },
    {
        pass: "Counts, words and text",
        name: "letter-badges",
        pattern: /Text\(verbatim: \w+\.id\)|"key \\\(|index \+ 1/,
        hint: "badges and keys: does the badge show the same symbol the key uses?",
    },
    // Layout
    {
        pass: "Layout",
        name: "fixed-height-label",
        pattern: /\.frame\(height:\s*\d+\)/,
        hint: "text in a fixed height: a line limit, or does a long title wrap or clip?",
        unless: /lineLimit/,
        near: 4,
    },
    {
        pass: "Layout",
        name: "native-segmented",
        pattern: /pickerStyle\(\.segmented\)/,
        hint: "the kit has GenSegmentedTabs; a native one greys out in a non-key window",
    },
    {
        pass: "Layout",
        name: "stepper-or-choice",
        pattern: /\bStepper\(|cadenceChoices|Picker\(/,
        hint: "is the same setting also edited elsewhere with other words or another range?",
    },
    // Windows and settings
    {
        pass: "Windows and settings",
        name: "window-flags",
        pattern:
            /isMovableByWindowBackground = true|NSScreen\.main\b|runModal\(\)|setActivationPolicy|hidesOnDeactivate = true/,
        hint: "window rules: no background drag with SwiftUI, no NSScreen.main placement, modals that block quit",
    },
    {
        pass: "Windows and settings",
        name: "refresh-on-appear",
        pattern: /\.onAppear\s*\{[^}]*(refresh|reload)\(/,
        hint: "read once on appear: is it read again when the app becomes active (didBecomeActive)?",
    },
];

/** Facts over the whole scanned set, printed after the passes. */
const FACTS: CountFact[] = [
    {
        name: "VoiceOver announcements",
        pattern: /announcementRequested|AccessibilityNotification|NSAccessibility\.post/,
        zeroMeans: "nothing that changes by itself is announced",
    },
    {
        name: "Undo support",
        pattern: /undoManager|UndoManager|"Undo"|noticeAction/,
        zeroMeans: "no destructive action here can be undone",
    },
    {
        name: "re-read on activation",
        pattern: /didBecomeActiveNotification|didBecomeKeyNotification/,
        zeroMeans: "nothing re-reads outside state when the user comes back",
    },
    {
        name: "arrow-key navigation",
        pattern: /\.upArrow|\.downArrow|onMoveCommand|moveUp|moveDown/,
        zeroMeans: "no list here moves with Up and Down",
    },
    {
        name: "search in settings",
        pattern: /searchable|SearchField|"Search/,
        zeroMeans: "no search field",
    },
];

const UX_SET: ScanSet = {
    title: "UX scan",
    checks: CHECKS,
    counts: FACTS,
    fileFacts: [
        {
            name: "files that animate and never read Reduce Motion",
            test: (text) =>
                /withAnimation\(|\.animation\(|repeatForever|NSAnimationContext|CABasicAnimation/.test(text) &&
                !/reduceMotion|ReduceMotion|GenMotion|ShouldReduceMotion/.test(text)
                    ? ""
                    : undefined,
        },
        {
            name: "files with more than one reload button",
            test: (_text, lines) => {
                const reloads = lines.filter((l) => l.includes('"arrow.clockwise"')).length;
                return reloads > 1 ? String(reloads) : undefined;
            },
        },
    ],
};

if (import.meta.main) {
    runCli(UX_SET, process.argv.slice(2), "usage: bun ux-scan.ts <file or folder>... [--max <n>]");
}
