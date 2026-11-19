import SwiftUI

/// Place above the Items scroll view. The Hub host owns Command-F and increments `focusRequest`.
/// Counts describe the same projection the list renders, including any archive rows already read.
@MainActor
public struct WorkFindBar: View {
    @Binding private var filter: WorkFilter
    private let matchedCount: Int
    private let totalCount: Int
    private let focusRequest: Int
    private let clearRequest: Int
    private let filterNotice: String?
    private let onClear: () -> Void
    private let onSubmit: () -> Void
    @FocusState private var searchFocused: Bool
    @State private var query: String
    @State private var searchTask: Task<Void, Never>?

    public init(filter: Binding<WorkFilter>, matchedCount: Int, totalCount: Int,
                focusRequest: Int = 0, clearRequest: Int = 0, filterNotice: String? = nil,
                onClear: @escaping () -> Void, onSubmit: @escaping () -> Void) {
        _filter = filter
        _query = State(initialValue: filter.wrappedValue.text)
        self.matchedCount = matchedCount
        self.totalCount = totalCount
        self.focusRequest = focusRequest
        self.clearRequest = clearRequest
        self.filterNotice = filterNotice
        self.onClear = onClear
        self.onSubmit = onSubmit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WorkFindControlsLayout {
                search
                typeMenu
                stateMenu
                severityMenu
                mineButton
            }
            if filter.isActive {
                HStack(spacing: 12) {
                    Text(verbatim: "\(matchedCount) of \(Plural.count(totalCount, "item"))")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("work.find.count")
                    Spacer(minLength: 0)
                    Button("Clear filters") {
                        edit("")
                        onClear()
                    }
                        .buttonStyle(.genHoverPlain())
                        .accessibilityIdentifier("work.find.clearFilters")
                }
                .font(.system(size: 11))
            }
            if let filterNotice, !filterNotice.isEmpty {
                Text(verbatim: filterNotice)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("work.find.notice")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .onChange(of: focusRequest) { _, _ in searchFocused = true }
        .onChange(of: clearRequest) { _, _ in edit("") }
        .onChange(of: filter.text) { _, text in
            guard query != text else { return }
            searchTask?.cancel()
            query = text
        }
        .onDisappear { searchTask?.cancel() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Find work items")
    }

    private var search: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("Find items by words or ref", text: Binding(get: { query }, set: edit))
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($searchFocused)
                .onSubmit {
                    searchTask?.cancel()
                    filter.text = query
                    onSubmit()
                }
                .onKeyPress(.escape) {
                    guard !query.isEmpty else { return .ignored }
                    edit("")
                    return .handled
                }
                .accessibilityLabel("Find items by words or ref")
                .accessibilityIdentifier("work.find.text")
            if !query.isEmpty {
                IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search text", size: 11) {
                    edit("")
                    searchFocused = true
                }
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("work.find.clearText")
            }
        }
        .padding(.horizontal, 9)
        .frame(minHeight: 30)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 7))
        .overlay {
            RoundedRectangle(cornerRadius: 7)
                .strokeBorder(searchFocused ? Color.accentColor : Color.secondary.opacity(0.3),
                              lineWidth: searchFocused ? 1.5 : 0.5)
                .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture { searchFocused = true }
    }

    private func edit(_ value: String) {
        query = value
        searchTask?.cancel()
        if value.isEmpty {
            filter.text = ""
        } else {
            searchTask = Task {
                try? await Task.sleep(for: .milliseconds(80))
                guard !Task.isCancelled else { return }
                filter.text = value
            }
        }
    }

    private var typeMenu: some View {
        facet("Type", values: WorkWords.types.filter { filter.types.contains($0) }.map(WorkWords.type),
              active: !filter.types.isEmpty, identifier: "work.find.type") {
            [.action("Any", checked: filter.types.isEmpty) { filter.types = [] }, .divider]
                + WorkWords.types.map { type in
                    .action(WorkWords.type(type), checked: filter.types.contains(type)) {
                        toggle(type, in: &filter.types)
                    }
                }
        }
    }

    private var stateMenu: some View {
        let choices = WorkFilter.StateGroup.allCases.filter { filter.states.contains($0) }
        let labels = choices.map { state in
            state == .open && choices.count > 1 ? WorkWords.state("open") : WorkWords.stateGroup(state)
        }
        return facet("State", values: labels, spokenValues: choices.map(WorkWords.stateGroup),
                     active: !filter.states.isEmpty, identifier: "work.find.state") {
            [.action("Any", checked: filter.states.isEmpty) { filter.states = [] }, .divider]
                + WorkFilter.StateGroup.allCases.map { state in
                    .action(WorkWords.stateGroup(state), checked: filter.states.contains(state)) {
                        toggle(state, in: &filter.states)
                    }
                }
        }
    }

    private var severityMenu: some View {
        facet("Severity", values: WorkWords.severities.filter { filter.severities.contains($0) }
            .map { WorkWords.severity($0) }, active: !filter.severities.isEmpty,
              identifier: "work.find.severity") {
            [.action("Any", checked: filter.severities.isEmpty) { filter.severities = [] }, .divider]
                + WorkWords.severities.map { severity in
                    .action(WorkWords.severity(severity), checked: filter.severities.contains(severity)) {
                        toggle(severity, in: &filter.severities)
                    }
                }
        }
    }

    private var mineButton: some View {
        Button { filter.mine.toggle() } label: {
            HStack(spacing: 5) {
                Image(systemName: filter.mine ? "checkmark.square.fill" : "square")
                Text("Mine")
                Spacer(minLength: 0)
            }
            .font(.system(size: 11))
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        }
        .buttonStyle(.genHoverPlain())
        .foregroundStyle(filter.mine ? Color.accentColor : Color.primary)
        .instantTooltip("Show work assigned to you and items not claimed by an agent")
        .accessibilityLabel("Mine")
        .accessibilityValue(filter.mine ? "On" : "Off")
        .accessibilityIdentifier("work.find.mine")
    }

    private func facet(_ title: String, values: [String], spokenValues: [String]? = nil, active: Bool, identifier: String,
                       items: @escaping () -> [MenuButtonItem]) -> some View {
        let label = values.isEmpty ? title : "\(title): \(summary(values))"
        let spoken = (spokenValues ?? values).joined(separator: ", ")
        return MenuButton(items: items) {
            HStack(spacing: 4) {
                Text(verbatim: label).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                    .accessibilityHidden(true)
            }
            .font(.system(size: 11))
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        }
        .foregroundStyle(active ? Color.accentColor : Color.primary)
        .instantTooltip(label)
        .accessibilityLabel(title)
        .accessibilityValue(spoken.isEmpty ? "Any" : spoken)
        .accessibilityIdentifier(identifier)
    }

    private func summary(_ words: [String]) -> String {
        guard let first = words.first else { return "" }
        return words.count == 1 ? first : "\(first) +\(words.count - 1)"
    }

    private func toggle<Value: Hashable>(_ value: Value, in values: inout Set<Value>) {
        if values.contains(value) { values.remove(value) } else { values.insert(value) }
    }
}

