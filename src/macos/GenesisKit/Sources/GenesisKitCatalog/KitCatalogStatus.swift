import AppKit
import GenesisKit
import SwiftUI

@MainActor
extension KitCatalog {
    static var statusEntries: [CatalogEntry] {
        [copyChip, emptyState, forgeBadge, infoStrip, kicker, menuButton, newItems, noticePill,
         noticeStack, providerBadge, pulsingDots, refreshingMark, skeletons, spinningArc, userAvatar]
    }

    static var copyChip: CatalogEntry {
        CatalogEntry(id: "copy-chip", group: "Feedback", name: "Copy chip", summary: "A short identifier that copies its complete value. The checkmark occupies the same space as the original glyph.",
            source: "GenesisKit/Controls/CopyChip.swift", critique: ["Keep copy feedback in place so adjacent text does not move.", "A short visible identifier needs a tooltip that names the complete value."],
            notes: [.aurora: "The chip keeps its compact identifier treatment; hover follows the shared button style.", .candy: "Copy stays subordinate to the main action.", .glass: "The value stays readable on a stable background."],
            sections: [CatalogSection("Values and states", [
                CatalogVariant("Short identifier") { CopyChip(label: "a1b2c3d4", value: "a1b2c3d4e5f6", tooltip: "Copy session identifier", what: "session identifier") },
                CatalogVariant("Long identifier") { CopyChip(label: "release/feature-update", value: "release/feature-update", tooltip: "Copy branch name") },
                CatalogVariant("Under the pointer") { CopyChip(label: "a1b2c3d4", value: "a1b2c3d4e5f6", tooltip: "Copy session identifier").shown(.hover) },
                CatalogVariant("Disabled") { CopyChip(label: "unavailable", value: "", tooltip: "No identifier available").disabled(true) },
            ])])
    }

    static var emptyState: CatalogEntry {
        CatalogEntry(id: "empty-state", group: "Feedback", name: "Empty state", summary: "An explanation inside an empty pane, with one optional recovery action.",
            source: "GenesisKit/Controls/EmptyState.swift", critique: ["Say why the pane is empty; an icon alone gives no next step.", "Keep one recovery action and let the surrounding pane provide the boundary."],
            sections: [CatalogSection("Empty panes", flow: .column, [
                CatalogVariant("No items") { EmptyState(symbol: "tray", text: "No items yet").frame(width: 320, height: 110) },
                CatalogVariant("Explanation and recovery") { EmptyState(symbol: "doc.text.magnifyingglass", text: "No matching transcript", detail: "Try a shorter phrase or search screen text.", actionTitle: "Clear search", action: {}).frame(width: 320, height: 150) },
                CatalogVariant("Narrow pane") { EmptyState(text: "No recordings in this project", detail: "Record a meeting to see its frames here.").frame(width: 190, height: 130) },
            ])])
    }

    static var forgeBadge: CatalogEntry {
        CatalogEntry(id: "forge-badge", group: "Identity", name: "Forge badge", summary: "The forge mark and change number identify a pull or merge request. The mark retains the forge's identity in every look.",
            source: "GenesisKit/Controls/ForgeBadge.swift", critique: ["A request number is not meaningful without its forge.", "The request stays legible when its URL is unavailable; it must not look like a working link."],
            sections: [CatalogSection("Forge and availability", [
                CatalogVariant("GitHub") { ForgeBadge(forge: .github, number: 42, url: URL(string: "https://example.com/pull/42"), open: { _ in }) },
                CatalogVariant("GitLab") { ForgeBadge(forge: .gitlab, number: 105, url: URL(string: "https://example.com/merge_requests/105"), open: { _ in }) },
                CatalogVariant("No URL") { ForgeBadge(forge: .github, number: 12345, url: nil, open: { _ in }) },
            ])])
    }

