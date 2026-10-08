import SwiftUI

/// Quick controls over the same runtime used by the full dictation and Focus Studio windows.
/// Visibility never starts a recorder or a timer; the host owns runtime launch and shutdown.
@MainActor
public struct FlowWidget: View {
    @ObservedObject private var runtime: FlowFocusRuntime
    @ObservedObject private var flow: FlowSession
    @ObservedObject private var focus: FocusController
    private let presentation: WidgetModulePresentation
    @State private var hudStyle: FocusHUDStyle = .full

    public init(runtime: FlowFocusRuntime, presentation: WidgetModulePresentation = .expanded) {
        self.runtime = runtime
        flow = runtime.flow
        focus = runtime.focus
        self.presentation = presentation
    }

    public static func module(runtime: FlowFocusRuntime) -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(id: "focus", title: "Flow", symbol: "waveform", tint: .jarvisTeal,
                               expandedSize: CGSize(width: 432, height: 620),
                               summary: { runtime.flow.phase == .listening ? "Listening" : "Dictation & Focus" }) { presentation in
            FlowWidget(runtime: runtime, presentation: presentation)
        }
    }

    public var body: some View {
        Group {
            switch presentation {
            case .compact:
                HStack(spacing: 8) {
                    Image(systemName: flow.phase == .listening ? "waveform" : "mic")
                        .foregroundStyle(Color.jarvisTeal)
                    if flow.phase == .listening {
                        Text("Listening").font(.system(size: 11, weight: .medium))
                    } else if let engine = focus.engine {
                        FlowWidgetClock(engine: engine, compact: true)
                    } else {
                        Text("Flow").font(.system(size: 11, weight: .medium))
                    }
                }
            case .preview:
                VStack(alignment: .leading, spacing: 13) {
                    header
                    dictationControls
                    if let engine = focus.engine {
                        FlowWidgetClock(engine: engine, compact: false)
                    }
                    windowLinks
                }.padding(16)
            case .expanded:
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header
                        dictationCard
                        if let engine = focus.engine, let recorder = focus.recorder {
                            FocusHUDView(engine: engine, recorder: recorder,
                                         onOpenStudio: runtime.showStudio,
                                         onOpenSettings: FlowFocusHost.shared.openSettings,
                                         onToggleStyle: { hudStyle = hudStyle == .full ? .compact : .full },
                                         style: hudStyle,
                                         onPlanChange: focus.updatePlan)
                        }
                        windowLinks
                        if !flow.history.isEmpty { recentDictation }
                        if let error = runtime.lastError ?? flow.lastError ?? focus.lastError {
                            Text(error).font(.system(size: 11)).foregroundStyle(Color.genError)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }.padding(18)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("flow-widget")
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "waveform").foregroundStyle(Color.jarvisTeal)
            Text("Flow").font(.system(size: 15, weight: .semibold))
            Spacer()
            Text("Dictation & Focus").font(.system(size: 10)).foregroundStyle(.secondary)
        }
    }

    private var dictationCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            dictationControls
            FlowWidgetTranscript(recognizer: flow.recognizer, lastText: flow.lastInjected)
            Text("Your words, in the app you were using.")
                .font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.jarvisTeal.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
    }

    private var dictationControls: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Dictation").font(.system(size: 12, weight: .semibold))
                Text(dictationStatus).font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                if flow.phase == .listening { flow.endTurn() }
                else { runtime.beginDictation() }
            } label: {
                Label(flow.phase == .listening ? "Finish" : "Dictate",
                      systemImage: flow.phase == .listening ? "stop.fill" : "mic.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .foregroundStyle(Color.jarvisTeal)
                    .background(Color.jarvisTeal.opacity(0.14), in: Capsule())
            }
            .buttonStyle(.genHoverPlain())
            .disabled(!ready || !flow.labEnabled || !flow.config.enabled || flow.phase == .transcribing || flow.phase == .injecting)
            .accessibilityIdentifier("flow-widget-dictate")
        }
    }

    private var dictationStatus: String {
        if !ready { return "Waiting for Flow" }
        if !flow.labEnabled || !flow.config.enabled { return "Dictation is off in Settings" }
        switch flow.phase {
        case .idle: return FlowKeyNames.describe(keyCode: flow.config.keyCode, modifiers: flow.config.modifiers)
        case .listening: return "Listening…"
        case .transcribing: return "Finishing your words…"
        case .injecting: return "Inserting text…"
        case .error: return "Ready to try again"
        }
    }

    private var ready: Bool {
        switch runtime.role { case .owner, .client: return true; default: return false }
    }

    private var windowLinks: some View {
        HStack(spacing: 12) {
            Button(action: runtime.showDictation) {
                Label("Dictation library", systemImage: "text.alignleft")
            }.accessibilityIdentifier("flow-widget-library")
            Spacer(minLength: 4)
            Button(action: runtime.showStudio) {
                Label("Focus Studio", systemImage: "chart.bar.xaxis")
            }.accessibilityIdentifier("flow-widget-studio")
        }
        .font(.system(size: 11, weight: .medium))
        .buttonStyle(.genHoverPlain())
        .foregroundStyle(Color.jarvisTeal)
    }

    private var recentDictation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("RECENT DICTATION").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
            ForEach(flow.history.prefix(3)) { entry in
                Button { flow.copyEntry(entry) } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Text(entry.text).font(.system(size: 11)).lineLimit(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "doc.on.doc").font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    .padding(10)
                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
                }
                .buttonStyle(.genHoverRow())
                .accessibilityLabel("Copy dictation: " + entry.text)
            }
        }
    }
}

private struct FlowWidgetClock: View {
    @ObservedObject var engine: PomodoroEngine
    let compact: Bool

    var body: some View {
        HStack(spacing: 8) {
            if !compact {
                Image(systemName: "timer").foregroundStyle(Color.genAccent)
                Text(engine.phase.label).font(.system(size: 11))
                Spacer()
            }
            Text(clockText).font(.system(size: compact ? 11 : 16, weight: .medium, design: .monospaced))
                .monospacedDigit()
            if !compact {
                Button {
                    switch engine.state {
                    case .idle: engine.start()
                    case .paused: engine.resume()
                    case .running, .overrun: engine.pause()
                    }
                } label: {
                    Image(systemName: engine.state == .running || engine.state == .overrun ? "pause.fill" : "play.fill")
                        .frame(width: 26, height: 26)
                }.buttonStyle(.genHoverPlain())
                    .accessibilityLabel(engine.state == .running || engine.state == .overrun ? "Pause Focus" : "Start or resume Focus")
            }
        }
    }

    private var clockText: String {
        let seconds = engine.state == .idle ? engine.plan.duration(of: engine.phase) : abs(engine.remainingSec)
        return (engine.remainingSec < 0 ? "+" : "") + String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

private struct FlowWidgetTranscript: View {
    @ObservedObject var recognizer: CompanionSpeechRecognizer
    let lastText: String?

    var body: some View {
        if !recognizer.partialText.isEmpty {
            Text(recognizer.partialText).font(.system(size: 12)).lineLimit(5)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if let lastText, !lastText.isEmpty {
            Text(lastText).font(.system(size: 12)).lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
