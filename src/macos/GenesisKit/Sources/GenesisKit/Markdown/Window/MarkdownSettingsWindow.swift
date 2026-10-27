import AppKit
import SwiftUI

/// The viewer's Settings window (⌘,): tabs, hover previews, and the git integration with what agent attribution
/// costs. Tabs and previews joined on 2026-10-25 (UX audit W7): the tab bar's right-click menu had some of these, and
/// preview tabs, hover previews, their delay and the group sizes had no control at all. Until 2026-10-24 these
/// switches existed only as stored defaults, so attribution could not be turned off when its blame runs made the Mac
/// busy (one `tools agents blame` per open note on every repository change, 51 to 66 at once).
@MainActor
public final class MarkdownSettingsWindow: NSObject {
    public static let shared = MarkdownSettingsWindow()
    private var window: NSWindow?

    @objc public func show(_ sender: Any?) {
        if let window {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 640),
                              styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Settings"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MarkdownSettingsView(configuration: .shared).titlebarZone())
        window.center()
        window.setFrameAutosaveName("markdown.settings")
        self.window = window
        window.makeKeyAndOrderFront(nil)
    }
}

extension Notification.Name {
    static let markdownSplitSyncChanged = Notification.Name("markdownSplitSyncChanged")
}

struct MarkdownSettingsView: View {
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration
    @ObservedObject private var highlight = NativeSettingsHighlightCenter.shared
    @AppStorage("markdown.config.treeNotesOnly") private var notesOnly = true
    @AppStorage("markdownWindow.splitScrollSync") private var splitScrollSync = true

    init(configuration: GenesisKitMarkdownConfiguration) {
        self.configuration = configuration
    }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                MarkdownTabSettingsCard(configuration: configuration)
                MarkdownPreviewSettingsCard(configuration: configuration)
                MarkdownShareSettingsCard(configuration: configuration)
                NativeSettingsCard("Editor", subtitle: "The source view, in Edit and Split.") {
                    NativeSettingsToggle("Suggest links and tags while typing",
                                         detail: "The list of notes opens after [[ and the list of tags after #. Off: press Esc to open it.",
                                         identifier: "markdown.settings.completeWhileTyping", isOn: $configuration.completeWhileTyping)
                    Divider()
                    NativeSettingsToggle("Sync split scrolling", detail: "The editor and preview follow each other while scrolling.",
                                         identifier: "markdown.settings.splitScrollSync", isOn: $splitScrollSync)
                }
                NativeSettingsCard("File sidebar", subtitle: "Choose which files the sidebar shows.") {
                    NativeSettingsToggle("Show only notes", detail: "Hide other files while keeping folders visible.",
                                         identifier: "markdown.settings.treeNotesOnly", isOn: $notesOnly)
                }
                .id("markdown-file-sidebar")
                .nativeSettingsAnchor("markdown-file-sidebar")
                NativeSettingsCard("Git", subtitle: "Shown for notes inside a git repository.") {
                    NativeSettingsToggle("Git integration",
                                         detail: "The file's state, the gutter, the Changes mode, the history and the tree marks.",
                                         identifier: "markdown.settings.git", isOn: $configuration.git)
                    Divider()
                    NativeSettingsToggle("Changed-line gutter", detail: "Bars beside the lines that differ from HEAD.",
                                         identifier: "markdown.settings.gitGutter", isOn: $configuration.gitGutter)
                        .disabled(!configuration.git)
                    Divider()
                    NativeSettingsToggle("File tree marks", detail: "M, A, U and D on rows and tabs, a dot on folders with changes.",
                                         identifier: "markdown.settings.gitTreeDecorations", isOn: $configuration.gitTreeDecorations)
                        .disabled(!configuration.git)
                    Divider()
                    NativeSettingsToggle(
                        "Agent attribution",
                        detail: "Names the agent session and turn that wrote each changed line, on the gutter card and in the Changes mode.",
                        identifier: "markdown.settings.gitAgentAttribution", isOn: $configuration.gitAgentAttribution)
                        .disabled(!configuration.git || !configuration.gitGutter)
                    AttributionCostNote()
                }
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 380)
        .onAppear {
            if highlight.anchor == "markdown-file-sidebar" { proxy.scrollTo("markdown-file-sidebar") }
        }
        .onChange(of: highlight.token) { _, _ in
            if highlight.anchor == "markdown-file-sidebar" { proxy.scrollTo("markdown-file-sidebar") }
        }
        .onChange(of: splitScrollSync) { _, enabled in
            NotificationCenter.default.post(name: .markdownSplitSyncChanged, object: enabled)
        }
        }
    }
}

/// Tabs: how they flow, the preview tab, and the grouping rule with its sizes. The same keys as the tab bar's menu.
struct MarkdownTabSettingsCard: View {
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration

    var body: some View {
        let grouping = configuration.tabGrouping != .off
        NativeSettingsCard("Tabs", subtitle: "The row of open files above the page.") {
            NativeSettingsToggle("Preview tabs",
                                 detail: "A single click in the file sidebar opens an italic tab that the next click replaces. A double-click or an edit keeps it.",
                                 identifier: "markdown.settings.previewTabs", isOn: $configuration.previewTabs)
            Divider()
            NativeSettingsToggle("Wrap tabs", detail: "Tabs go onto more rows instead of scrolling sideways.",
                                 identifier: "markdown.settings.wrapTabs", isOn: $configuration.wrapTabs)
            Divider()
            NativeSettingsRow("Wrapped tabs show",
                              detail: configuration.wrapTabs ? "More rows scroll, with a fade at the edge." : "Needs Wrap tabs.") {
                Picker("Wrapped tabs show", selection: $configuration.wrapTabsMaxRows) {
                    Text("2 rows").tag(2)
                    Text("4 rows").tag(4)
                    Text("6 rows").tag(6)
                    Text("Every row").tag(0)
                }
                .labelsHidden().fixedSize()
                .accessibilityIdentifier("markdown.settings.wrapTabsMaxRows")
            }
            .disabled(!configuration.wrapTabs)
            Divider()
            NativeSettingsRow("Group tabs by", detail: "With many tabs open, tabs fall into groups with a chip that folds them.") {
                Picker("Group tabs by", selection: $configuration.tabGrouping) {
                    ForEach(MarkdownTabGroupRule.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .labelsHidden().fixedSize()
                .accessibilityIdentifier("markdown.settings.tabGrouping")
            }
            Divider()
            NativeSettingsRow("Group from", detail: grouping ? "Fewer open tabs stay one plain row." : "Needs Group tabs by.") {
                Picker("Group from", selection: $configuration.tabGroupFrom) {
                    Text("Always").tag(0)
                    Text("6 open tabs").tag(6)
                    Text("10 open tabs").tag(10)
                    Text("20 open tabs").tag(20)
                }
                .labelsHidden().fixedSize()
                .accessibilityIdentifier("markdown.settings.tabGroupFrom")
            }
            .disabled(!grouping)
            Divider()
            NativeSettingsRow("Smallest group",
                              detail: grouping ? "A group with fewer tabs joins Other." : "Needs Group tabs by.") {
                stepper("Smallest group", value: $configuration.tabGroupMinimum, in: 1...10, unit: "tab",
                        identifier: "markdown.settings.tabGroupMinimum")
            }
            .disabled(!grouping)
            Divider()
            NativeSettingsRow("Split a project group above",
                              detail: configuration.tabGrouping == .smart ? "A Project group with more tabs splits by its next folder." : "Needs Group tabs by Project.") {
                stepper("Split a project group above", value: $configuration.tabGroupSplitAbove, in: 4...60, unit: "tab",
                        identifier: "markdown.settings.tabGroupSplitAbove")
            }
            .disabled(configuration.tabGrouping != .smart)
            Divider()
            NativeSettingsToggle("Each group on its own rows",
                                 detail: configuration.wrapTabs && grouping ? "Wrapped tabs start a new row for each open group." : "Needs Wrap tabs and Group tabs by.",
                                 identifier: "markdown.settings.tabGroupRows", isOn: $configuration.tabGroupRows)
                .disabled(!configuration.wrapTabs || !grouping)
        }
    }

    private func stepper(_ title: String, value: Binding<Int>, in range: ClosedRange<Int>, unit: String,
                         identifier: String) -> some View {
        Stepper(value: value, in: range) {
            Text(verbatim: "\(value.wrappedValue) \(value.wrappedValue == 1 ? unit : unit + "s")")
                .font(.system(size: 12)).monospacedDigit()
        }
        .fixedSize()
        .accessibilityLabel(title)
        .accessibilityValue("\(value.wrappedValue)")
        .accessibilityIdentifier(identifier)
    }
}

/// Sharing and export: where a share link opens, and whether a saved PDF brings Finder forward (UX audit D11, D12).
struct MarkdownShareSettingsCard: View {
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration

    var body: some View {
        NativeSettingsCard("Sharing and export", subtitle: "The Share and PDF buttons in the toolbar.") {
            NativeSettingsRow("Open share links in",
                              detail: "The link is always copied. Brave falls back to the system browser when it is not installed.") {
                Picker("Open share links in", selection: $configuration.shareOpensIn) {
                    ForEach(MarkdownShareBrowser.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .labelsHidden().fixedSize()
                .accessibilityIdentifier("markdown.settings.shareOpensIn")
            }
            Divider()
            NativeSettingsToggle("Show a saved PDF in Finder",
                                 detail: "Finder comes to the front with the file selected. Off: a note says where it was saved.",
                                 identifier: "markdown.settings.revealSavedPDF", isOn: $configuration.revealSavedPDF)
        }
    }
}

/// Hover previews: a floating preview of a note after the pointer rests on a link or a tab, and how long it waits.
struct MarkdownPreviewSettingsCard: View {
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration

    var body: some View {
        NativeSettingsCard("Previews", subtitle: "What resting the pointer on a link or a tab shows.") {
            NativeSettingsToggle("Hover previews",
                                 detail: "A floating preview of the note opens when the pointer rests on a link or a tab.",
                                 identifier: "markdown.settings.hoverPreview", isOn: $configuration.hoverPreview)
            Divider()
            NativeSettingsSlider("Hover delay",
                                 detail: configuration.hoverPreview ? "How long the pointer rests before the preview opens." : "Needs Hover previews.",
                                 identifier: "markdown.settings.hoverPreviewDelay",
                                 value: $configuration.hoverPreviewDelay, in: 0.2...3, step: 0.1,
                                 ticks: [0.5, 1, 1.5, 2, 2.5], width: 180,
                                 format: { String(format: "%.1f s", $0) })
                .disabled(!configuration.hoverPreview)
        }
    }
}

/// What attribution costs, under its switch (Martin, 2026-10-24: "make sure the settings warn about these settings").
private struct AttributionCostNote: View {
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
            // What happens, in plain words; the command it runs is in the log (UX audit W26).
            Text("""
                Each time a repository changes, this looks up which agent wrote each changed line of the notes open \
                in it, at most every 5 seconds. With many notes open in a busy repository, such as a vault that \
                agents write to, it can slow the Mac down. Turn it off if the Mac feels slow; the gutter keeps working.
                """)
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("markdown.settings.attributionCost")
    }
}