    static var infoStrip: CatalogEntry {
        CatalogEntry(id: "info-strip", group: "Feedback", name: "Information strip", summary: "A persistent explanation near the content it applies to, with a distinct symbol for each meaning.",
            source: "GenesisKit/Controls/InfoStrip.swift", critique: ["Keep persistent context beside its content, separate from short-lived success notices.", "Use a symbol and words with colour so warning and success survive reduced colour perception."],
            sections: [CatalogSection("Meaning and wrapping", flow: .column, [
                CatalogVariant("Information") { InfoStrip("The saved transcript is available offline.").frame(width: 500) },
                CatalogVariant("Warning with action") { InfoStrip("Live updates are off. The last successful read was two minutes ago.", tone: .warning, action: {}, actionTooltip: "Reload", dismiss: {}).frame(width: 350) },
                CatalogVariant("Error") { InfoStrip("The recording could not be opened.", tone: .error, dismiss: {}).frame(width: 500) },
                CatalogVariant("Success") { InfoStrip("The transcript was saved.", tone: .success).frame(width: 500) },
            ])])
    }

    static var kicker: CatalogEntry {
        CatalogEntry(id: "kicker", group: "Typography", name: "Section kicker", summary: "A small label for a section or compact value. It is not a replacement for readable body text.",
            source: "GenesisKit/Controls/Kicker.swift", critique: ["Uppercase tracking is useful for short labels but makes long explanations harder to read.", "Keep secondary text visible rather than reducing its opacity until it disappears."],
            sections: [CatalogSection("Size and meaning", [
                CatalogVariant("Default") { Text("Recording history").kicker() },
                CatalogVariant("Larger") { Text("Selected frame").kicker(size: 12, weight: .semibold, color: .secondary, kerning: 1) },
                CatalogVariant("Semantic colour") { Text("Needs attention").kicker(color: KitHue.care.ink) },
            ])])
    }

    static var menuButton: CatalogEntry {
        let items: () -> [MenuButtonItem] = { [.action("Open", run: {}), .action("Selected", checked: true, run: {}), .divider, .submenu("Export", [.action("Text", run: {}), .action("Audio", enabled: false, run: {})])] }
        return CatalogEntry(id: "menu-button", group: "Commands", name: "Menu button", summary: "A compact entry point to native menu actions, built from the current state when it opens.",
            source: "GenesisKit/Controls/MenuButton.swift", critique: ["Use a recognisable label or a tooltip for an icon-only menu.", "Checked, disabled and nested menu items must retain native menu semantics."],
            sections: [CatalogSection("Closed menu controls", [
                CatalogVariant("Label and chevron", props: "checked, disabled and nested items") { MenuButton(style: .genHoverPlain(), items: items) { Label("Actions", systemImage: "chevron.down").padding(6) } },
                CatalogVariant("Under the pointer") { MenuButton(style: .genHoverPlain(), items: items) { Image(systemName: "ellipsis.circle").padding(6) }.shown(.hover) },
                CatalogVariant("Disabled") { MenuButton(style: .genHoverPlain(), items: items) { Text("Actions").padding(6) }.disabled(true) },
            ])])
    }

    static var newItems: CatalogEntry {
        CatalogEntry(id: "new-items", group: "Feedback", name: "New-items pill", summary: "An explicit way to jump to new arrivals while the reader remains at their chosen scroll position.",
            source: "GenesisKit/Controls/NewItemsPill.swift", critique: ["Do not jump the scroll position when new items arrive.", "Keep the count and noun readable when the count grows."],
            sections: [CatalogSection("Counts and interaction", [
                CatalogVariant("One arrival") { NewItemsPill(count: 1, noun: "new message", action: {}) },
                CatalogVariant("Many arrivals") { NewItemsPill(count: 125, noun: "new messages", action: {}) },
                CatalogVariant("Under the pointer") { NewItemsPill(count: 4, noun: "new frames", action: {}).shown(.hover) },
            ])])
    }