/// One stable set of controls through every size: resizing never replaces the focused text field.
/// A wide pane uses one row. At medium widths facets follow the field. At 320 pt they form two rows.
private struct WorkFindControlsLayout: Layout {
    private let gap: CGFloat = 8
    private let rowHeight: CGFloat = 30

    private func frames(width: CGFloat) -> [CGRect] {
        if width >= 525 {
            let facets: [CGFloat] = [60, 116, 76, 50]
            let searchWidth = width - facets.reduce(0, +) - CGFloat(facets.count) * gap
            var frames = [CGRect(x: 0, y: 0, width: searchWidth, height: rowHeight)]
            for facetWidth in facets {
                let x = (frames.last?.maxX ?? 0) + gap
                frames.append(CGRect(x: x, y: 0, width: facetWidth, height: rowHeight))
            }
            return frames
        }
        let columns = width >= 460 ? 4 : 2
        let facetWidth = max(0, (width - CGFloat(columns - 1) * gap) / CGFloat(columns))
        return [CGRect(x: 0, y: 0, width: width, height: rowHeight)]
            + (0..<4).map { index in
                CGRect(x: CGFloat(index % columns) * (facetWidth + gap),
                       y: CGFloat(index / columns + 1) * (rowHeight + gap),
                       width: facetWidth, height: rowHeight)
            }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = max(0, proposal.width ?? 740)
        return CGSize(width: width, height: frames(width: width).map(\.maxY).max() ?? rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let positions = frames(width: bounds.width)
        for (subview, frame) in zip(subviews, positions) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                          anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}
