import SwiftUI

struct WidgetClaimedHandoffSection: View {
    let handoffs: [WidgetClaimedHandoff]
    let initiallyExpanded: Bool
    var openSettings: (() -> Void)?
    @State private var toggled: Set<String> = []

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
        return GenDisclosure(isExpanded: expanded, identifier: "tasks-handoff-\(handoff.id)",
                             accessibilityTitle: "\(handoff.title), \(detail)") {
            if handoff.members.isEmpty {
                EmptyState(text: "This handoff has no tasks")
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(handoff.members, id: \.rowID) { member in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: WorkStateLook.symbol(member.state))
                                .foregroundStyle(WorkStateLook.color(member.state))
                                .accessibilityHidden(true)
                            Text(member.title).font(.system(size: 12))
                            Spacer(minLength: 4)
                            Text(member.state.capitalized).font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.leading, 12)
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(handoff.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .instantTooltip("\(handoff.title)\n\(detail)")
        }
    }
}
