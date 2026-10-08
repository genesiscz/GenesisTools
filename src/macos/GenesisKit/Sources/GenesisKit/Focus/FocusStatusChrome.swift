// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/FocusStatusChrome.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import SwiftUI

/// Status-bar chip + post-crash recovery banner for Spec 17 Focus sessions.
public struct FocusStatusChip: View {
    public init(focus: FocusOrchestrator) { self.focus = focus }

    @ObservedObject public var focus: FocusOrchestrator

    public var body: some View {
        if focus.isActive {
            HStack(spacing: 5) {
                Image(systemName: "moon.fill")
                    .font(.system(size: 9, weight: .semibold))
                Text(chipLabel)
                    .font(GenTypography.mono(10))
            }
            .foregroundColor(.neonPurple)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(Color.neonPurple.opacity(0.12))
            )
            .overlay(
                Capsule()
                    .stroke(Color.neonPurple.opacity(0.35), lineWidth: 1)
            )
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("focus-status-chip")
            .instantTooltip(helpText)
            .transition(.opacity.combined(with: .scale(scale: 0.95)))
        }
    }

    private var chipLabel: String {
        if focus.suppressesSystemNotifications {
            return "notifications muted"
        }
        return "mute · active"
    }

    private var helpText: String {
        let reason = focus.activeReason ?? "session"
        return "Genesis notification mute active (\(reason)). App-local only — does not change macOS Focus."
    }
}

/// Top-of-workspace recovery strip after crash/force-quit mid-session.
public struct FocusRecoveryBanner: View {
    @ObservedObject public var focus: FocusOrchestrator

    public var body: some View {
        if let notice = focus.recoveryNotice {
            HStack(alignment: .top, spacing: GenSpacing.sm) {
                Image(systemName: "arrow.uturn.backward.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.neonAmber)
                Text(notice)
                    .font(GenTypography.body(12))
                    .foregroundColor(.settingsText)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button {
                    withAnimation(GenAnimation.quick) {
                        focus.clearRecoveryNotice()
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.settingsTextMuted)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityIdentifier("focus-recovery-dismiss")
                .instantTooltip("Dismiss this notice")
            }
            .padding(.horizontal, GenSpacing.md)
            .padding(.vertical, GenSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: GenRadius.md, style: .continuous)
                    .fill(Color.neonAmber.opacity(0.1))
            )
            .overlay(
                RoundedRectangle(cornerRadius: GenRadius.md, style: .continuous)
                    .stroke(Color.neonAmber.opacity(0.35), lineWidth: 1)
            )
            .padding(.horizontal, GenSpacing.md)
            .padding(.top, GenSpacing.sm)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("focus-recovery-banner")
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
