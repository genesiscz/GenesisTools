import AppKit
import SwiftUI

/// "Draft an issue": the title and body exactly as they will be posted, the body editable beside its rendered preview,
/// so the person can read and redact it first. Post issue runs `tools github issues post`; the window then shows
/// Posting…, the link (Copy link to the issue, Open in <browser>), or the error with Try again.
public struct IssueDraftView: View {
    @ObservedObject var model: IssueDraftModel
    let close: () -> Void
    @FocusState private var titleFocused: Bool

    public init(model: IssueDraftModel, close: @escaping () -> Void) {
        self.model = model
        self.close = close
    }

    private var editable: Bool {
        if case .posted = model.state { return false }
        return model.state != .posting
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: "New issue in \(model.draft.repo)")
                    .font(.system(size: 14, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                Text("This is exactly what will be posted. Remove anything private before you post it.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(KitPalette.dim)
            }
            TextField("Title", text: $model.draft.title)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13))
                .focused($titleFocused)
                .disabled(!editable)
                .accessibilityIdentifier("issue-draft.title")
            HStack(alignment: .top, spacing: 12) {
                pane("Markdown") {
                    TextEditor(text: $model.draft.body)
                        .font(.system(size: 11.5, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .disabled(!editable)
                        .accessibilityIdentifier("issue-draft.body")
                }
                pane("Preview") {
                    ScrollView {
                        MarkdownContentView(markdown: model.draft.body, style: FailureNoticeView.style)
                            .padding(10)
                            .scrollOverflowContent()
                    }
                    .scrollOverflowHints()
                }
            }
            .frame(maxHeight: .infinity)
            footer
        }
        .padding(18)
        .frame(minWidth: 600, minHeight: 400)
        .onAppear { DispatchQueue.main.async { titleFocused = true } }
    }

    private func pane<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(KitPalette.dim)
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.black.opacity(0.22)))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.white.opacity(0.1)))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var footer: some View {
        switch model.state {
        case .editing, .posting, .failed:
            VStack(alignment: .leading, spacing: 8) {
                if case let .failed(message) = model.state {
                    Label {
                        Text(verbatim: "Not posted: \(message)").fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(KitPalette.removed)
                    }
                    .font(.system(size: 12))
                    .accessibilityIdentifier("issue-draft.error")
                }
                HStack(spacing: 10) {
                    Toggle("Redact personal data and secrets before posting", isOn: $model.draft.redact)
                        .toggleStyle(.checkbox)
                        .font(.system(size: 12))
                        .disabled(!editable)
                        .instantTooltip("Home folders, emails, tokens, keys and the names on this Mac's private list become placeholders")
                        .accessibilityIdentifier("issue-draft.redact")
                    Spacer(minLength: 8)
                    if model.state == .posting {
                        ProgressView().controlSize(.small)
                        Text("Posting…").font(.system(size: 12)).foregroundStyle(KitPalette.dim)
                    }
                    Button("Cancel", action: close)
                        .keyboardShortcut(.cancelAction)
                        .disabled(model.state == .posting)
                        .accessibilityIdentifier("issue-draft.cancel")
                    Button {
                        Task { await model.post() }
                    } label: {
                        Text(isFailed ? "Try again" : "Post issue").font(.system(size: 12.5))
                    }
                    .buttonStyle(.genPrimary())
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.canPost)
                    .instantTooltip(model.canPost ? "Open the issue on GitHub (⌘↩)" : "The issue needs a title and a body")
                    .accessibilityIdentifier("issue-draft.post")
                }
            }
        case let .posted(result):
            posted(result)
        }
    }

    private var isFailed: Bool {
        if case .failed = model.state { return true }
        return false
    }

    private func posted(_ result: IssuePostResult) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(KitPalette.added)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                if let url = result.url {
                    Text(verbatim: "Posted issue #\(result.number.map(String.init) ?? "?")").font(.system(size: 12.5, weight: .semibold))
                    Text(verbatim: url).font(.system(size: 11, design: .monospaced)).foregroundStyle(KitPalette.dim)
                        .textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                } else {
                    Text("Dry run: nothing was posted").font(.system(size: 12.5, weight: .semibold))
                }
                if result.replaced > 0 {
                    Text(verbatim: "\(Plural.count(result.replaced, "value")) redacted")
                        .font(.system(size: 11)).foregroundStyle(KitPalette.dim)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("issue-draft.posted")
            Spacer(minLength: 8)
            if result.url != nil {
                GhostButton(model.copied ? "Copied" : "Copy link to the issue", symbol: model.copied ? "checkmark" : "link",
                            tooltip: "Copy the issue's address", identifier: "issue-draft.copy-link") { model.copyLink() }
                GhostButton(model.browserName.map { "Open in \($0)" } ?? "Open in browser", symbol: "safari",
                            tooltip: "Open the issue where a click on its link opens", identifier: "issue-draft.open") {
                    model.openLink()
                }
            }
            Button("Done", action: close)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("issue-draft.done")
        }
    }
}

/// The draft in its own titled, resizable panel that takes the keyboard without activating the app.
@MainActor
public final class IssueDraftWindow: NSObject, NSWindowDelegate {
    private static var current: IssueDraftWindow?

    public let panel: IssueDraftPanel
    public let model: IssueDraftModel

    /// Opens the draft beside `near` (the failure notice), or centred on the pointer's screen.
    @discardableResult
    public static func show(_ draft: IssueDraft, poster: IssuePosting, near: NSWindow? = nil) -> IssueDraftWindow {
        current?.panel.orderOut(nil)
        let window = IssueDraftWindow(model: IssueDraftModel(draft: draft, poster: poster))
        current = window
        window.place(near: near)
        window.panel.makeKeyAndOrderFront(nil)
        return window
    }

    public init(model: IssueDraftModel) {
        self.model = model
        panel = IssueDraftPanel(contentRect: CGRect(x: 0, y: 0, width: 880, height: 620),
                                styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "Draft an issue"
        panel.identifier = NSUserInterfaceItemIdentifier("issue.draft")
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.contentMinSize = CGSize(width: 620, height: 420)
        panel.setFrameAutosaveName("issue.draft")
        panel.contentView = NSHostingView(rootView: IssueDraftView(model: model) { [weak self] in self?.close() }
            .environment(\.colorScheme, .dark))
        panel.onCancel = { [weak self] in self?.close() }
        panel.delegate = self
    }

    private func place(near: NSWindow?) {
        guard !panel.setFrameUsingName("issue.draft") else { return }
        let screen = near?.screen ?? NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let size = panel.frame.size
        panel.setFrameOrigin(CGPoint(x: (visible.midX - size.width / 2).rounded(),
                                     y: (visible.maxY - visible.height * 0.15 - size.height).rounded()))
    }

    func close() {
        guard model.state != .posting else { return }
        panel.orderOut(nil)
        if Self.current === self { Self.current = nil }
    }

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }
}

/// Takes the keyboard (the title and body are typed in) and the standard editing shortcuts; Escape closes it.
public final class IssueDraftPanel: EditingPanel {
    var onCancel: (() -> Void)?

    override public var canBecomeKey: Bool { true }
    override public var canBecomeMain: Bool { false }

    override public func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}
