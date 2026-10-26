import AppKit
import SwiftUI

/// One line of an approval request: a short label and its value. `help` holds the full text when the value is cut.
public struct ApprovalFact: Identifiable, Equatable {
    public let label: String
    public let value: String
    public let help: String?
    public let monospaced: Bool

    public var id: String { label }

    public init(_ label: String, _ value: String, help: String? = nil, monospaced: Bool = false) {
        self.label = label
        self.value = value
        self.help = help
        self.monospaced = monospaced
    }
}

/// How long an allow is remembered; `seconds` 0 is "just this once", nil is "always" (until revoked).
public struct ApprovalRemember: Identifiable, Hashable {
    public let seconds: Int?
    public let title: String

    public var id: String { title }

    public init(seconds: Int?, title: String) {
        self.seconds = seconds
        self.title = title
    }
}

/// A request only the user may allow (a secret handed to another program): why first, then who, then the details
/// behind a disclosure. The answer arrives once, through `onAllow` or `onDeny`.
@MainActor
public final class ApprovalDialogModel: ObservableObject {
    public let title: String
    public let purpose: String
    /// The command line the request runs, shown as a code block under the purpose.
    public let command: String?
    public let symbol: String
    public let facts: [ApprovalFact]
    public let details: [ApprovalFact]
    public let warning: String?
    public let footnote: String
    public let rememberChoices: [ApprovalRemember]
    public let rememberNote: String?
    public let allowTitle: String
    public let deadline: Date?
    public let identifier: String

    @Published public var rememberIndex = 0
    @Published public var showsDetails = false
    @Published public private(set) var answered = false

    public var onAllow: @MainActor (ApprovalRemember?) -> Void = { _ in }
    public var onDeny: @MainActor () -> Void = {}

    public init(title: String, purpose: String, command: String? = nil, symbol: String, facts: [ApprovalFact], details: [ApprovalFact],
                warning: String?, footnote: String, rememberChoices: [ApprovalRemember], rememberNote: String?,
                allowTitle: String, deadline: Date?, identifier: String) {
        self.title = title
        self.purpose = purpose
        self.command = command
        self.symbol = symbol
        self.facts = facts
        self.details = details
        self.warning = warning
        self.footnote = footnote
        self.rememberChoices = rememberChoices
        self.rememberNote = rememberNote
        self.allowTitle = allowTitle
        self.deadline = deadline
        self.identifier = identifier
    }

    public func allow() {
        guard !answered else { return }
        answered = true
        onAllow(rememberChoices.indices.contains(rememberIndex) ? rememberChoices[rememberIndex] : nil)
    }

    public func deny() {
        guard !answered else { return }
        answered = true
        onDeny()
    }
}

/// Laid out like a macOS alert: the app icon with the request's symbol, a short title, the reason as the first line a
/// reader sees, a column of facts, the rest folded, and the buttons on the trailing edge with the default last.
public struct ApprovalDialogView: View {
    @ObservedObject package var model: ApprovalDialogModel

    public init(model: ApprovalDialogModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                icon
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.title)
                        .font(.system(size: 13, weight: .semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text(model.purpose)
                        .font(.system(size: 12))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    if let command = model.command {
                        ApprovalCommandText(command: command).padding(.top, 3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            facts(model.facts)
                .padding(.leading, 66)

            GenDisclosure(isExpanded: $model.showsDetails, minHeight: 22, identifier: "\(model.identifier)-details") {
                facts(model.details)
                    .padding(.leading, 18)
                    .padding(.top, 2)
            } label: {
                Text("Details")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, 66)

            if let warning = model.warning {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 66)
                    .accessibilityIdentifier("\(model.identifier)-warning")
            }

            Text(model.footnote)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 66)

            remember
            buttons
        }
        .padding(20)
        .frame(width: 480)
        // The hosting controller insets its content by the hidden title bar; the strip stays draggable through
        // `.titlebarZone()`, so the dialog uses the full height (Martin's screenshot showed an empty band on top).
        .ignoresSafeArea()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(model.identifier)
    }

