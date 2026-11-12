import GenesisToolsHost
import SwiftUI

/// The settings side panel, an inspector in the meeting's trailing pane slot that replaces the transcript pane while
/// it is open (`MeetingsWindowModel.sidePanelOpen`, R26, G53). Every opinionated choice of the window is a row here
/// (`SidePanelCatalog.windowSections`, the same `MeetingsWindowSetting` values the Settings page shows), and the engine's
/// clip and tone (`global.playback.listen`) through `config.set`, with "Applies from the next clip" under them (G54).
struct MeetingsSidePanel: View {
    let window: MeetingsWindowModel
    let detail: MeetingDetailModel
    /// A window setting was written here: the rows read the defaults again.
    @State private var revision = 0
    /// The named tones of the sound row, asked each time the panel opens.
    @State private var tonePresets: TonePresetList = .loading

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let failure = window.settings.failure, window.settingsRaw == nil {
                NoticePill(text: "The clip and tone settings did not load: \(failure.sentence)", more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { window.loadSettings() },
                                   failure.detailsFix { window.loadSettings() }])
                    .padding(10)
            }
            SidePanelSections(sections: sections, change: change, reset: reset,
                              playTone: { window.previewTone($0) },
                              openSettings: { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.windowPage + "#" + $0) },
                              folded: window.sidePanelFolded,
                              setFolded: { id, folded in
                                  if folded { window.sidePanelFolded.insert(id) } else { window.sidePanelFolded.remove(id) }
                              })
        }
        // The terminal or another window may have changed the engine's values since the last read: one read on open.
        .onAppear { window.loadSettings(quiet: true) }
        .task {
            let presets = await TonePresetList.load(service: window.service)
            if presets != .loading { tonePresets = presets }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Settings")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Settings").font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 6)
            Button("All settings…") { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.windowPage) }
                .buttonStyle(.genHoverPlain()).font(.system(size: 11.5))
                .instantTooltip("Open Settings → Meetings → Window")
                .accessibilityIdentifier("meetings.sidePanel.allSettings")
            IconButton(systemName: "xmark", tooltip: "Close the settings panel (\(MeetingsSidePanel.shortcutText))") {
                window.sidePanelOpen = false
            }
            .accessibilityIdentifier("meetings.sidePanel.close")
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    /// The engine's section first (it changes the sound the rows play), then the window's sections. Without a config
    /// read yet the engine section waits: its defaults would show as saved values.
    private var sections: [SidePanelSection] {
        _ = revision
        var out: [SidePanelSection] = []
        if let raw = window.settingsRaw {
            out.append(SidePanelCatalog.engineSection(listen: raw.at(Self.listenPath), presets: tonePresets))
        }
        return out + SidePanelCatalog.windowSections(window.defaults)
    }

    static let listenPath = SidePanelCatalog.segments(SidePanelCatalog.listenPath)
    /// The toolbar button's key, named in its tooltip and the panel's close button.
    static let shortcutText = "⌥⌘I"

    private func change(_ row: SidePanelRow, _ value: SidePanelValue) {
        switch row.store {
        case .window(let key):
            SidePanelCatalog.write(value, key: key, to: window.defaults)
            revision += 1
            window.windowSettingsChanged()
        case .engine(let path):
            SidePanelCatalog.applyEngine(value, for: row) { window.setConfig(SidePanelCatalog.segments(path), $0) }
        }
    }

    /// "Reset to Defaults": the section's window keys removed, its engine paths unset in one config write each.
    private func reset(_ section: SidePanelSection) {
        for key in section.windowKeys { window.defaults.removeObject(forKey: key) }
        for path in section.enginePaths { window.setConfig(SidePanelCatalog.segments(path), nil) }
        revision += 1
        window.windowSettingsChanged()
    }
}