    static var noticePill: CatalogEntry {
        CatalogEntry(id: "notice-pill", group: "Feedback", name: "Notice pill", summary: "A result with an optional action, detail and dismissal. Longer messages wrap instead of losing their meaning in an ellipsis.",
            source: "GenesisKit/Controls/NoticePill.swift", critique: ["Keep actions beside the result they change.", "Warnings and errors need their own words and symbol, not only a different colour."],
            sections: [CatalogSection("Results", flow: .column, [
                CatalogVariant("Success") { NoticePill(text: "Saved", fixes: [.button("Undo", perform: {})], dismiss: {}).frame(width: 420) },
                CatalogVariant("Warning") { NoticePill(text: "Using a beep because the selected tone could not be read.", tone: .warning, dismiss: {}).frame(width: 420) },
                CatalogVariant("Error and recovery") { NoticePill(text: "The transcript could not be read.", detail: "Your saved recording is still available.", more: "The source file is unavailable.", tone: .error, fixes: [.button("Retry", perform: {})], dismiss: {}).frame(width: 420) },
            ])])
    }

    static var noticeStack: CatalogEntry {
        func model(_ count: Int, limit: Int) -> NoticeStackModel {
            let model = NoticeStackModel(maxVisible: { limit }, announces: false)
            for index in 1...count {
                model.push(StackedNotice(text: "Saved change \(index)", actions: [.undo { _ in }], lasting: .untilDismissed))
            }
            return model
        }
        return CatalogEntry(id: "notice-stack", group: "Feedback", name: "Notice stack", summary: "Independent results remain available together. Overflow folds older notices without replacing their actions.",
            source: "GenesisKit/Controls/NoticeStack.swift", critique: ["A new result must not overwrite the previous Undo.", "Limit the visible stack so results do not cover the whole document."],
            sections: [CatalogSection("Stack and overflow", flow: .column, [
                CatalogVariant("Two independent results") { NoticeStackView(model(2, limit: 3), maxWidth: 440, maxHeight: 190).frame(width: 440, height: 130) },
                CatalogVariant("Five results, two visible") { NoticeStackView(model(5, limit: 2), maxWidth: 440, maxHeight: 190).frame(width: 440, height: 170) },
                CatalogVariant("Pinned to the top") { NoticeStackView(model(2, limit: 3), maxWidth: 440, maxHeight: 190, pinnedTo: .top).frame(width: 440, height: 130) },
            ])])
    }

    static var providerBadge: CatalogEntry {
        CatalogEntry(id: "provider-badge", group: "Identity", name: "Provider badge", summary: "The agent harness mark, with a letter fallback for an unknown harness. Identity colour does not imply a status.",
            source: "GenesisKit/Controls/ProviderBadge.swift", critique: ["Keep identity distinct from success, failure and active selection.", "The fallback must stay readable without a downloaded image."],
            sections: [CatalogSection("Harness and size", [
                CatalogVariant("Known harnesses") { HStack { ForEach(Harness.allCases, id: \.rawValue) { ProviderBadge(provider: $0.rawValue) } } },
                CatalogVariant("Unknown harness") { ProviderBadge(provider: "example", size: 24) },
                CatalogVariant("Large") { ProviderBadge(provider: "codex", size: 32) },
            ])])
    }

    static var pulsingDots: CatalogEntry {
        CatalogEntry(id: "pulsing-dots", group: "Progress", name: "Pulsing dots", summary: "A small working indicator animated by the render server rather than rebuilding the view every frame.",
            source: "GenesisKit/Controls/PulsingDots.swift", critique: ["A working indicator needs a nearby task label.", "Keep progress motion local so it does not compete with document content."],
            sections: [CatalogSection("Count, size and colour", [
                CatalogVariant("Default") { HStack { PulsingDots(color: KitHue.play.ink); Text("Reading transcript").font(.caption) } },
                CatalogVariant("One dot") { PulsingDots(color: KitHue.ask.ink, count: 1, diameter: 7) },
                CatalogVariant("Five dots") { PulsingDots(color: .secondary, count: 5, diameter: 3, spacing: 4) },
                CatalogVariant("Reduced motion") { PulsingDots(color: KitHue.play.ink).environment(\.nativeSettingsReduceMotion, true) },
            ])])
    }

