// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Pomodoro/FocusStatusItem.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import Combine
import SwiftUI

/// Spec 22 (S6) §10.3 — the menu-bar item.
///
/// Title is the remaining time in monospaced digits behind a phase dot, so the glance costs
/// nothing. Clicking opens a small popover with today's totals; right-clicking is the same
/// commands without the stats, for speed.
@MainActor
public final class FocusStatusItem {
    private var item: NSStatusItem?
    private var popover: NSPopover?
    private var cancellables: Set<AnyCancellable> = []

    private let engine: PomodoroEngine
    private let recorder: ActivityRecorder
    private let store: ActivityStore
    private let onOpenStudio: () -> Void
    private let onToggleHUD: () -> Void
    /// Read at show time so the popover can say "Hide HUD" when the HUD is already up.
    public var isHUDVisible: () -> Bool = { false }

    public init(engine: PomodoroEngine, recorder: ActivityRecorder, store: ActivityStore,
         onOpenStudio: @escaping () -> Void, onToggleHUD: @escaping () -> Void) {
        self.engine = engine
        self.recorder = recorder
        self.store = store
        self.onOpenStudio = onOpenStudio
        self.onToggleHUD = onToggleHUD
    }

    public func install(style: String) {
        guard style != "off", item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.setAccessibilityIdentifier("focus-status-item")
        item.button?.target = self
        item.button?.action = #selector(clicked(_:))
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        self.item = item

        // One subscription per published value that actually changes the title. `@Published`
        // has no value-skip, so the render guard lives in `render` itself.
        engine.$remainingSec.sink { [weak self] _ in self?.render(style: style) }.store(in: &cancellables)
        engine.$state.sink { [weak self] _ in self?.render(style: style) }.store(in: &cancellables)
        engine.$phase.sink { [weak self] _ in self?.render(style: style) }.store(in: &cancellables)
        render(style: style)
    }

    public func remove() {
        cancellables.removeAll()
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
        lastTitle = nil
        lastPhase = nil
    }

    // MARK: - Rendering

    private var lastTitle: String?
    private var lastPhase: PomodoroPlan.Phase?

