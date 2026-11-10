import AppKit
import GenesisKit
import SwiftUI

// The entries of the catalog. One static per component; `KitCatalog.entries` lists them in the board's order.

private extension View {
    /// Draws the kit's buttons inside as the pointer would make them.
    func shown(_ state: KitInteraction) -> some View {
        environment(\.kitForcedInteraction, state == .rest ? nil : state)
    }
}

/// The contrast of a white label on a fill (WCAG 2), as "5.2 : 1".
private func contrastWithWhite(_ color: Color) -> String {
    guard let rgb = NSColor(color).usingColorSpace(.sRGB) else { return "?" }
    func linear(_ value: CGFloat) -> Double {
        let v = Double(value)
        return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }
    let luminance = 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
    return String(format: "%.1f : 1", 1.05 / (luminance + 0.05))
}

private let fourStates = "rest · under the pointer · pressed · disabled"

@MainActor
extension KitCatalog {
    // MARK: Foundations

    static var hues: CatalogEntry {
        let meaning: [KitHue: String] = [
            .play: "Sound and time: what plays, what was heard, a time a click plays. The one main action.",
            .ask: "A question for you, a selection, something staged for an agent.",
            .done: "Decided, confirmed, healthy.",
            .care: "Needs care: a warning, low confidence, a mark.",
            .danger: "Destroys something, or failed.",
            .neutral: "No meaning: the window's own ink.",
        ]
        return CatalogEntry(
            id: "hues", group: "Foundations", name: "Colour roles (KitHue)",
            summary: "A colour with a meaning. A view names the meaning and never an RGB value, so one thing has one colour in every window. Each hue has an ink for text and glyphs, a solid that carries a white label, and a bright end for a gradient.",
            source: "GenesisKitBase/Style/KitHue.swift", isNew: true,
            critique: [
                "Today a view picks its own blue: the filled button, the session palette, the widget and the system accent are four different blues.",
                "Nothing says what a colour means, so the Meetings window uses blue for a link, a playing row and a selected tab alike, and grey for everything else.",
            ],
            looks: [.classic],
            sections: [
                CatalogSection("The six hues", flow: .column, KitHue.allCases.map { hue in
                    CatalogVariant(hue.rawValue, props: meaning[hue]) {
                        HStack(spacing: 10) {
                            RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hue.solid)
                                .frame(width: 92, height: 30)
                                .overlay { Text(verbatim: "solid").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white) }
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(LinearGradient(colors: [hue.bright, hue.solid], startPoint: .top, endPoint: .bottom))
                                .frame(width: 92, height: 30)
                                .overlay { Text(verbatim: "bright to solid").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white) }
                            RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hue.ink.opacity(0.16))
                                .overlay { RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(hue.ink.opacity(0.38)) }
                                .frame(width: 92, height: 30)
                                .overlay { Text(verbatim: "tint").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(hue.ink) }
                            Text(verbatim: "Ink on the ground").font(.system(size: 12.5, weight: .medium)).foregroundStyle(hue.ink)
                            Text(verbatim: "white on solid \(contrastWithWhite(hue.solid))")
                                .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Color.white.opacity(0.45))
                        }
                    }
                }),
            ])
    }

    // MARK: Navigation

    static var tabs: CatalogEntry {
        typealias Item = GenSegmentedTabs<String>.Item
        let plain: [Item] = [.init("items", "Items"), .init("speakers", "Speakers"), .init("transcript", "Transcript"), .init("screen", "Screen")]
        let rich: [Item] = [
            .init("items", "Items", symbol: "checklist", count: 126),
            .init("questions", "Questions", symbol: "questionmark.bubble", count: 9, hue: .ask),
            .init("speakers", "Speakers", symbol: "person.2", count: 5, hue: .done),
            .init("transcript", "Transcript", symbol: "text.alignleft", hue: .play),
        ]
        let counts: [Item] = [.init("all", "All"), .init("questions", "Questions", count: 9, hue: .ask), .init("suggestions", "Suggestions", count: 14, hue: .care)]
        let scope: [Item] = [.init("clip", "Clip"), .init("context", "Context"), .init("meeting", "Meeting")]
        return CatalogEntry(
            id: "tabs", group: "Navigation", name: "Segmented tabs (GenSegmentedTabs)",
            summary: "A choice between a few views or filters. One pill marks the selection and slides to the new segment. A segment may carry a glyph, a count and a hue.",
            source: "GenesisKit/Controls/GenSegmentedTabs.swift",
            critique: [
                "The selected segment is the system's full blue: the loudest thing in a window is the tab the reader already chose.",
                "A count is plain text in the title (\"Context 1\"), so it reads as part of the name.",
                "The hover fills of two neighbours touch (a 2 pt gap) and read as one grey block.",
                "No glyphs and no size for the main tabs of a window.",
            ],
            notes: [
                .aurora: "The pill is a lighter surface with a top light; a count is a chip in its hue.",
                .candy: "The pill takes the hue of its segment.",
                .glass: "The pill is a pane with a line in the segment's hue under it.",
            ],
            sections: [
                CatalogSection("Selection", [
                    CatalogVariant("The first is selected", props: "selection: \"items\"") {
                        GenSegmentedTabs("Tabs", items: plain, selection: .constant("items"))
                    },
                    CatalogVariant("The third is selected", props: "selection: \"transcript\"") {
                        GenSegmentedTabs("Tabs", items: plain, selection: .constant("transcript"))
                    },
                ]),
                CatalogSection("A segment that is not selected", [
                    CatalogVariant("Under the pointer") {
                        GenSegmentedTabs("Tabs", items: scope, selection: .constant("clip"), minSegmentWidth: 56).shown(.hover)
                    },
                    CatalogVariant("Pressed") {
                        GenSegmentedTabs("Tabs", items: scope, selection: .constant("clip"), minSegmentWidth: 56).shown(.pressed)
                    },
                ]),
                CatalogSection("Glyphs, counts and hues", flow: .column, [
                    CatalogVariant("A neutral segment is selected", props: "Item(id, title, symbol:, count:, hue:)") {
                        GenSegmentedTabs("Tabs", items: rich, selection: .constant("items"), minSegmentWidth: 40)
                    },
                    CatalogVariant("A segment with a hue is selected", props: "hue: .ask") {
                        GenSegmentedTabs("Tabs", items: rich, selection: .constant("questions"), minSegmentWidth: 40)
                    },
                    CatalogVariant("A filter with counts", props: "count: 9, hue: .ask · count: 14, hue: .care") {
                        GenSegmentedTabs("Filter", items: counts, selection: .constant("all"), minSegmentWidth: 40)
                    },
                ]),
                CatalogSection("Sizes", flow: .column, [
                    CatalogVariant("Small", props: "size: .small") {
                        GenSegmentedTabs("Tabs", items: scope, selection: .constant("context"), minSegmentWidth: 48, size: .small)
                    },
                    CatalogVariant("Regular", props: "size: .regular (default)") {
                        GenSegmentedTabs("Tabs", items: scope, selection: .constant("context"), minSegmentWidth: 56)
                    },
                    CatalogVariant("Large: the main tabs of a window", props: "size: .large") {
                        GenSegmentedTabs("Tabs", items: rich, selection: .constant("speakers"), minSegmentWidth: 40, size: .large)
                    },
                ]),
                CatalogSection("Over the width of a column", [
                    CatalogVariant("320 pt", props: "fillsWidth: true") {
                        GenSegmentedTabs("Tabs", items: plain, selection: .constant("speakers"), fillsWidth: true).frame(width: 320)
                    },
                    CatalogVariant("230 pt: every title steps one size down", props: "fillsWidth: true") {
                        GenSegmentedTabs("Tabs", items: plain, selection: .constant("speakers"), fillsWidth: true).frame(width: 230)
                    },
                ]),
                CatalogSection("In a light window", [
                    CatalogVariant("Light scheme", props: ".environment(\\.colorScheme, .light)") {
                        GenSegmentedTabs("Tabs", items: counts, selection: .constant("questions"), minSegmentWidth: 40)
                            .padding(10)
                            .background(Color(white: 0.96), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .environment(\.colorScheme, .light)
                    },
                ]),
            ])
    }

    // MARK: Actions

    static var buttons: CatalogEntry {
        func states(_ title: String, symbol: String? = nil, kind: KitButtonKind, hue: KitHue = .neutral) -> some View {
            HStack(spacing: 10) {
                KitButton(title, symbol: symbol, kind: kind, hue: hue) {}
                KitButton(title, symbol: symbol, kind: kind, hue: hue) {}.shown(.hover)
                KitButton(title, symbol: symbol, kind: kind, hue: hue) {}.shown(.pressed)
                KitButton(title, symbol: symbol, kind: kind, hue: hue) {}.disabled(true)
            }
        }
        let hues: [KitHue] = [.play, .ask, .done, .care, .danger, .neutral]
        return CatalogEntry(
            id: "buttons", group: "Actions", name: "Buttons (KitButton)",
            summary: "One family for every text button: five kinds by weight, a hue by meaning, three sizes. A bar holds at most one primary. `.buttonStyle(.kit(...))` gives the same look to any Button.",
            source: "GenesisKit/Controls/KitButton.swift", isNew: true,
            critique: [
                "Today a view chooses between GhostButton, the filled style, three hover styles and a hand-built text button, and each has its own height, radius and hover.",
                "No tinted button exists, so a secondary action cannot say what it belongs to (a question, a decided row).",
                "The Meetings window builds its row actions (\"Answer\", the choice chips) by hand, so they look unlike the buttons of the dock.",
            ],
            notes: [
                .aurora: "The primary is a gradient with a glow in its hue; a tinted button is 15 % of its hue with a hairline of it.",
                .candy: "Every button is a capsule; the ghost has a thicker outline.",
                .glass: "A tinted button keeps a neutral pane and shows its hue only on the glyph.",
            ],
            sections: [
                CatalogSection("Kinds and their states", flow: .column, [
                    CatalogVariant("Primary: the one main action", props: "kind: .primary, hue: .play   \(fourStates)") {
                        states("Pause", symbol: "pause.fill", kind: .primary, hue: .play)
                    },
                    CatalogVariant("Tinted: an action that belongs to a meaning", props: "kind: .tinted, hue: .ask") {
                        states("Answer", symbol: "questionmark.bubble", kind: .tinted, hue: .ask)
                    },
                    CatalogVariant("Soft: a quiet filled action", props: "kind: .soft (default)") {
                        states("Replay clip", symbol: "arrow.counterclockwise", kind: .soft)
                    },
                    CatalogVariant("Ghost: an outline beside others of equal weight", props: "kind: .ghost") {
                        states("Open frame", symbol: "arrow.up.forward.square", kind: .ghost)
                    },
                    CatalogVariant("Plain: words at the end of a row", props: "kind: .plain, hue: .done") {
                        states("Confirm", kind: .plain, hue: .done)
                    },
                ]),
                CatalogSection("Hues", flow: .column, [
                    CatalogVariant("Tinted", props: "hue: .play · .ask · .done · .care · .danger · .neutral") {
                        HStack(spacing: 10) {
                            ForEach(hues, id: \.self) { hue in
                                KitButton(hue.rawValue.capitalized, symbol: "circle.fill", kind: .tinted, hue: hue) {}
                            }
                        }
                    },
                    CatalogVariant("Primary", props: "a window uses one primary hue; the others exist for a destructive or a confirm dialog") {
                        HStack(spacing: 10) {
                            ForEach(hues, id: \.self) { hue in
                                KitButton(hue.rawValue.capitalized, kind: .primary, hue: hue) {}
                            }
                        }
                    },
                    CatalogVariant("Plain", props: "kind: .plain") {
                        HStack(spacing: 4) {
                            ForEach(hues, id: \.self) { hue in
                                KitButton(hue.rawValue.capitalized, kind: .plain, hue: hue) {}
                            }
                        }
                    },
                ]),
                CatalogSection("Sizes", [
                    CatalogVariant("Small, in a dense row", props: "size: .small (22 pt)") {
                        KitButton("Keep as heard", symbol: "checkmark", kind: .soft, size: .small) {}
                    },
                    CatalogVariant("Regular", props: "size: .regular (26 pt)") {
                        KitButton("Keep as heard", symbol: "checkmark", kind: .soft) {}
                    },
                    CatalogVariant("Large, the controls of a player", props: "size: .large (30 pt)") {
                        KitButton("Keep as heard", symbol: "checkmark", kind: .soft, size: .large) {}
                    },
                ]),
                CatalogSection("Glyphs and width", [
                    CatalogVariant("A glyph after the title", props: "trailingSymbol: \"chevron.down\"") {
                        KitButton("Confirm all", trailingSymbol: "chevron.down", kind: .ghost) {}
                    },
                    CatalogVariant("One glyph, with a tooltip", props: "KitButton(symbol:, tooltip:)") {
                        HStack(spacing: 8) {
                            KitButton(symbol: "gearshape", tooltip: "Settings") {}
                            KitButton(symbol: "gearshape", tooltip: "Settings") {}.shown(.hover)
                            KitButton(symbol: "sidebar.right", tooltip: "Transcript", kind: .tinted, hue: .play) {}
                            KitButton(symbol: "gearshape", tooltip: "Settings", size: .large) {}
                        }
                    },
                    CatalogVariant("Over the width of a column", props: "fullWidth: true") {
                        KitButton("Open in the hub", symbol: "arrow.up.forward.app", trailingSymbol: "chevron.right", kind: .ghost, fullWidth: true) {}
                            .frame(width: 230)
                    },
                ]),
                CatalogSection("Together: the controls of a player and the end of a row", flow: .column, [
                    CatalogVariant("One primary, then soft and ghost", props: "size: .large") {
                        HStack(spacing: 8) {
                            KitButton("Pause", symbol: "pause.fill", kind: .primary, hue: .play, size: .large) {}
                            KitButton("5 s", symbol: "gobackward", kind: .soft, size: .large) {}
                            KitButton("5 s", trailingSymbol: "goforward", kind: .soft, size: .large) {}
                            KitButton("Asked point", symbol: "flag.fill", kind: .ghost, hue: .play, size: .large) {}
                            KitButton("Replay clip", symbol: "arrow.counterclockwise", kind: .ghost, size: .large) {}
                        }
                    },
                    CatalogVariant("A suggestion's choices: the likely one is tinted", props: "size: .small") {
                        HStack(spacing: 6) {
                            KitButton("Employee segment", kind: .tinted, hue: .play, size: .small) {}
                            KitButton("EMP", kind: .soft, size: .small) {}
                            KitButton("OMP", kind: .soft, size: .small) {}
                            KitButton("Skip", kind: .plain, size: .small) {}
                        }
                    },
                    CatalogVariant("A row's two words", props: "kind: .plain, hue: .done / .danger") {
                        HStack(spacing: 2) {
                            KitButton("Confirm", kind: .plain, hue: .done) {}
                            KitButton("Reject", kind: .plain, hue: .danger) {}
                        }
                    },
                ]),
            ])
    }

    static var toggleChips: CatalogEntry {
        func states(on: Bool, symbol: String? = nil, _ title: String) -> some View {
            HStack(spacing: 10) {
                KitToggleChip(title, symbol: symbol, isOn: .constant(on))
                KitToggleChip(title, symbol: symbol, isOn: .constant(on)).shown(.hover)
                KitToggleChip(title, symbol: symbol, isOn: .constant(on)).shown(.pressed)
                KitToggleChip(title, symbol: symbol, isOn: .constant(on)).disabled(true)
            }
        }
        return CatalogEntry(
            id: "toggle-chip", group: "Actions", name: "Toggle chip (KitToggleChip)",
            summary: "A button that stays on or off: \"Follows playback\", \"Tone\". On, it is a tint of its hue. Its glyph keeps its place in both states, so the chip never changes width.",
            source: "GenesisKit/Controls/KitButton.swift", isNew: true,
            critique: [
                "Today the Meetings window draws \"Follows playback\" as a grey outlined label: on and off look alike.",
                "A state the user can switch has no shared control in the kit, so each window builds its own.",
            ],
            sections: [
                CatalogSection("Off and on", [
                    CatalogVariant("Off", props: "isOn: false") { KitToggleChip("Follows playback", isOn: .constant(false)) },
                    CatalogVariant("On", props: "isOn: true") { KitToggleChip("Follows playback", isOn: .constant(true)) },
                    CatalogVariant("With its own glyph, off", props: "symbol: \"music.note\"") { KitToggleChip("Tone", symbol: "music.note", isOn: .constant(false)) },
                    CatalogVariant("With its own glyph, on") { KitToggleChip("Tone", symbol: "music.note", isOn: .constant(true)) },
                ]),
                CatalogSection("States", flow: .column, [
                    CatalogVariant("Off", props: fourStates) { states(on: false, "Follows") },
                    CatalogVariant("On", props: fourStates) { states(on: true, "Follows") },
                ]),
                CatalogSection("Hues and sizes", [
                    CatalogVariant("Ask", props: "hue: .ask") { KitToggleChip("Only questions", isOn: .constant(true), hue: .ask) },
                    CatalogVariant("Done", props: "hue: .done") { KitToggleChip("Show decided", isOn: .constant(true), hue: .done) },
                    CatalogVariant("Care", props: "hue: .care") { KitToggleChip("Low confidence", isOn: .constant(true), hue: .care) },
                    CatalogVariant("Small", props: "size: .small") { KitToggleChip("Follows", isOn: .constant(true), size: .small) },
                    CatalogVariant("Large", props: "size: .large") { KitToggleChip("Tone on", symbol: "music.note", isOn: .constant(true), size: .large) },
                ]),
            ])
    }

    static var iconButtons: CatalogEntry {
        CatalogEntry(
            id: "icon-button", group: "Actions", name: "Icon button (IconButton)",
            summary: "The only way to put an icon-only button on screen: it always carries an instant tooltip, which is also its name for VoiceOver and UI automation.",
            source: "GenesisKit/Controls/IconButton.swift",
            critique: [
                "The hover is an amber disc with an amber outline: amber is the kit's warning colour, so a pointer over a gear looks like a warning.",
                "The glyph at rest is full white at 12 pt and has no ground, so a row of them reads as text, not as controls.",
                "The outline of the scaled disc draws with corners (the picture shows an octagon).",
            ],
            notes: [
                .aurora: "The hover is a wash of the window's ink, with no outline; a named accent (a destructive red) still tints it.",
                .candy: "The hover is a wash of the play hue.",
                .glass: "The hover is a pane with a hairline lit from above.",
            ],
            sections: [
                CatalogSection("States", [
                    CatalogVariant("Rest") { IconButton(systemName: "gearshape", tooltip: "Settings") {} },
                    CatalogVariant("Under the pointer") { IconButton(systemName: "gearshape", tooltip: "Settings") {}.shown(.hover) },
                    CatalogVariant("Pressed") { IconButton(systemName: "gearshape", tooltip: "Settings") {}.shown(.pressed) },
                    CatalogVariant("Disabled") { IconButton(systemName: "gearshape", tooltip: "Settings") {}.disabled(true) },
                ]),
                CatalogSection("Tint and accent", [
                    CatalogVariant("A dim glyph", props: "tint: KitPalette.dim") {
                        IconButton(systemName: "xmark", tooltip: "Remove", tint: KitPalette.dim) {}
                    },
                    CatalogVariant("A destructive action under the pointer", props: "tint: .removed, accent: .removed") {
                        IconButton(systemName: "trash", tooltip: "Delete", tint: KitPalette.removed, accent: KitPalette.removed) {}.shown(.hover)
                    },
                    CatalogVariant("A glyph in a hue", props: "tint: KitHue.play.ink") {
                        IconButton(systemName: "play.fill", tooltip: "Play", tint: KitHue.play.ink) {}.shown(.hover)
                    },
                ]),
                CatalogSection("Glyph sizes", [
                    CatalogVariant("11 pt", props: "size: 11") { IconButton(systemName: "arrow.up.forward.square", tooltip: "Open", size: 11) {} },
                    CatalogVariant("12 pt", props: "size: 12 (default)") { IconButton(systemName: "arrow.up.forward.square", tooltip: "Open") {} },
                    CatalogVariant("15 pt", props: "size: 15") { IconButton(systemName: "arrow.up.forward.square", tooltip: "Open", size: 15) {} },
                ]),
                CatalogSection("In the header of a pane", [
                    CatalogVariant("Three actions, the second under the pointer") {
                        HStack(spacing: 4) {
                            Text(verbatim: "Screen at 54:37").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                            Spacer(minLength: 30)
                            IconButton(systemName: "link", tooltip: "Follows playback") {}
                            IconButton(systemName: "text.viewfinder", tooltip: "OCR text") {}.shown(.hover)
                            IconButton(systemName: "arrow.up.forward.square", tooltip: "Open frame") {}
                        }
                        .frame(width: 260)
                    },
                ]),
            ])
    }

    static var ghostButton: CatalogEntry {
        CatalogEntry(
            id: "ghost-button", group: "Actions", name: "Ghost button (GhostButton)",
            summary: "A text action with a glyph in a hairline outline and no fill, for actions of equal weight side by side, or one per row in a narrow sidebar.",
            source: "GenesisKit/Controls/GhostButton.swift",
            critique: [
                "The outline is white at 11 %: on the app's ground it almost disappears, so the button reads as a label.",
                "The hover adds 5.5 % of white: the change is hard to see.",
                "The title is 11.5 pt where the tabs and the filled button use 12 pt.",
            ],
            notes: [
                .aurora: "The outline is 15 % and the glyph may take a hue.",
                .candy: "A capsule with a 1.5 pt outline.",
                .glass: "The outline is lit from above.",
            ],
            sections: [
                CatalogSection("States", [
                    CatalogVariant("Rest") { GhostButton("Open in last pane", symbol: "rectangle.split.2x1", tooltip: "Open") {} },
                    CatalogVariant("Under the pointer") { GhostButton("Open in last pane", symbol: "rectangle.split.2x1", tooltip: "Open") {}.shown(.hover) },
                    CatalogVariant("Pressed") { GhostButton("Open in last pane", symbol: "rectangle.split.2x1", tooltip: "Open") {}.shown(.pressed) },
                    CatalogVariant("Disabled") { GhostButton("Open in last pane", symbol: "rectangle.split.2x1", tooltip: "Open") {}.disabled(true) },
                ]),
                CatalogSection("Props", [
                    CatalogVariant("A glyph after the title", props: "trailingSymbol: \"chevron.down\"") {
                        GhostButton("Choose a pane", symbol: "rectangle.3.group", tooltip: "Choose", trailingSymbol: "chevron.down") {}
                    },
                    CatalogVariant("A hue on the glyph", props: "hue: .play") {
                        GhostButton("Asked point", symbol: "flag.fill", tooltip: "Jump", hue: .play) {}
                    },
                    CatalogVariant("Lower", props: "height: 22") {
                        GhostButton("Show context", symbol: "text.alignleft", tooltip: "Show", height: 22) {}
                    },
                ]),
                CatalogSection("One action per row", flow: .column, [
                    CatalogVariant("Over the width of a sidebar", props: "fullWidth: true") {
                        VStack(spacing: 6) {
                            GhostButton("Open in last pane", symbol: "rectangle.split.2x1", tooltip: "Open", trailingSymbol: "chevron.right", fullWidth: true) {}
                            GhostButton("Choose a pane", symbol: "rectangle.3.group", tooltip: "Choose", trailingSymbol: "chevron.right", fullWidth: true) {}.shown(.hover)
                        }
                        .frame(width: 250)
                    },
                ]),
            ])
    }

    static var primaryButton: CatalogEntry {
        CatalogEntry(
            id: "primary-button", group: "Actions", name: "Filled button (.genPrimary)",
            summary: "The filled button for the one primary action of a card, list or dialog. It draws its own fill, so it looks the same in a key window and in the widget's panel.",
            source: "GenesisKit/Style/GenPrimaryButton.swift",
            critique: [
                "The fill is one flat blue with no light and no depth, so it does not look pressable.",
                "It is the fourth blue of the kit, darker than the tabs' blue beside it.",
                "It has no size: the label's own font decides its height.",
            ],
            notes: [
                .aurora: "A gradient in the play hue with a top light and a glow.",
                .candy: "A capsule with a diagonal gradient and a wider glow.",
                .glass: "The flat fill stays, with a top light and no glow.",
            ],
            sections: [
                CatalogSection("States", [
                    CatalogVariant("Rest") { Button("Send now") {}.buttonStyle(.genPrimary()) },
                    CatalogVariant("Under the pointer") { Button("Send now") {}.buttonStyle(.genPrimary()).shown(.hover) },
                    CatalogVariant("Pressed") { Button("Send now") {}.buttonStyle(.genPrimary()).shown(.pressed) },
                    CatalogVariant("Disabled") { Button("Send now") {}.buttonStyle(.genPrimary()).disabled(true) },
                ]),
                CatalogSection("Props", [
                    CatalogVariant("A named accent stays", props: "accent: KitPalette.removed") {
                        Button("Delete 3") {}.buttonStyle(.genPrimary(accent: Color(red: 0.75, green: 0.18, blue: 0.22)))
                    },
                    CatalogVariant("With a glyph in the label") {
                        Button { } label: { Label("Send 3 to agent", systemImage: "arrow.up") }.buttonStyle(.genPrimary())
                    },
                ]),
                CatalogSection("Beside a ghost button", [
                    CatalogVariant("The end of a dialog") {
                        HStack(spacing: 8) {
                            GhostButton("Cancel", symbol: "xmark", tooltip: "Cancel") {}
                            Button("Stage comment") {}.buttonStyle(.genPrimary())
                        }
                    },
                ]),
            ])
    }

    static var hoverStyles: CatalogEntry {
        func sample(_ title: String) -> some View {
            Text(verbatim: title).font(.system(size: 12, weight: .medium)).foregroundStyle(.white)
        }
        return CatalogEntry(
            id: "hover-styles", group: "Actions", name: "Hover styles (.genHover, .genHoverPlain, .genHoverRow, .rowButton)",
            summary: "The feedback for a control that draws nothing at rest: a label button, a glyph, a full-width row, a list row.",
            source: "GenesisKit/Style/GenHoverButton.swift · GenesisKitBase/Style/RowButton.swift",
            critique: [
                "Four styles for one idea, with two different hovers: amber fill and outline in three of them, a white wash in the fourth.",
                "The amber hover says \"warning\" in a kit where amber is the colour of care.",
                "`.genHoverPlain` (276 uses) only brightens the label: on a white label nothing changes at all.",
            ],
            notes: [
                .aurora: "One hover for all four: a wash of the window's ink.",
                .candy: "A wash of the play hue.",
                .glass: "A pane with a hairline.",
            ],
            sections: [
                CatalogSection(".genHover(): a label button", [
                    CatalogVariant("Rest") { Button { } label: { sample("Show source") }.buttonStyle(.genHover()) },
                    CatalogVariant("Under the pointer") { Button { } label: { sample("Show source") }.buttonStyle(.genHover()).shown(.hover) },
                    CatalogVariant("Pressed") { Button { } label: { sample("Show source") }.buttonStyle(.genHover()).shown(.pressed) },
                    CatalogVariant("A named accent", props: "accent: SessionPalette.blue") {
                        Button { } label: { sample("Show source") }.buttonStyle(.genHover(accent: SessionPalette.blue)).shown(.hover)
                    },
                ]),
                CatalogSection(".genHoverPlain(): a label that draws its own ground", [
                    CatalogVariant("Rest") { Button { } label: { sample("54:36").foregroundStyle(KitHue.play.ink) }.buttonStyle(.genHoverPlain()) },
                    CatalogVariant("Under the pointer") { Button { } label: { sample("54:36") }.buttonStyle(.genHoverPlain()).shown(.hover) },
                ]),
                CatalogSection(".genHoverRow(): a full-width row or card", flow: .column, [
                    CatalogVariant("Under the pointer") {
                        Button { } label: { sample("Backend DTO design review").frame(width: 300, alignment: .leading).padding(8) }
                            .buttonStyle(.genHoverRow()).shown(.hover)
                    },
                ]),
                CatalogSection(".rowButton: a row of a list", [
                    CatalogVariant("Rest") { sample("Needs you").padding(.horizontal, 8).frame(width: 150, height: 26, alignment: .leading).rowButton {} },
                    CatalogVariant("Under the pointer") { sample("Needs you").padding(.horizontal, 8).frame(width: 150, height: 26, alignment: .leading).rowButton {}.shown(.hover) },
                    CatalogVariant("Pressed") { sample("Needs you").padding(.horizontal, 8).frame(width: 150, height: 26, alignment: .leading).rowButton {}.shown(.pressed) },
                ]),
            ])
    }

    // MARK: Status

    static var badges: CatalogEntry {
        CatalogEntry(
            id: "badges", group: "Status", name: "Badges (Badge, CountBadge)",
            summary: "A short label in a capsule: a tag, a status, or a count beside a sidebar entry. One shape for all three.",
            source: "GenesisKit/Controls/Badge.swift",
            critique: [
                "A tag (10.5 pt medium) and a status (10 pt semibold) differ by half a point, which reads as an error, not as a rank.",
                "The colour is a free `Color`: the caller picks it, so \"open\" is green in one view and blue in the next.",
                "A count in a tab does not use CountBadge; the tabs draw their own.",
                "No look changes badges yet: the proposals for them come with the next tier of the catalog.",
            ],
            looks: [.classic],
            sections: [
                CatalogSection("Looks", [
                    CatalogVariant("Tag", props: "look: .tag (default)") { Badge("merged") },
                    CatalogVariant("Tone", props: "look: .tone, color: .added") { Badge("OPEN", color: KitPalette.added, look: .tone) },
                    CatalogVariant("Filled", props: "look: .filled, color: .removed") { Badge("stuck", color: KitPalette.removed, look: .filled) },
                ]),
                CatalogSection("Props", [
                    CatalogVariant("A glyph", props: "symbol:") { Badge("stuck", color: KitPalette.removed, look: .filled, symbol: "exclamationmark.triangle.fill") },
                    CatalogVariant("Monospaced", props: "monospaced: true") { Badge("a1b2c3d", monospaced: true) },
                    CatalogVariant("Each palette colour", props: "color:") {
                        HStack(spacing: 6) {
                            Badge("added", color: KitPalette.added, look: .tone)
                            Badge("removed", color: KitPalette.removed, look: .tone)
                            Badge("modified", color: KitPalette.modified, look: .tone)
                            Badge("renamed", color: KitPalette.renamed, look: .tone)
                        }
                    },
                ]),
                CatalogSection("Counts", [
                    CatalogVariant("CountBadge", props: "CountBadge(3, tooltip:)") { CountBadge(3, tooltip: "Three sessions") },
                    CatalogVariant("In a colour", props: "color: .modified") { CountBadge(12, tooltip: "Twelve", color: KitPalette.modified) },
                    CatalogVariant("Beside a sidebar entry") {
                        HStack {
                            Text(verbatim: "Needs you").font(.system(size: 12.5)).foregroundStyle(.white)
                            Spacer()
                            CountBadge(8, tooltip: "Eight meetings")
                        }
                        .frame(width: 170)
                    },
                ]),
            ])
    }
}
