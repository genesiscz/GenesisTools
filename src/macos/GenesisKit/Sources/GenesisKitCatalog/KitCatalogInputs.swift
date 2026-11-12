import AppKit
import GenesisKit
import SwiftUI

@MainActor
extension KitCatalog {
    static var inputEntries: [CatalogEntry] {
        [agentRoster, agentTextField, fittedScroll, scrollBars, growingEditor, hotkeyRecorder, overflowHints]
    }

    static var agentRoster: CatalogEntry {
        CatalogEntry(id: "agent-roster", group: "Rows", name: "Agent roster row", summary: "A compact agent summary keeps its identity, task and status separate. Repeated provider and role badges can be hidden by the list.",
            source: "GenesisKit/Controls/AgentRosterRow.swift", critique: ["Long tasks must not squeeze account names to a single letter.", "Repeated badges add noise when every row has the same provider or role."],
            sections: [CatalogSection("State and width", flow: .column, [
                CatalogVariant("Running") { AgentRosterRow(title: "Review the transcript changes", provider: "codex", role: "reviewer", model: "model-a", account: "work", status: "running", toolCalls: 42, unread: 3, showsRunningLabel: true).frame(width: 500) },
                CatalogVariant("Selected") { AgentRosterRow(title: "Prepare a recording", provider: "claude", role: "worker", account: "personal", status: "idle", selected: true).frame(width: 500) },
                CatalogVariant("Narrow, shared identity") { AgentRosterRow(title: "A longer task title that needs room", provider: "codex", role: "worker", model: "model-a", account: "work-account", status: "failed", toolCalls: 125, showsProvider: false, showsRole: false).frame(width: 280) },
                CatalogVariant("Group heading") { AgentRosterGroupLabel(title: "Recording review", provider: "codex", project: "Example", account: "work", total: 4, running: 2, live: true, unread: 3).frame(width: 500) },
            ])])
    }

    static var agentTextField: CatalogEntry {
        CatalogEntry(id: "agent-text-field", group: "Inputs", name: "Agent text field", summary: "A native single-line field whose accessibility value writes reach its binding. Return submits and Escape cancels when a handler is supplied.",
            source: "GenesisKit/Controls/AgentTextField.swift", critique: ["A visible accessibility write must update the model, not only the field's displayed text.", "Disabled input must reject editing through both the keyboard and accessibility."],
            sections: [CatalogSection("Content and availability", flow: .column, [
                CatalogVariant("Empty") { AgentTextField("Name the recording", text: .constant(""), identifier: "catalog.agent-field.empty").frame(width: 320) },
                CatalogVariant("Value") { AgentTextField("Name", text: .constant("Design review"), identifier: "catalog.agent-field.value").frame(width: 320) },
                CatalogVariant("Long value in a narrow field") { AgentTextField("Name", text: .constant("A recording with a much longer descriptive title")).frame(width: 190) },
                CatalogVariant("Disabled") { AgentTextField("Name", text: .constant("Read only")).disabled(true).frame(width: 320) },
            ])])
    }

    static var fittedScroll: CatalogEntry {
        CatalogEntry(id: "fitted-scroll", group: "Containers", name: "Fitted scroll area", summary: "A short list uses only the space its content needs. Longer content stops growing at the supplied limit and scrolls.",
            source: "GenesisKit/Controls/FittedScroll.swift", critique: ["A three-row result should not reserve a large empty panel.", "A previous measured height prevents a reopened transient list from flashing at zero height."],
            sections: [CatalogSection("Content height", flow: .column, [
                CatalogVariant("Two rows") { FittedScroll(maxHeight: 120, initialHeight: 44) { VStack(alignment: .leading) { Text("First result"); Text("Second result") }.frame(maxWidth: .infinity, alignment: .leading) }.frame(width: 320) },
                CatalogVariant("Twenty rows, capped") { FittedScroll(maxHeight: 100, initialHeight: 100) { VStack(alignment: .leading) { ForEach(1...20, id: \.self) { Text("Result \($0)") } }.frame(maxWidth: .infinity, alignment: .leading) }.frame(width: 320) },
            ])])
    }

    static var scrollBars: CatalogEntry {
        CatalogEntry(id: "scroll-bars", group: "Navigation", name: "Scroll bars", summary: "The custom scroller and the system scroller share native dragging and scrolling behaviour. The selected style belongs to the containing scroll view.",
            source: "GenesisKit/Controls/GenScrollBars.swift", critique: ["A scroll thumb must remain visible against the content behind it.", "Keep native hit testing and keyboard behaviour instead of drawing an inert thumb."],
            sections: [CatalogSection("Orientation and style", [
                CatalogVariant("Genesis vertical") { CatalogScroller(custom: true, horizontal: false).frame(width: 14, height: 110) },
                CatalogVariant("System vertical") { CatalogScroller(custom: false, horizontal: false).frame(width: 16, height: 110) },
                CatalogVariant("Genesis horizontal") { CatalogScroller(custom: true, horizontal: true).frame(width: 180, height: 14) },
                CatalogVariant("System horizontal") { CatalogScroller(custom: false, horizontal: true).frame(width: 180, height: 16) },
            ])])
    }