    static var refreshingMark: CatalogEntry {
        CatalogEntry(id: "refreshing-mark", group: "Progress", name: "Refresh marker", summary: "Distinguishes initial loading from a background refresh that still shows saved content.",
            source: "GenesisKit/Controls/RefreshingMark.swift", critique: ["Do not blank useful cached content during a refresh.", "The text must say what is being refreshed instead of leaving an unexplained spinner."],
            sections: [CatalogSection("Read state", [
                CatalogVariant("Initial read") { RefreshingMark(showingCache: false, what: "meetings") },
                CatalogVariant("Showing saved content") { RefreshingMark(showingCache: true, what: "meetings") },
                CatalogVariant("Regular size") { RefreshingMark(showingCache: true, what: "transcript", size: .regular) },
            ])])
    }

    static var skeletons: CatalogEntry {
        CatalogEntry(id: "skeleton", group: "Progress", name: "Loading skeletons", summary: "A stable preview of the layout while content arrives. Bars, rows, transcript and diff shapes share the same treatment.",
            source: "GenesisKit/Controls/Skeleton.swift", critique: ["Match the content's eventual shape so loading does not shift the whole pane.", "Do not animate every placeholder when a static layout cue is enough."],
            sections: [CatalogSection("Content shapes", flow: .column, [
                CatalogVariant("Bars and lines") { VStack(alignment: .leading) { SkeletonBar(width: 180); SkeletonLines(count: 3) }.frame(width: 300) },
                CatalogVariant("Rows with avatars") { SkeletonRows(count: 3, leading: .avatar).frame(width: 320, height: 132) },
                CatalogVariant("Rows with status dots") { SkeletonRows(count: 3, leading: .dot, subtitle: false).frame(width: 320, height: 78) },
                CatalogVariant("Transcript") { TranscriptSkeleton(turns: 2).frame(width: 500, height: 160) },
                CatalogVariant("Diff") { DiffSkeleton(files: 1).frame(width: 500, height: 190) },
                CatalogVariant("Pane") { PaneSkeleton("Reading recording").frame(width: 500, height: 100) },
            ])])
    }

    static var spinningArc: CatalogEntry {
        CatalogEntry(id: "spinning-arc", group: "Progress", name: "Spinning arc", summary: "A compact render-server progress mark that can also remain static.",
            source: "GenesisKit/Controls/SpinningArc.swift", critique: ["Keep the task name visible beside an indeterminate indicator.", "A paused or reduced-motion state must remain recognisable without movement."],
            sections: [CatalogSection("Motion and scale", [
                CatalogVariant("Working") { SpinningArc(color: KitHue.play.ink).frame(width: 18, height: 18) },
                CatalogVariant("Static") { SpinningArc(color: .secondary, spinning: false).frame(width: 18, height: 18) },
                CatalogVariant("Large, thin") { SpinningArc(color: KitHue.ask.ink, lineWidth: 1).frame(width: 32, height: 32) },
            ])])
    }

    static var userAvatar: CatalogEntry {
        CatalogEntry(id: "user-avatar", group: "Identity", name: "User avatar", summary: "An optional image with a stable local fallback. No image request is needed to show a person's identity.",
            source: "GenesisKit/Controls/UserAvatar.swift", critique: ["The fallback must distinguish people while an image loads or is unavailable.", "Identity colour must not be mistaken for an active or failed state."],
            sections: [CatalogSection("Fallback and size", [
                CatalogVariant("Initial") { UserAvatar(url: nil, name: "Alex Example", username: "alex") },
                CatalogVariant("Person glyph") { UserAvatar(url: nil, name: "Alex Example", fallback: .person) },
                CatalogVariant("Large, explicit tint") { UserAvatar(url: nil, name: "Taylor Example", username: "taylor", size: 40, tint: KitHue.ask.ink) },
            ])])
    }
}