    func render(style: String, into suppliedButton: NSButton? = nil) {
        guard let button = suppliedButton ?? item?.button else { return }
        let dot = engine.state == .idle ? "○" : "●"
        let title = style == "dot" || engine.state == .idle
            ? dot
            : "\(dot) \(FocusHUDView.clock(engine.remainingSec))"
        guard title != lastTitle || engine.phase != lastPhase else { return }
        lastTitle = title
        lastPhase = engine.phase

        let colour: NSColor = switch engine.phase {
        case .flow: NSColor(Color.genAccent)
        case .shortBreak: NSColor(Color.genSuccess)
        case .longBreak: NSColor(Color.genWaiting)
        }
        button.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: engine.state == .idle ? NSColor.secondaryLabelColor : colour,
        ])
    }

    // MARK: - Interaction

    @objc private func clicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu(sender)
        } else {
            togglePopover(sender)
        }
    }

    private func togglePopover(_ sender: NSStatusBarButton) {
        if let popover, popover.isShown {
            popover.performClose(nil)
            return
        }
        let popover = self.popover ?? makePopover()
        // Rebuild the content on every show. A reused NSPopover keeps its hosting controller
        // after it closes, and the SwiftUI graph inside is not re-evaluated on the next show —
        // which is how this popover came back saying "not running" 14 seconds after its own
        // Start button had started a flow. Rebuilding a 320x260 view costs nothing; showing
        // stale state costs trust.
        popover.contentViewController = makeController()
        self.popover = popover
        popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
    }

    private func makePopover() -> NSPopover {
        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 320, height: 300)
        popover.contentViewController = makeController()
        return popover
    }

    private func makeController() -> NSHostingController<FocusStatusPopover> {
        NSHostingController(
            rootView: FocusStatusPopover(engine: engine, recorder: recorder, store: store,
                                         isHUDVisible: isHUDVisible,
                                         onOpenStudio: onOpenStudio, onToggleHUD: onToggleHUD))
    }

    private func showMenu(_ sender: NSStatusBarButton) {
        let menu = NSMenu()
        if engine.state == .idle {
            menu.addItem(withTitle: "Start flow", action: #selector(startFlow), keyEquivalent: "").target = self
        } else {
            let pauseTitle = engine.state == .paused ? "Resume" : "Pause"
            menu.addItem(withTitle: pauseTitle, action: #selector(togglePause), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Skip phase", action: #selector(skip), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Stop", action: #selector(stop), keyEquivalent: "").target = self
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: isHUDVisible() ? "Hide HUD" : "Show HUD",
                     action: #selector(toggleHUD), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open Focus Studio", action: #selector(openStudio), keyEquivalent: "").target = self
        item?.menu = menu
        sender.performClick(nil)
        item?.menu = nil
    }

    @objc private func startFlow() { engine.start(.flow, tag: engine.tag) }
    @objc private func togglePause() { engine.state == .paused ? engine.resume() : engine.pause() }
    @objc private func skip() { engine.skip() }
    @objc private func stop() { engine.stop() }
    @objc private func toggleHUD() { onToggleHUD() }
    @objc private func openStudio() { onOpenStudio() }
}

// MARK: - Popover content

/// Today's numbers plus the phase controls. Reads the store once when it appears and again only
/// when the phase changes, never from a body.
public struct FocusStatusPopover: View {
    @ObservedObject public var engine: PomodoroEngine
    @ObservedObject public var recorder: ActivityRecorder
    public let store: ActivityStore
    public var isHUDVisible: () -> Bool = { false }
    public var onOpenStudio: () -> Void
    public var onToggleHUD: () -> Void

    @State private var summary = FocusDaySummary.empty

    public var body: some View {
        VStack(alignment: .leading, spacing: GenSpacing.md) {
            HStack(spacing: GenSpacing.sm) {
                FocusRing(progress: progress, accent: accent)
                    .frame(width: 44, height: 44)
                    .instantTooltip(engine.state == .idle ? "" : "\(FocusFormat.percent(progress)) of this phase elapsed")
                VStack(alignment: .leading, spacing: 2) {
                    Text(engine.phase.label)
                        .font(GenTypography.headline(15))
                        .foregroundStyle(Color.genTextPrimary)
                    Text(engine.state == .idle ? "not running" : FocusHUDView.clock(engine.remainingSec) + " left")
                        .font(GenTypography.mono(12))
                        .foregroundStyle(Color.genTextSecondary)
                }
                Spacer()
            }

            Divider().overlay(Color.genGlassBorder)

            VStack(alignment: .leading, spacing: GenSpacing.xs) {
                summaryRow("Focused", FocusFormat.duration(summary.focusedMs))
                summaryRow("Sessions", "\(summary.sessionsDone)")
                summaryRow("Switches", "\(summary.switches)")
            }

            if !summary.topApps.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(summary.topApps) { app in
                        HStack(spacing: GenSpacing.xs) {
                            AppIcon(bundleId: app.bundleId, size: 14)
                            Text(app.appName)
                                .font(GenTypography.caption(11))
                                .foregroundStyle(Color.genTextSecondary)
                                .lineLimit(1)
                            Spacer()
                            Text(FocusFormat.duration(app.ms))
                                .font(GenTypography.mono(11))
                                .foregroundStyle(Color.genTextTertiary)
                        }
                    }
                }
            }

            Spacer(minLength: 0)

            VStack(spacing: GenSpacing.sm) {
                // The primary action is a filled button, not a word. The previous version drew
                // three bare labels and read as a caption.
                Button {
                    switch engine.state {
                    case .idle: engine.start(.flow, tag: engine.tag)
                    case .paused: engine.resume()
                    case .running, .overrun: engine.pause()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: engine.state == .running || engine.state == .overrun
                              ? "pause.fill" : "play.fill")
                            .font(.system(size: 10, weight: .bold))
                        Text(primaryLabel)
                            .font(GenTypography.body(13, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous)
                        .fill(accent.opacity(0.18)))
                    .overlay(RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous)
                        .strokeBorder(accent.opacity(0.45), lineWidth: 1))
                    .foregroundStyle(accent)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityIdentifier("focus-popover-primary")

                HStack(spacing: GenSpacing.sm) {
                    secondary(isHUDVisible() ? "Hide timer window" : "Show timer window",
                              symbol: isHUDVisible() ? "eye.slash" : "macwindow.on.rectangle",
                              id: "focus-popover-hud") { onToggleHUD() }
                    secondary("Studio", symbol: "chart.bar", id: "focus-popover-studio") { onOpenStudio() }
                        .instantTooltip("Open Focus Studio")
                }

                if engine.state != .idle {
                    Button("Stop") { engine.stop() }
                        .buttonStyle(.genHoverPlain())
                        .font(GenTypography.caption(11))
                        .foregroundStyle(Color.genTextTertiary)
                        .accessibilityIdentifier("focus-popover-stop")
                        .instantTooltip("End this phase and stop the timer")
                }
            }
        }
        .padding(GenSpacing.lg)
        .frame(width: 320, height: 300, alignment: .topLeading)
        .background(Color.genBackground)
        .task(id: engine.state) { summary = FocusDaySummary.today(store: store) }
        .accessibilityIdentifier("focus-status-popover")
    }

    private var accent: Color {
        switch engine.phase {
        case .flow: return .genAccent
        case .shortBreak: return .genSuccess
        case .longBreak: return .genWaiting
        }
    }

    private var primaryLabel: String {
        switch engine.state {
        case .idle: return "Start \(FocusFormat.duration(Int64(engine.plan.flowSec) * 1000)) flow"
        case .paused: return "Resume"
        case .running, .overrun: return "Pause"
        }
    }

    private func secondary(_ title: String, symbol: String, id: String,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 10))
                Text(title).font(GenTypography.caption(11, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous)
                .fill(Color.genGlassFill))
            .foregroundStyle(Color.genTextSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .accessibilityIdentifier(id)
    }

    private var progress: Double {
        let planned = Double(max(1, engine.plan.duration(of: engine.phase)))
        return min(1, max(0, 1 - Double(engine.remainingSec) / planned))
    }

    private func summaryRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(GenTypography.caption(11))
                .foregroundStyle(Color.genTextTertiary)
            Spacer()
            Text(value)
                .font(GenTypography.mono(12))
                .foregroundStyle(Color.genTextPrimary)
        }
    }
}

/// A progress ring with no animation of its own: it redraws when `progress` changes, which is
/// once a second at most.
public struct FocusRing: View {
    public var progress: Double
    public var accent: Color

    public var body: some View {
        ZStack {
            Circle().strokeBorder(Color.genGlassBorder, lineWidth: 3)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
    }
}
