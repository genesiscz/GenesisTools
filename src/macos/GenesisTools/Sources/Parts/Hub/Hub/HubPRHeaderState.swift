import SwiftUI

/// The PR header's one merge state (hub UX pass C15). A draft read "Draft", "blocked it is a draft" and, one row down,
/// "mergeable": three words that contradict each other at a glance ("mergeable" was git's own answer, no conflicts).
///
/// - A draft: "Draft, not mergeable", with what else blocks it and the conflict state in the tooltip.
/// - An open PR: its state and the readiness verdict with its first reason (`PRReadinessHeaderChip`).
/// - Merged or closed: the state alone.
///
/// Git's mergeability shows on its own only as "Merge conflicts"; "mergeable" goes into the tooltip.
struct PRHeaderState: View {
    let pr: HubPR
    /// The host's answer: "mergeable", "conflicting" or "unknown"; nil before the PR's detail loads.
    let mergeable: String?
    @ObservedObject private var store = PRReadinessStore.shared

    var body: some View {
        let tone = PRStateTone(pr: pr)
        HStack(spacing: 6) {
            if tone == .draft {
                Badge("Draft, not mergeable", color: tone.color, look: .tone)
                    .instantTooltip(Self.draftTooltip(readiness: store.readiness(for: pr), mergeable: mergeable, kind: kind))
            } else {
                Badge(tone.title, color: tone.color, look: .tone, tooltip: "\(kind) state: \(tone.title)")
                PRReadinessHeaderChip(pr: pr)
            }
            if mergeable == "conflicting", tone == .draft || tone == .open {
                Badge("Merge conflicts", color: ReviewPalette.removed, look: .tone,
                      tooltip: "The branch conflicts with its base: merge or rebase it first")
            }
        }
    }

    private var kind: String { pr.forgeKind.noun }

    /// What blocks the draft besides being one, then the conflict state.
    static func draftTooltip(readiness: PRReadiness?, mergeable: String?, kind: String) -> TooltipContent {
        var bullets = (readiness?.reasons ?? []).filter { !$0.localizedCaseInsensitiveContains("draft") }
        if let readiness, readiness.outdatedUnresolved > 0 {
            bullets.append("\(Plural.count(readiness.outdatedUnresolved, "outdated thread")) still unresolved (not blocking)")
        }
        switch mergeable {
        case "mergeable": bullets.append("no merge conflicts")
        case "conflicting": bullets.append("merge conflicts with the base")
        default: break
        }
        return TooltipContent(title: "A draft \(kind): mark it ready for review before it can merge",
                              bullets: bullets.map { $0.prefix(1).uppercased() + $0.dropFirst() })
    }
}