    static var growingEditor: CatalogEntry {
        let long = "A longer review comment that wraps over several lines.\nThe editor grows with its content.\nAfter its limit it scrolls instead of moving the controls below.\nThe last line stays reachable.\nAnother line to show the capped state."
        return CatalogEntry(id: "growing-editor", group: "Inputs", name: "Growing text editor", summary: "A multiline draft grows to its line limit, then scrolls in place. Its Return and Escape policy belongs to the caller.",
            source: "GenesisKit/Controls/GrowingTextEditor.swift", critique: ["A long draft must remain reachable without giving the entire pane to the editor.", "Placeholder, one-line and capped states need the same text alignment."],
            sections: [CatalogSection("Draft length", flow: .column, [
                CatalogVariant("Placeholder") { GrowingTextEditor("Write a comment", text: .constant("")).frame(width: 400) },
                CatalogVariant("One line") { GrowingTextEditor("Write a comment", text: .constant("Check the speaker at this point.")).frame(width: 400) },
                CatalogVariant("Capped at three lines") { GrowingTextEditor("Write a comment", text: .constant(long), maxLines: 3).frame(width: 400) },
                CatalogVariant("Narrow editor") { GrowingTextEditor("Write a comment", text: .constant(long), maxLines: 4).frame(width: 200) },
            ])])
    }

    static var hotkeyRecorder: CatalogEntry {
        let standard = HotkeyChord(keyCode: 15, modifiers: HotkeyChord.command | HotkeyChord.shift)
        return CatalogEntry(id: "hotkey-recorder", group: "Inputs", name: "Keyboard shortcut recorder", summary: "Records one shortcut, names its modifiers and explains combinations that cannot be registered. Escape exits capture.",
            source: "GenesisKit/Controls/HotkeyRecorder.swift", critique: ["The saved shortcut and active capture state must not look the same.", "An invalid combination needs an explanation rather than a silent refusal."],
            sections: [CatalogSection("Saved combinations", flow: .column, [
                CatalogVariant("Default") { HotkeyRecorder(chord: .constant(standard), defaultChord: standard, identifier: "catalog.hotkey.default") },
                CatalogVariant("Changed, reset available") { HotkeyRecorder(chord: .constant(.init(keyCode: 49, modifiers: HotkeyChord.control | HotkeyChord.option)), defaultChord: standard, identifier: "catalog.hotkey.changed") },
                CatalogVariant("No modifier") { HotkeyRecorder(chord: .constant(.init(keyCode: 15, modifiers: 0)), identifier: "catalog.hotkey.invalid") },
                CatalogVariant("Disabled") { HotkeyRecorder(chord: .constant(standard), identifier: "catalog.hotkey.disabled").disabled(true) },
            ])])
    }

    static var overflowHints: CatalogEntry {
        CatalogEntry(id: "overflow-hints", group: "Navigation", name: "Scroll overflow hints", summary: "A soft edge fade indicates content beyond the visible region. It is measured from the scroll view rather than every row.",
            source: "GenesisKit/Controls/ScrollOverflowHints.swift", critique: ["A cropped list should not look as if its last visible row is the last result.", "Keep the fade outside hit testing so it does not block scrolling or selection."],
            sections: [CatalogSection("Content beyond an edge", flow: .column, [
                CatalogVariant("No overflow") { ScrollView { Text("Two short lines\nFit in the visible area").frame(maxWidth: .infinity, alignment: .leading).scrollOverflowContent() }.scrollOverflowHints().frame(width: 320, height: 70) },
                CatalogVariant("Vertical overflow") { ScrollView { VStack(alignment: .leading) { ForEach(1...16, id: \.self) { Text("Visible result \($0)") } }.frame(maxWidth: .infinity, alignment: .leading).scrollOverflowContent() }.scrollOverflowHints().frame(width: 320, height: 100) },
                CatalogVariant("Horizontal overflow") { ScrollView(.horizontal) { HStack { ForEach(1...12, id: \.self) { Badge("Item \($0)") } }.scrollOverflowContent() }.scrollOverflowHints(.horizontal).frame(width: 320, height: 35) },
            ])])
    }
}

private struct CatalogScroller: NSViewRepresentable {
    let custom: Bool
    let horizontal: Bool

    func makeNSView(context: Context) -> NSScroller {
        let frame = horizontal ? NSRect(x: 0, y: 0, width: 180, height: 14) : NSRect(x: 0, y: 0, width: 14, height: 110)
        let scroller: NSScroller = custom ? GenScroller(frame: frame) : NSScroller(frame: frame)
        // A standalone specimen has no scroll view to fade an overlay knob in.
        scroller.scrollerStyle = .legacy
        scroller.isEnabled = true
        scroller.knobProportion = 0.32
        scroller.doubleValue = 0.35
        return scroller
    }

    func updateNSView(_ scroller: NSScroller, context: Context) {
        scroller.frame.size = horizontal ? NSSize(width: 180, height: 14) : NSSize(width: 14, height: 110)
        scroller.needsDisplay = true
    }
}
