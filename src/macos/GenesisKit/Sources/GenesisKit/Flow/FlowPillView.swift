// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowPillView.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import SwiftUI

/// The floating dictation pill.
///
/// Deliberately small and leaf-shaped: it observes the recogniser directly so
/// the speech-rate `micLevel` / `partialText` updates invalidate only this
/// view, not the whole Flow surface. Routing them through `FlowSession` would
/// re-render the history list on every audio buffer.
public struct FlowPillView: View {
    @ObservedObject public var session: FlowSession
    @ObservedObject public var recognizer: CompanionSpeechRecognizer

    /// Drives the idle breathing. A single looping scale, not a shadow and not
    /// a `TimelineView` — both are documented idle-CPU sinks in this repo.
    @State private var breathing = false

    private var accent: Color {
        switch session.phase {
        case .listening: return .jarvisTeal
        case .transcribing: return .neonCyan
        case .injecting: return .genSuccess
        case .error: return .genError
        case .idle: return .genTextTertiary
        }
    }

    private var label: String {
        switch session.phase {
        case .idle: return "Dictate"
        case .listening: return "Listening"
        case .transcribing: return "Transcribing"
        case .injecting: return "Pasting"
        case .error: return "Error"
        }
    }

    public var body: some View {
        VStack(spacing: GenSpacing.sm) {
            // Caption above the pill, matching the reference's floating label.
            Text(label)
                .font(GenTypography.caption(12, weight: .semibold))
                .foregroundStyle(Color.genTextSecondary)
                .padding(.horizontal, GenSpacing.md)
                .padding(.vertical, GenSpacing.xs)
                .background(
                    Capsule().fill(Color.black.opacity(0.75))
                )
                .overlay(
                    Capsule().stroke(Color.genGlassBorder, lineWidth: 1)
                )
                .opacity(session.phase == .idle ? 0.8 : 1)

            HStack(spacing: GenSpacing.md) {
                micButton
                bars
            }
            .padding(.horizontal, GenSpacing.lg)
            .padding(.vertical, GenSpacing.md)
            .background(
                Capsule().fill(Color.black.opacity(0.86))
            )
            .overlay(
                Capsule().stroke(accent.opacity(session.phase == .idle ? 0.18 : 0.5), lineWidth: 1)
            )
            // Static shadow. Never animate radius/opacity — profiling in this
            // repo made an animated shadow the single biggest idle-CPU sink.
            .shadow(color: .black.opacity(0.5), radius: 24, y: 8)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("flow-pill")
        .accessibilityLabel("Dictation \(label)")
    }

    private var micButton: some View {
        Image(systemName: session.phase == .error ? "exclamationmark.triangle.fill" : "mic.fill")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(accent)
            .frame(width: 34, height: 34)
            .background(Circle().fill(accent.opacity(0.14)))
            .overlay(Circle().stroke(accent.opacity(0.35), lineWidth: 1))
            .scaleEffect(breathing && session.phase == .listening ? 1.06 : 1.0)
            .onAppear { restartBreathing() }
            .onChange(of: session.phase) { _ in restartBreathing() }
    }

    /// Seven bars, as in the reference.
    ///
    /// Honest note: the recogniser exposes one RMS level, not a spectrum, so
    /// these are one amplitude shaped by fixed per-bar weights — a motion cue,
    /// not a frequency display. A real band split would need the FFT that
    /// BridgeVoice does in `compute_band_levels_into`.
    private var bars: some View {
        HStack(spacing: 3) {
            ForEach(0..<7, id: \.self) { index in
                Capsule()
                    .fill(accent)
                    .frame(width: 3, height: barHeight(index))
                    .opacity(session.phase == .listening ? 1 : 0.35)
            }
        }
        .frame(width: 44, height: 22, alignment: .center)
        .animation(.easeOut(duration: 0.08), value: recognizer.micLevel)
    }

    private static let barWeights: [Double] = [0.45, 0.7, 0.95, 1.0, 0.9, 0.65, 0.4]

    private func barHeight(_ index: Int) -> CGFloat {
        let base: CGFloat = 4
        guard session.phase == .listening else { return base }
        let level = max(0, min(1, recognizer.micLevel))
        let weighted = level * Self.barWeights[index]
        return base + CGFloat(weighted) * 16
    }

    /// Cancelling a `repeatForever` needs its own animation-free transaction —
    /// a plain write inside the running animation's transaction just retargets
    /// it and the loop keeps going.
    private func restartBreathing() {
        var reset = Transaction()
        reset.disablesAnimations = true
        withTransaction(reset) { breathing = false }
        guard session.phase == .listening else { return }
        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
            breathing = true
        }
    }
}