    private var icon: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(nsImage: NSApp?.applicationIconImage ?? NSImage())
                .resizable()
                .frame(width: 52, height: 52)
            Image(systemName: model.symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.orange))
                .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
                .offset(x: 4, y: 4)
        }
        .frame(width: 56, height: 56, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private func facts(_ rows: [ApprovalFact]) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 5) {
            ForEach(rows) { fact in
                GridRow {
                    Text(fact.label)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .gridColumnAlignment(.trailing)
                    Text(verbatim: fact.value)
                        .font(fact.monospaced ? .system(size: 11, design: .monospaced) : .system(size: 12))
                        .lineLimit(3)
                        .truncationMode(.middle)
                        // Without it the grid measured one line and cut a path in the middle while the window had room.
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .help(fact.help ?? fact.value)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// Its own row, so the buttons keep their full titles (the first layout cut "Allow with Touch ID" short).
    @ViewBuilder
    private var remember: some View {
        if model.rememberChoices.count > 1 {
            HStack(spacing: 8) {
                Text("Remember")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Picker("Remember", selection: $model.rememberIndex) {
                    ForEach(model.rememberChoices.indices, id: \.self) { index in
                        Text(model.rememberChoices[index].title).tag(index)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
                .accessibilityIdentifier("\(model.identifier)-remember")
            }
            .padding(.leading, 66)
            .disabled(model.answered)
            .environment(\.controlActiveState, .key)
        } else if let note = model.rememberNote {
            Label(note, systemImage: "clock.badge.xmark")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.leading, 66)
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            if let deadline = model.deadline {
                (Text("Denies itself in ") + Text(timerInterval: Date()...max(Date(), deadline), countsDown: true))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            Button("Deny", action: model.deny)
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("\(model.identifier)-deny")
            Button(model.allowTitle, action: model.allow)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .fixedSize()
                .accessibilityIdentifier("\(model.identifier)-allow")
        }
        .controlSize(.regular)
        .disabled(model.answered)
        // The panel is non-activating, so its app is never active while it shows; AppKit then greys the prominent
        // button and the main action looks like the others (the permission dialog's live check, 2026-10-10).
        .environment(\.controlActiveState, .key)
    }
}

/// One floating panel for one request. It never runs a modal session (a modal loop on the main queue stops every
/// timer queued there, so a deadline never fired), never activates its app, and takes the keyboard only after the
/// user clicks into it: a request that pops up while someone types must not catch a stray Return. So that it is not
/// missed, it plays a sound and speaks to VoiceOver when it appears, and a notification follows while it waits
/// (`ApprovalAttention`, both settings).
@MainActor
public final class ApprovalPanelPresenter: NSObject, NSWindowDelegate {
    private var panel: NSPanel?
    private var model: ApprovalDialogModel?
    private var reminder: ApprovalReminder?

    public override init() {}

    public func present(_ model: ApprovalDialogModel) {
        if NSApp == nil { _ = NSApplication.shared }
        let controller = NSHostingController(rootView: ApprovalDialogView(model: model).titlebarZone())
        // The panel follows the view's size, so opening Details grows it and closing shrinks it back.
        controller.sizingOptions = [.preferredContentSize]
        let size = controller.view.fittingSize
        let panel = ApprovalPanel(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.title = model.title
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        // After isFloatingPanel, whose setter resets the level: above the widget's panels, as the permission dialog.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.animationBehavior = .alertPanel
        panel.contentViewController = controller
        panel.delegate = self
        panel.setAccessibilityIdentifier(model.identifier)
        panel.setFrameOrigin(Self.origin(for: size))
        self.panel = panel
        self.model = model
        panel.orderFrontRegardless()
        let reminder = ApprovalReminder(model: model) { [weak self] in self?.bringForward() }
        self.reminder?.stop()
        self.reminder = reminder
        reminder.start()
    }

    public func close() {
        reminder?.stop()
        reminder = nil
        panel?.delegate = nil
        panel?.orderOut(nil)
        panel = nil
    }

    /// A click on the reminder: the panel moves to the screen under the pointer and comes to the front, still without
    /// taking the keyboard.
    private func bringForward() {
        guard let panel, model?.answered == false else { return }
        panel.setFrameOrigin(Self.origin(for: panel.frame.size))
        panel.orderFrontRegardless()
    }

    /// ⌘W answers the way Deny does.
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        model?.deny()
        return false
    }

    /// Horizontally centred in the upper fifth of the screen under the pointer, where macOS puts an alert.
    private static func origin(for size: CGSize) -> CGPoint {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let top = visible.maxY - visible.height * 0.2
        return CGPoint(x: (visible.midX - size.width / 2).rounded(), y: (top - size.height).rounded())
    }
}

/// A titled panel that can take the keyboard without activating its app.
private final class ApprovalPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
