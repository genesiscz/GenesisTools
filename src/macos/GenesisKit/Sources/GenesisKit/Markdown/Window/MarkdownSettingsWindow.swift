import AppKit
import SwiftUI

/// The viewer's Settings window (⌘,): the git integration, with what agent attribution costs. Until 2026-10-24 these
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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 420),
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
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

struct MarkdownSettingsView: View {
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeSettingsCard("Editor", subtitle: "The source view, in Edit and Split.") {
                    NativeSettingsToggle("Suggest links and tags while typing",
                                         detail: "The list of notes opens after [[ and the list of tags after #. Off: press Esc to open it.",
                                         identifier: "markdown.settings.completeWhileTyping", isOn: $configuration.completeWhileTyping)
                }
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
    }
}

/// What attribution costs, under its switch (Martin, 2026-10-24: "make sure the settings warn about these settings").
private struct AttributionCostNote: View {
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
            Text("""
                Each time a repository changes, this runs `tools agents blame` for the notes open in it: one run per \
                repository, at most every 5 seconds, and each run is a GenesisTools launch that macOS checks in. With \
                many notes open in a busy repository, such as a vault that agents write to, it can keep Launch Services \
                and the CPU busy. Turn it off if the Mac feels slow; the gutter keeps working.
                """)
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("markdown.settings.attributionCost")
    }
}
