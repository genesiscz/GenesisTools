import SwiftUI

struct WidgetClaimedHandoffSection: View {
    let handoffs: [WidgetClaimedHandoff]
    let initiallyExpanded: Bool
    var showTooltip = true
    var openSettings: (() -> Void)?
    @State private var toggled: Set<String> = []
    @GenReduceMotion private var reduceMotion
    @Environment(\.genExpansionHost) private var expansionHost

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Claimed handoffs").font(.system(size: 12, weight: .semibold))
                Spacer()
                if let openSettings {
                    IconButton(systemName: "gearshape", tooltip: "Claimed handoff settings", action: openSettings)
                }
            }
            if handoffs.isEmpty {
                EmptyState(text: "No handoffs claimed by a live session in this view")
            }
            ForEach(handoffs) { handoff in
                handoffRow(handoff)
            }
        }
        .accessibilityIdentifier("tasks-claimed-handoffs")
    }

    private func handoffRow(_ handoff: WidgetClaimedHandoff) -> some View {
        let expanded = Binding(get: { initiallyExpanded != toggled.contains(handoff.id) }, set: { value in
            if value == initiallyExpanded { toggled.remove(handoff.id) } else { toggled.insert(handoff.id) }
        })
        let count = Plural.count(handoff.members.count, "task")
        let detail = ([handoff.project, count] + handoff.claimants.map(\.title)).joined(separator: " · ")
        let link = WidgetWorkLink(id: handoff.id, title: handoff.title, body: handoff.body, repoRoot: handoff.repoRoot)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 2) {
                Button {
                    let next = !expanded.wrappedValue
                    expansionHost?.willChange(next)
                    GenMotion.perform(expanding: next, reduceMotion: reduceMotion) { expanded.wrappedValue = next }
                } label: {
                    Image(systemName: expanded.wrappedValue ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold)).frame(width: 26, height: 26).contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityLabel("\(expanded.wrappedValue ? "Collapse" : "Expand") \(handoff.title)")
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("tasks-handoff-\(handoff.id)")
                WidgetWorkButton(item: link, showTooltip: showTooltip) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(handoff.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                        Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .accessibilityValue(detail)
            }
            if expanded.wrappedValue { members(handoff, link: link).transition(.genReveal) }
        }
    }

    @ViewBuilder private func members(_ handoff: WidgetClaimedHandoff, link: WidgetWorkLink) -> some View {
        if handoff.members.isEmpty {
            EmptyState(text: "This handoff has no tasks")
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(handoff.members, id: \.rowID) { member in
                    let item = WidgetWorkLink(id: member.id, title: member.title, body: member.body,
                                              acceptance: member.acceptance, repoRoot: member.repoRoot ?? handoff.repoRoot)
                    WidgetWorkButton(item: item, showTooltip: showTooltip, parentPlan: { link.plan }) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: WorkStateLook.symbol(member.state))
                                .foregroundStyle(WorkStateLook.color(member.state))
                                .accessibilityHidden(true)
                            Text(member.title).font(.system(size: 12))
                            Spacer(minLength: 4)
                            Text(member.state.capitalized).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityValue([member.state.capitalized, member.acceptance].compactMap { $0 }.joined(separator: ". "))
                }
            }
            .padding(.leading, 12)
        }
    }
}
