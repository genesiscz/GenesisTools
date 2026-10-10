import AppKit
import SwiftUI

/// The dialog's content: the app icon with the grant's symbol, what is needed and why, what to do, and the actions.
/// Laid out like a macOS alert: icon on the leading side, text, buttons on the trailing edge with the default last.
public struct PermissionDialogView: View {
    @ObservedObject var model: PermissionDialogModel

    public init(model: PermissionDialogModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 14) {
                icon
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.title)
                        .font(.system(size: 13, weight: .semibold))
                        .accessibilityAddTraits(.isHeader)
                    if model.phase != .granted {
                        Text(model.reason)
                            .font(.system(size: 12))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(model.instructions)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    status
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if model.phase != .granted {
                buttons
            }
        }
        .padding(20)
        .frame(width: 420)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("permission-dialog-\(model.kind.rawValue)")
    }

    private var icon: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(nsImage: NSApp?.applicationIconImage ?? NSImage())
                .resizable()
                .frame(width: 52, height: 52)
            Group {
                if model.phase == .granted {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.white, .green)
                } else {
                    Image(systemName: model.kind.symbol)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Color.accentColor))
                }
            }
            .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
            .offset(x: 4, y: 4)
        }
        .frame(width: 56, height: 56, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var status: some View {
        if let note = model.note {
            Label(note, systemImage: "exclamationmark.circle")
                .font(.system(size: 11))
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
                .accessibilityIdentifier("permission-note")
        } else if model.phase == .waiting || model.phase == .working || model.checking {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(model.phase == .working ? "Waiting for macOS…" : "Waiting for the grant…")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 2)
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Button("Not now", action: model.dismiss)
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("permission-not-now")
            if model.offersCheckAgain {
                Button("Check again", action: model.checkAgain)
                    .disabled(model.checking)
                    .accessibilityIdentifier("permission-check-again")
            }
            Button(model.primaryTitle, action: model.primary)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(model.phase == .working || model.status == .restricted)
                .accessibilityIdentifier("permission-primary")
        }
        .controlSize(.regular)
    }
}

/// The real presenter: one small floating panel per dialog. It never blocks the app (no modal session), stays above
/// the widget's panels, follows the user to the active Space, and takes keyboard focus only for a user's own action.
@MainActor
public final class PermissionPanelPresenter: NSObject, PermissionPresenting, NSWindowDelegate {
    private var panels: [PermissionKind: NSPanel] = [:]
    private var models: [ObjectIdentifier: PermissionDialogModel] = [:]

    public override init() {}

    public func present(_ dialog: PermissionDialogModel, takesFocus: Bool) {
        if NSApp == nil { _ = NSApplication.shared }
        // The content runs under the transparent title bar, so the strip still drags the panel (the window root's
        // `.titlebarZone()`, as every window here has). The panel is not resizable: a double-click zooms nothing.
        let host = NSHostingView(rootView: PermissionDialogView(model: dialog).titlebarZone())
        let size = host.fittingSize
        let panel = PermissionPanel(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.title = dialog.title
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        // After isFloatingPanel, whose setter resets the level: above the top notch (.statusBar) and side panel.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.animationBehavior = .alertPanel
        panel.contentView = host
        panel.delegate = self
        panel.setAccessibilityIdentifier("permission-dialog-\(dialog.kind.rawValue)")
        panel.setFrameOrigin(origin(for: size))
        panels[dialog.kind] = panel
        models[ObjectIdentifier(panel)] = dialog
        if takesFocus {
            panel.makeKeyAndOrderFront(nil)
        } else {
            panel.orderFrontRegardless()
        }
    }

    public func bringToFront(_ dialog: PermissionDialogModel) {
        panels[dialog.kind]?.orderFrontRegardless()
    }

    public func close(_ dialog: PermissionDialogModel) {
        guard let panel = panels.removeValue(forKey: dialog.kind) else { return }
        models[ObjectIdentifier(panel)] = nil
        panel.delegate = nil
        panel.orderOut(nil)
    }

    /// ⌘W closes the dialog the way "Not now" does.
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        models[ObjectIdentifier(sender)]?.dismiss()
        return false
    }

    /// Horizontally centred in the upper third of the screen under the pointer, as macOS places an alert; each
    /// further open dialog sits a little lower so none hides another.
    private func origin(for size: CGSize) -> CGPoint {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let cascade = CGFloat(panels.count) * 28
        let top = visible.maxY - visible.height * 0.2 - cascade
        return CGPoint(x: (visible.midX - size.width / 2).rounded(), y: (top - size.height).rounded())
    }
}

/// A titled panel that can take the keyboard without activating its app.
private final class PermissionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
