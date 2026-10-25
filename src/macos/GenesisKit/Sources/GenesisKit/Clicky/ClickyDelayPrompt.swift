import AppKit
import SwiftUI

/// The prompt Clicky shows when its output is late (an AirPlay HomePod is about 2 s late): a small panel at the top
/// right of the screen under the pointer. It never takes the keyboard (a non-activating panel ordered front without
/// becoming key), and it closes by itself after `holdSeconds`.
@MainActor
final class ClickyDelayPrompt {
    static let shared = ClickyDelayPrompt()
    static let holdSeconds: TimeInterval = 45

    private var panel: NSPanel?
    private var generation = 0

    func show(late: AudioOutputDevice, suggestion: AudioOutputDevice, reduceMotion: Bool,
              onSwitch: @escaping () -> Void, onKeep: @escaping () -> Void) {
        generation += 1
        let shown = generation
        let view = ClickyDelayPromptView(
            late: late, suggestion: suggestion,
            onSwitch: { [weak self] in onSwitch(); self?.close(shown) },
            onKeep: { [weak self] in onKeep(); self?.close(shown) },
            onClose: { [weak self] in self?.close(shown) })
        let host = NSHostingView(rootView: view)
        let panel = self.panel ?? Self.makePanel()
        self.panel = panel
        panel.contentView = host
        let size = host.fittingSize
        let pointer = NSEvent.mouseLocation
        let screen = (NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main)?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrame(CGRect(x: screen.maxX - size.width - 16, y: screen.maxY - size.height - 12,
                              width: size.width, height: size.height), display: true)
        panel.alphaValue = reduceMotion ? 1 : 0
        panel.orderFrontRegardless()
        if !reduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                panel.animator().alphaValue = 1
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdSeconds) { [weak self] in
            MainActor.assumeIsolated { self?.close(shown) }
        }
    }

    private func close(_ shown: Int) {
        guard shown == generation, let panel else { return }
        panel.orderOut(nil)
        panel.contentView = nil
    }

    private static func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
                            defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .canJoinAllSpaces]
        return panel
    }
}

struct ClickyDelayPromptView: View {
    let late: AudioOutputDevice
    let suggestion: AudioOutputDevice
    let onSwitch: () -> Void
    let onKeep: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "speaker.wave.2.bubble.left.fill").foregroundStyle(.orange)
                Text("Clicky sounds \(late.delayText) on \(late.name)")
                    .font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 8)
                IconButton(systemName: "xmark", tooltip: "Close; Clicky asks again after the next restart", action: onClose)
            }
            Text("Every key sound reaches you \(late.delayText). \(suggestion.name) is \(suggestion.delayText). Play Clicky there while the system plays on \(late.name)?")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Keep \(late.name)", action: onKeep)
                    .accessibilityIdentifier("clicky.delay.keep")
                Button("Play there", action: onSwitch)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("clicky.delay.switch")
            }
            .controlSize(.regular)
        }
        .padding(14)
        .frame(width: 360)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.1)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Clicky output is late")
    }
}
