import SwiftUI

// The shared controls of the meeting tabs. Each tab has its own file: TranscriptTab.swift, ScreenTab.swift,
// ItemsTab.swift, SpeakersTab.swift (with SpeakerRow.swift) and ContextTab.swift.

struct FilterField: View {
    @Binding var text: String
    let prompt: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal.decrease").foregroundStyle(.secondary).font(.system(size: 11))
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .focused(focused)
                .onExitCommand { text = "" }
            if !text.isEmpty {
                IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the filter (Esc)", size: 11) { text = "" }
            }
        }
        .frame(height: 18)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { focused.wrappedValue = true }
        .background {
            Button("Find") { focused.wrappedValue = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
        }
    }
}

/// Which display the screen timeline shows: segments while they fit the column, else a pull-down with the same
/// choices. Four displays as segments needed about 520 pt, so at the window's smallest size the detail column was
/// drawn wider than the window and its last tab, Export and the last display were cut off.
struct DisplayPicker: View {
    let displays: [(id: Int, name: String)]
    @Binding var selection: Int

    var body: some View {
        ViewThatFits(in: .horizontal) {
            GenSegmentedTabs("Display", items: [GenSegmentedTabs.Item(-1, "All displays")] + displays.map {
                GenSegmentedTabs.Item($0.id, $0.name)
            }, selection: $selection, minSegmentWidth: 70, identifier: "meetings.screen.display")
            MenuButton(items: {
                [MenuButtonItem.action("All displays", checked: selection == -1) { selection = -1 }]
                    + displays.map { display in .action(display.name, checked: selection == display.id) { selection = display.id } }
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "display").accessibilityHidden(true)
                    Text(verbatim: selected).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).accessibilityHidden(true)
                }
                .font(.system(size: 12))
            }
            .instantTooltip("Which display the timeline shows")
            .accessibilityLabel("Display: \(selected)")
            .accessibilityIdentifier("meetings.screen.display")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frameProbe("meetings.screen.display")
    }

    private var selected: String { displays.first { $0.id == selection }?.name ?? "All displays" }
}

