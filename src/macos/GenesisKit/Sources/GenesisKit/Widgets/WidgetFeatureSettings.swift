import AppKit
import SwiftUI

public struct WidgetModuleChoice: Identifiable {
    public let id: String
    public let title: String
    public let symbol: String
    public let detail: String
    public init(id: String, title: String, symbol: String, detail: String) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.detail = detail
    }

    public static let agents = Self(
        id: "agents", title: "Agent Inbox", symbol: "tray.fill",
        detail: "Questions, answers, screenshots and live conversations.")
    /// Exactly the modules `WidgetCoordinator` registers. Settings offer only these, because the layout drops any
    /// configured ID the host has not registered, so a toggle for anything else would silently do nothing.
    public static let builtins: [Self] = [
        agents,
        .init(
            id: "capture", title: "Capture", symbol: "camera.viewfinder",
            detail: "Screenshots and recordings ready for your next message."),
        .init(
            id: "shelf", title: "File Shelf", symbol: "tray.full.fill",
            detail: "Keep the files you are working with within reach."),
        .init(
            id: "tasks", title: "Tasks", symbol: "checklist",
            detail: "A small, local list for the work in front of you."),
        .init(
            id: "focus", title: "Flow", symbol: "mic.circle.fill",
            detail: "Dictation, focus sessions and your Focus Studio."),
        .init(
            id: "voice", title: "Voice Notes", symbol: "mic.fill",
            detail: "Turn a spoken thought into editable text."),
    ]
}

@MainActor
public enum WidgetFeatureSettings {
    public static let hiddenNotice = "The widget is off. Turn it on to see pinned sessions at the top or side."

    public static func sections(
        model: WidgetModel, modules: [WidgetModuleChoice],
        flowRuntime: FlowFocusRuntime? = nil, transforms: FlowTransformTools? = nil,
        openSession: @escaping (WidgetSession) -> Void
    ) -> [NativeSettingsSection] {
        var dictationPages = [NativeSettingsPage(
            id: "dictation.voice", title: "Voice Notes", symbol: "recordingtape", tint: .pink,
            subtitle: "Choose the speech provider for voice notes and agent drafts.") {
                WidgetDictationSettings(model: model)
            }]
        if let flowRuntime {
            dictationPages.append(NativeSettingsPage(id: "dictation.flow", title: "Dictation", symbol: "mic",
                tint: .cyan, subtitle: "Dictate into any app with Apple Speech.") {
                    FlowSettingsView(session: flowRuntime.flow, openLibrary: { flowRuntime.showDictation() })
                })
        }
        if let transforms {
            dictationPages.append(NativeSettingsPage(id: "dictation.transforms", title: "Text transforms",
                symbol: "wand.and.stars", tint: .purple,
                subtitle: "Choose an existing AI account and model for explicit text transforms.") {
                    FlowTransformSettingsView(tools: transforms)
                })
        }
        var sections = [
            NativeSettingsSection(
                id: "widgets", title: "Widgets",
                pages: [
                    NativeSettingsPage(
                        id: "widgets.general", title: "General", symbol: "rectangle.topthird.inset.filled",
                        tint: .blue, subtitle: "Put your tools where they belong."
                    ) {
                        WidgetGeneralSettings(model: model, openSession: openSession)
                    },
                    NativeSettingsPage(
                        id: "widgets.sessions", title: "Projects / Sessions", symbol: "folder",
                        tint: .orange, subtitle: "Pin, filter and open your local sessions."
                    ) {
                        WidgetSessionSettings(model: model, openSession: openSession)
                    },
                    NativeSettingsPage(
                        id: "widgets.providers", title: "Providers", symbol: "person.2",
                        tint: .mint, subtitle: "Choose which agents appear in your inbox."
                    ) {
                        WidgetProviderSettings(model: model)
                    },
                    NativeSettingsPage(
                        id: "widgets.modules", title: "Widgets", symbol: "square.grid.2x2",
                        tint: .purple, subtitle: "Choose a different set for each edge."
                    ) {
                        WidgetModuleSettings(model: model, modules: modules)
                    },
                    NativeSettingsPage(
                        id: "widgets.recording", title: "Screen recording", symbol: "record.circle",
                        tint: .red, subtitle: "Where the recording controls float and how a recording looks."
                    ) {
                        RecordingSettingsView()
                    },
                ], order: 30),
            NativeSettingsSection(
                id: "dictation", title: "Dictation",
                pages: dictationPages, order: 40),
        ]
        if let flowRuntime {
            sections.append(NativeSettingsSection(id: "focus", title: "Focus", pages: [
                NativeSettingsPage(id: "focus.general", title: "Focus", symbol: "timer", tint: .orange,
                    subtitle: "Timer, capture, privacy and project settings.") {
                        FocusSettingsView(controller: flowRuntime.focus, configuration: flowRuntime.configuration)
                    }
            ], order: 45))
        }
        return sections
    }
}

private struct WidgetGeneralSettings: View {
    @ObservedObject var model: WidgetModel
    let openSession: (WidgetSession) -> Void
    @ObservedObject private var appearance = NativeSettingsAppearance.shared
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }

    var body: some View {
        VStack(spacing: 18) {
            WidgetSettingsLoading(model: model)
            WidgetSettingsError(model: model)
            if model.settingsLoaded {
            NativeSettingsCard("Placement", subtitle: "Top and side share your sessions and drafts.") {
                NativeSettingsToggle(
                    "Show the widget", detail: "Panels at the top and side of your screen.",
                    identifier: "widget.showWidget", isOn: boolean("showWidget", prefs?.showWidget ?? false))
                if model.settingsLoaded && !(prefs?.showWidget ?? false) {
                    Text(WidgetFeatureSettings.hiddenNotice).font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider()
                NativeSettingsRow("Visible edges") {
                    Picker("Visible edges", selection: string("placement", prefs?.placement ?? "both")) {
                        Text("Both").tag("both")
                        Text("Top").tag("top")
                        Text("Side").tag("side")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Side edge") {
                    Picker("Side edge", selection: string("side", prefs?.side ?? "right")) {
                        Text("Left").tag("left")
                        Text("Right").tag("right")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 170, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Display") {
                    Picker("Display", selection: string("display", prefs?.display ?? "")) {
                        Text("Main display").tag("")
                        ForEach(NSScreen.screens, id: \.self) { screen in
                            Text(screen.localizedName).tag(WidgetCoordinator.id(screen))
                        }
                    }.labelsHidden().frame(width: 220, alignment: .trailing)
                }
            }
            NativeSettingsCard("Side widgets") {
                NativeSettingsRow("Arrangement", detail: "Three groups can have different tools.") {
                    Picker("Side arrangement", selection: string("sideLayout", prefs?.sideLayout ?? "joined")) {
                        Text("Joined").tag("joined")
                        Text("Three bubbles").tag("separated")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Vertical position", detail: "You can also drag the handle on any side bubble.") {
                    Slider(
                        value: Binding(
                            get: { prefs?.sidePosition ?? 0.5 },
                            set: { patch(["sidePosition": .number($0)]) }), in: 0...1
                    )
                    .frame(width: 200).accessibilityLabel("Side widget vertical position")
                }
                Divider()
                NativeSettingsToggle(
                    "Hover previews", detail: "See a preview without changing keyboard focus.",
                    isOn: boolean("hoverPreviews", prefs?.hoverPreviews ?? true))
                Divider()
                NativeSettingsRow("Session bubble tooltips", detail: "Automatic shows them only while hover previews are off.") {
                    Picker("Session bubble tooltips", selection: string("bubbleTooltip", prefs?.bubbleTooltip ?? "auto")) {
                        Text("Automatic").tag("auto")
                        Text("Always").tag("always")
                        Text("Never").tag("never")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Session bubble order", detail: "Same as the list follows the hover list's order. Keep places holds each bubble where it appeared.") {
                    Picker("Session bubble order", selection: string("railOrder", prefs?.railOrder ?? "list")) {
                        Text("Same as the list").tag("list")
                        Text("Keep places").tag("stable")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
            }
            NativeSettingsCard("Shape") {
                NativeSettingsRow("Side style", detail: "Classic keeps a compact monochrome rail with its handle below.") {
                    Picker("Side style", selection: string("sideStyle", prefs?.sideStyle ?? "modular")) {
                        Text("Modular").tag("modular")
                        Text("Classic").tag("classic")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 220, alignment: .trailing)
                }
                Divider()
                NativeSettingsToggle(
                    "Join screen edges", detail: "Curved shoulders join the display. Turn off for fully rounded bubbles.",
                    isOn: boolean("joinedEdges", prefs?.joinedEdges ?? true))
            }
            NativeSettingsCard("Appearance") {
                NativeSettingsSegmented(
                    "Panel background",
                    detail: "Dark is a solid near-black panel. Glass shows the desktop through it. Same as the app follows the theme in General, which other windows can change.",
                    identifier: "widget.panelBackground",
                    options: [NativeSettingsOption("dark", "Dark"), NativeSettingsOption("glass", "Glass"),
                              NativeSettingsOption("theme", "Same as the app")],
                    selection: string("panelBackground", prefs?.panelBackground ?? "dark"))
                Divider()
                NativeSettingsToggle(
                    "Reduce motion", detail: "Shared with General: keeps every native window and widget still.",
                    isOn: $appearance.reduceMotion)
                Divider()
                NativeSettingsToggle(
                    "Reduce transparency", detail: "Shared with General: solid surfaces instead of glass.",
                    isOn: $appearance.reduceTransparency)
            }
            NativeSettingsCard("Inbox behavior") {
                NativeSettingsToggle(
                    "Show the waiting question in the list",
                    detail: "Each session in the hover list shows its open decision under its name, so an alert that closed can be found again.",
                    isOn: boolean("previewQuestion", prefs?.previewQuestion ?? true))
                Divider()
                NativeSettingsRow(
                    "Collapse when quiet", detail: "A draft, recording or active agent keeps the inbox open."
                ) {
                    Picker(
                        "Quiet timeout",
                        selection: Binding(
                            get: { prefs?.quietSeconds ?? 15 },
                            set: { patch(["quietSeconds": .number(Double($0))]) })
                    ) {
                        Text("5 seconds").tag(5)
                        Text("15 seconds").tag(15)
                        Text("30 seconds").tag(30)
                        Text("1 minute").tag(60)
                    }.labelsHidden().frame(width: 150, alignment: .trailing)
                }
                Divider()
                NativeSettingsToggle(
                    "Changed files", detail: "Show a session's working changes alongside its conversation.",
                    isOn: boolean("showChanges", prefs?.showChanges ?? true))
                Divider()
                NativeSettingsRow("Reply box", detail: "Where a session's inbox puts the reply box.") {
                    Picker("Reply box", selection: string("inboxComposer", prefs?.inboxComposer ?? "top")) {
                        Text("Under the tabs").tag("top")
                        Text("Below the list").tag("bottom")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Replies name what they answer", detail: "A reply starts with \"Reply to:\" and the title of the card you selected, or of the agent's newest item, so the agent knows what it answers. The reply box shows it, with × to leave it out.") {
                    Picker("Replies name what they answer", selection: string("replyNames", prefs?.replyNames ?? "selected-or-newest")) {
                        Text("Selected, else newest").tag("selected-or-newest")
                        Text("Selected card only").tag("selected")
                        Text("Never").tag("never")
                    }.labelsHidden().frame(width: 190, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Decision click", detail: "Stage keeps your pick to send later with the others, one message per session. The hub's Inbox follows it too.") {
                    Picker("Decision click", selection: string("decisionClick", prefs?.decisionClick ?? "stage")) {
                        Text("Stage").tag("stage")
                        Text("Send at once").tag("send")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsToggle(
                    "⌘ does the other", detail: "⌘-click on an option, and ⌘-Return in a decision's own answer, send at once while a click stages, and stage while a click sends. In the widget and the hub's Inbox.",
                    isOn: boolean("decisionCommandSwaps", prefs?.decisionCommandSwaps ?? true))
                Divider()
                NativeSettingsRow("Return in an own answer", detail: "Return in a decision's own answer field, or its note in the hub's Inbox: stage the text as its note to send later, or send it as the answer now.") {
                    Picker("Return in an own answer", selection: string("ownAnswerReturn", prefs?.ownAnswerReturn ?? "stage")) {
                        Text("Stage").tag("stage")
                        Text("Send").tag("send")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsToggle(
                    "Staged at start", detail: "When the widget starts with decisions staged and not sent, a popup lists them with Send now until you close it.",
                    isOn: boolean("stagedReminder", prefs?.stagedReminder ?? true))
                Divider()
                NativeSettingsRow("Closing with staged decisions", detail: "What happens to staged decisions when the inbox closes.") {
                    Picker("Closing with staged decisions", selection: string("stagedOnLeave", prefs?.stagedOnLeave ?? "ask")) {
                        Text("Ask").tag("ask")
                        Text("Keep staged").tag("keep")
                        Text("Send them").tag("send")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Close after send", detail: "When closing sends staged decisions, keep the delivered note readable for this long. Any new typing, pick or session selection keeps the panel open.") {
                    Picker("Close after send", selection: Binding(
                        get: { prefs?.sendCloseSeconds ?? 2.5 },
                        set: { patch(["sendCloseSeconds": .number($0)]) })) {
                        Text("Keep open").tag(0.0)
                        ForEach(Array(Set([2.5, 5, 10, prefs?.sendCloseSeconds ?? 2.5])).filter { $0 > 0 }.sorted(), id: \.self) { seconds in
                            Text("\(seconds.formatted()) seconds").tag(seconds)
                        }
                    }.labelsHidden().accessibilityIdentifier("widget.sendCloseSeconds")
                }
                Divider()
                NativeSettingsRow("Inbox of every session", detail: "The inbox button's list: grouped under each session, or one list.") {
                    Picker("Inbox of every session", selection: string("inboxGrouping", prefs?.inboxGrouping ?? "session")) {
                        Text("By session").tag("session")
                        Text("One list").tag("list")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                openingFilters
                Divider()
                NativeSettingsRow("Reply box microphone", detail: "Both put the words in the reply box as you talk; a voice note also keeps the recording in Voice Notes.") {
                    Picker("Reply box microphone", selection: string("composerVoice", prefs?.composerVoice ?? "ask")) {
                        Text("Ask each time").tag("ask")
                        Text("Voice note").tag("note")
                        Text("Dictate").tag("live")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 300, alignment: .trailing)
                }
            }
            NativeSettingsCard("Alerts", subtitle: "When an agent asks or answers while the widget is closed.") {
                NativeSettingsToggle(
                    "Decisions and questions", detail: "A new question that waits for your answer.",
                    identifier: "widget.alertDecisions", isOn: boolean("alertDecisions", prefs?.alertDecisions ?? true))
                Divider()
                NativeSettingsToggle(
                    "Answers and messages", detail: "A new logged answer or a message an agent sent you.",
                    identifier: "widget.alertAnswers", isOn: boolean("alertAnswers", prefs?.alertAnswers ?? true))
                Divider()
                NativeSettingsRow("Sound for decisions", detail: "Decisions and questions that wait for you. One chime per burst.") {
                    soundPicker("alertSound", prefs?.alertSound ?? WidgetAlerts.defaultSound, same: false)
                }
                Divider()
                NativeSettingsRow("Sound for answers", detail: "Answers and messages, when nothing in the burst waits for you.") {
                    soundPicker("alertAnswerSound", prefs?.alertAnswerSound ?? "same", same: true)
                }
                Divider()
                NativeSettingsSlider(
                    "Sound volume", detail: "Both alert sounds, as a share of the Mac's volume. Releasing the slider plays the decision sound.",
                    identifier: "widget.alertVolume",
                    value: Binding(
                        get: { Double(WidgetAlerts.volume(prefs)) * 100 },
                        set: { patch(["alertVolume": .number($0.rounded())]) }),
                    in: 0...100, step: 5, ticks: [0, 25, 50, 75, 100],
                    format: { $0 <= 0 ? "Off" : "\(Int($0.rounded())) %" },
                    onCommit: { WidgetAlerts.preview(prefs?.alertSound ?? WidgetAlerts.defaultSound, volume: Float($0 / 100)) })
                Divider()
                NativeSettingsToggle(
                    "Open the widget", detail: "The widget opens a short preview of the new item; a click on it answers.",
                    identifier: "widget.alertPopup", isOn: boolean("alertPopup", prefs?.alertPopup ?? true))
                Divider()
                Group {
                    NativeSettingsRow("Preview stays", detail: "How long the preview stays while the pointer is not on it. Until closed keeps it until you answer, open or close it. × or Esc closes it sooner.") {
                        Picker(
                            "Preview stays",
                            selection: Binding(
                                get: { Int(WidgetAlerts.popupSeconds(prefs)) },
                                set: { patch(["alertPopupSeconds": .number(Double($0))]) })
                        ) {
                            ForEach(Self.popupSecondsChoices(current: Int(WidgetAlerts.popupSeconds(prefs))), id: \.self) {
                                Text($0 == 0 ? "Until closed" : "\($0) seconds").tag($0)
                            }
                        }.labelsHidden().frame(width: 150, alignment: .trailing)
                            .accessibilityIdentifier("widget.alertPopupSeconds")
                    }
                    Divider()
                    NativeSettingsToggle(
                        "Close on a click elsewhere", detail: "A click outside the widget closes the preview and every alert waiting in it.",
                        identifier: "widget.alertPopupClickAway",
                        isOn: boolean("alertPopupClickAway", prefs?.alertPopupClickAway ?? false))
                    Divider()
                    NativeSettingsRow("Several at once", detail: "Another alert while the preview is open. Listed shows it under the first one, Queued shows it when the first one closes, Replaced shows only the newest.") {
                        Picker("Several at once", selection: string("alertPopupMany", WidgetAlerts.popupMany(prefs).rawValue)) {
                            Text("Listed").tag(WidgetAlerts.PopupMany.list.rawValue)
                            Text("Queued").tag(WidgetAlerts.PopupMany.queue.rawValue)
                            Text("Replaced").tag(WidgetAlerts.PopupMany.newest.rawValue)
                        }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                            .accessibilityIdentifier("widget.alertPopupMany")
                    }
                    Divider()
                    NativeSettingsRow("After a send", detail: "After a pick sent from the alert popup: stay in the popup with its result, or open its session.") {
                        Picker("After a send", selection: string("popupSendOpens", prefs?.popupSendOpens ?? "stay")) {
                            Text("Stay").tag("stay")
                            Text("Open its session").tag("session")
                        }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                            .accessibilityIdentifier("widget.popupSendOpens")
                    }
                }
                .disabled(!(prefs?.alertPopup ?? true))
                Divider()
                NativeSettingsRow("Flash the session", detail: "Its rail bubble and its row flash, so you see which session asked.") {
                    Picker(
                        "Flash the session",
                        selection: Binding(
                            get: { Int(WidgetAlerts.flashSeconds(prefs)) },
                            set: { patch(["alertFlashSeconds": .number(Double($0))]) })
                    ) {
                        Text("Off").tag(0)
                        Text("3 seconds").tag(3)
                        Text("5 seconds").tag(5)
                        Text("10 seconds").tag(10)
                        Text("20 seconds").tag(20)
                    }.labelsHidden().frame(width: 150, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Notes stay", detail: "How long a note under the widget's header stays, such as \"Inbox marked read\". A note with a button stays at least 10 seconds; errors stay until you close them.") {
                    Picker(
                        "Notes stay",
                        selection: Binding(
                            get: { Int(prefs?.noteSeconds ?? 6) },
                            set: { patch(["noteSeconds": .number(Double($0))]) })
                    ) {
                        ForEach(Self.noteSecondsChoices(current: Int(prefs?.noteSeconds ?? 6)), id: \.self) { seconds in
                            Text(seconds == 0 ? "Until closed" : "\(seconds) seconds").tag(seconds)
                        }
                    }.labelsHidden().frame(width: 150, alignment: .trailing)
                        .accessibilityIdentifier("widget.noteSeconds")
                }
            }
            .nativeSettingsAnchor("alerts")
            NativeSettingsCard(
                "Automatic decisions",
                subtitle: "Decisions answered outside the widget: an agent recorded the answer you gave in the chat, or your reply was read as one."
            ) {
                NativeSettingsToggle(
                    "Announce them", detail: "A sound and a short preview that shows which option was taken.",
                    identifier: "widget.autoDecisionPopup",
                    isOn: boolean("autoDecisionPopup", prefs?.autoDecisionPopup ?? true))
                Divider()
                Group {
                    NativeSettingsRow("Preview stays", detail: "How long the preview stays while the pointer is not on it. Several at once in Alerts applies here too.") {
                        Picker(
                            "Automatic decision preview stays",
                            selection: Binding(
                                get: { Int(WidgetAlerts.autoDecisionSeconds(prefs)) },
                                set: { patch(["autoDecisionSeconds": .number(Double($0))]) })
                        ) {
                            ForEach(Self.popupSecondsChoices(current: Int(WidgetAlerts.autoDecisionSeconds(prefs))), id: \.self) {
                                Text($0 == 0 ? "Until closed" : "\($0) seconds").tag($0)
                            }
                        }.labelsHidden().frame(width: 150, alignment: .trailing)
                            .accessibilityIdentifier("widget.autoDecisionSeconds")
                    }
                    Divider()
                    NativeSettingsRow("Sound", detail: "Plays at the Sound volume set in Alerts.") {
                        soundPicker("autoDecisionSound", prefs?.autoDecisionSound ?? WidgetAlerts.defaultAutoDecisionSound,
                                    same: true, label: "Automatic decision sound")
                    }
                }
                .disabled(!(prefs?.autoDecisionPopup ?? true))
                Divider()
                WidgetAnsweredElsewhereLog(model: model, openSession: openSession)
            }
            .nativeSettingsAnchor("automatic-decisions")
            NativeSettingsCard("Shortcut", subtitle: "A global shortcut that opens the widget from any app.") {
                NativeSettingsToggle(
                    "Open with a shortcut",
                    detail: "Opens the agent inbox with the keyboard in it; press it again to close the widget.",
                    identifier: "widget.openShortcutEnabled",
                    isOn: boolean("openShortcutEnabled", prefs?.openShortcutEnabled ?? true))
                Divider()
                NativeSettingsRow("Shortcut", detail: "Works in every app while the widget is on.") {
                    HotkeyRecorder(
                        chord: Binding(
                            get: { (prefs?.openShortcut ?? .defaultOpen).hotkey },
                            set: { chord in
                                patch(["openShortcut": .object([
                                    "keyCode": .number(Double(chord.keyCode)),
                                    "modifiers": .number(Double(chord.modifiers)),
                                ])])
                            }),
                        defaultChord: WidgetShortcutChord.defaultOpen.hotkey,
                        identifier: "widget.openShortcut")
                }
                .disabled(!(prefs?.openShortcutEnabled ?? true))
            }
            .nativeSettingsAnchor("shortcut")
            WidgetAgentHooksCard(bridge: model.bridge)
            }
        }.task { model.refreshSettings() }
    }

    /// The popup durations offered (0 is "Until closed"), plus a stored value that is none of them, so the picker
    /// never shows a blank.
    static func popupSecondsChoices(current: Int) -> [Int] {
        Array(Set([4, 7, 10, 15, 30, current]).subtracting([0])).sorted() + [0]
    }

    /// The note durations offered (0 is "Until closed"), plus a stored value that is none of them.
    static func noteSecondsChoices(current: Int) -> [Int] {
        let timed = Array(Set([3, 6, 10, 20, current]).subtracting([0])).sorted()
        return timed + [0]
    }

    /// A system sound picker with a play button. `same` adds "Same as decisions", stored as "same".
    private func soundPicker(_ key: String, _ value: String, same: Bool, label: String? = nil) -> some View {
        let played = value == "same" ? prefs?.alertSound ?? WidgetAlerts.defaultSound : value
        return HStack(spacing: 6) {
            Picker(label ?? (key == "alertSound" ? "Decision sound" : "Answer sound"), selection: string(key, value)) {
                if same { Text("Same as decisions").tag("same") }
                Text("None").tag("none")
                ForEach(WidgetAlerts.sounds, id: \.self) { Text($0).tag($0) }
            }.labelsHidden().frame(width: 160, alignment: .trailing)
            IconButton(systemName: "speaker.wave.2", tooltip: "Play this sound") {
                WidgetAlerts.preview(played, volume: WidgetAlerts.volume(prefs))
            }.disabled(played == "none")
        }
    }

    /// The filter each inbox list opens with.
    @ViewBuilder private var openingFilters: some View {
        Divider()
        NativeSettingsRow("Inbox of every session opens with", detail: "The filter the inbox button's list shows first.") {
            Picker("Inbox of every session opens with", selection: string("overviewFilter", prefs?.overviewFilter ?? "all")) {
                Text("All").tag("all")
                Text("Waiting").tag("needs")
                Text("Unread").tag("unread")
            }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
        }
        Divider()
        NativeSettingsRow("Session inbox opens with", detail: "The filter a session's inbox shows first.") {
            Picker("Session inbox opens with", selection: string("inboxFilter", prefs?.inboxFilter ?? "all")) {
                Text("All").tag("all")
                Text("Messages").tag("inbox")
                Text("Decisions").tag("decisions")
            }.labelsHidden().pickerStyle(.segmented).frame(width: 300, alignment: .trailing)
        }
    }

    private func string(_ key: String, _ value: String) -> Binding<String> {
        Binding(get: { value }, set: { patch([key: .string($0)]) })
    }
    private func boolean(_ key: String, _ value: Bool) -> Binding<Bool> {
        Binding(get: { value }, set: { patch([key: .bool($0)]) })
    }
    private func patch(_ values: [String: WidgetJSON]) {
        model.action(["action": "preferences", "patch": .object(values)])
    }
}

/// Settings → Automatic decisions: the decisions answered outside the widget in the last week, newest first. A row
/// names the decision, the option it took and who recorded it; Open shows its session in the widget.
private struct WidgetAnsweredElsewhereLog: View {
    @ObservedObject var model: WidgetModel
    let openSession: (WidgetSession) -> Void

    var body: some View {
        let items = model.inbox.answeredElsewhere ?? []
        VStack(alignment: .leading, spacing: 8) {
            Text("Last 7 days").font(.system(size: 13, weight: .semibold))
            if items.isEmpty {
                Text("No decision was answered outside the widget in the last 7 days.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(items, id: \.id) { item in row(item) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("widget.autoDecisionLog")
    }

    private func row(_ item: WidgetInboxItem) -> some View {
        let session = model.session(forKey: item.key)
        let picks = WidgetAlerts.answeredOptions(item).map { $0.letter + ") " + $0.text }
        let answer = picks.isEmpty ? item.answer ?? "" : picks.joined(separator: "; ")
        let when = Date(timeIntervalSince1970: item.at / 1000).formatted(.dateTime.month(.abbreviated).day().hour().minute())
        let details = [WidgetAlerts.answeredViaText(item.answeredVia), session?.title ?? "", when].filter { !$0.isEmpty }
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.bubble.fill").foregroundStyle(.green).padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text([WidgetAlerts.kicker(item).replacingOccurrences(of: " answered", with: ""), item.title ?? ""]
                    .filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                if !answer.isEmpty { Text(answer).font(.system(size: 12)).lineLimit(2) }
                Text(details.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if let session {
                Button("Open") { openSession(session) }
                    .help("Shows its session in the widget")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The widget's "show only these sessions" filter: `preferences.sessions`, which the snapshot reads as an allowlist
/// (`src/hub/lib/widget/snapshot.ts`, `hiddenByFilter`). Empty means every session may appear.
public enum WidgetSessionFilter {
    public static func adding(_ key: String, to keys: [String]) -> [String] {
        keys.contains(key) ? keys : keys + [key]
    }

    public static func removing(_ key: String, from keys: [String]) -> [String] {
        keys.filter { $0 != key }
    }

    /// The preferences patch that stores `keys` as the filter.
    public static func patch(_ keys: [String]) -> [String: WidgetJSON] {
        ["sessions": .array(keys.map(WidgetJSON.string))]
    }

    /// Sessions that can still be added, newest activity first. With no query only top-level sessions are offered;
    /// a query also finds sub-agents by title, project or provider.
    public static func candidates(_ sessions: [WidgetSession], excluding keys: [String], query: String,
                                  limit: Int = 8) -> [WidgetSession] {
        let chosen = Set(keys)
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return Array(sessions
            .filter { session in
                guard !chosen.contains(session.key) else { return false }
                if needle.isEmpty { return session.agentId == nil }
                return (session.title + " " + session.project + " " + session.target.provider)
                    .localizedCaseInsensitiveContains(needle)
            }
            .sorted { $0.activityAt > $1.activityAt }
            .prefix(limit))
    }
}

private struct WidgetSessionSettings: View {
    @ObservedObject var model: WidgetModel
    let openSession: (WidgetSession) -> Void
    @State private var query = ""
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }
    private var sessions: [WidgetSession] { model.snapshot?.sessions ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            previewCard
            NativeSettingsCard("Your sessions", subtitle: "Pin a session to keep it in the widget's rail. Click one to open it in the widget.") {
                WidgetSessionBrowser(model: model, onOpen: openSession)
            }
            filterCard
            WidgetSettingsError(model: model)
        }.task { model.refreshSettings() }
    }

    /// The agents hover list. Its settings button opens this page at `#inbox-preview`, and the card pulses.
    private var previewCard: some View {
        NativeSettingsCard("Inbox preview", subtitle: "The list that opens when the pointer rests on the agents button.") {
            NativeSettingsSegmented(
                "Show", identifier: "widget.preview.filter",
                options: WidgetPreviewChoices.filters,
                selection: Binding(get: { model.previewFilter }, set: { model.setPreview(filter: $0) }),
                minSegmentWidth: 96)
            NativeSettingsPicker(
                "Order", identifier: "widget.preview.sort",
                options: WidgetPreviewChoices.sorts,
                selection: Binding(get: { model.previewSort }, set: { model.setPreview(sort: $0) }))
        }
        .nativeSettingsAnchor("inbox-preview")
    }

    private var filterCard: some View {
        let selected = prefs?.sessions ?? []
        let projects = prefs?.projects ?? []
        return NativeSettingsCard("Show only these sessions", subtitle: "With sessions listed here, the widget shows only them. Leave the list empty to show every session.") {
            if selected.isEmpty {
                Text("Every session can appear in the widget.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(selected, id: \.self) { key in
                let session = sessions.first { $0.key == key }
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session?.title ?? "Session not in your recent list").font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        Text(session.map { $0.target.provider.capitalized + " · " + $0.project } ?? key)
                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    IconButton(systemName: "minus.circle", tooltip: "Stop filtering to \(session?.title ?? "this session")") {
                        patch(WidgetSessionFilter.patch(WidgetSessionFilter.removing(key, from: selected)))
                    }
                }
                .padding(.vertical, 3)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("widget.sessionFilter.selected")
            }
            Divider()
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Find a session to add", text: $query)
                    .textFieldStyle(.plain).font(.system(size: 12))
                    .accessibilityIdentifier("widget.sessionFilter.search")
                if !query.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search") { query = "" }
                }
            }.padding(10).nativeGlassControl(radius: 10)
            let candidates = WidgetSessionFilter.candidates(sessions, excluding: selected, query: query)
            if candidates.isEmpty {
                Text(query.isEmpty ? "No other sessions to add." : "No session matches “\(query)”.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            VStack(spacing: 2) {
                ForEach(candidates) { session in
                    Button {
                        patch(WidgetSessionFilter.patch(WidgetSessionFilter.adding(session.key, to: selected)))
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "plus.circle").foregroundStyle(Color.accentColor)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                Text(session.target.provider.capitalized + " · " + session.project)
                                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverRow())
                    .nativeSettingsPointer()
                    .accessibilityLabel("Show only " + session.title)
                }
            }
            Divider()
            HStack {
                Text(filterSummary(sessions: selected.count, projects: projects.count))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Clear all filters") { patch(["projects": [], "sessions": []]) }
                    .buttonStyle(.bordered)
                    .nativeSettingsPointer()
                    .disabled(selected.isEmpty && projects.isEmpty)
                    .accessibilityIdentifier("widget.filters.clear")
            }
        }
    }

    private func filterSummary(sessions: Int, projects: Int) -> String {
        switch (sessions, projects) {
        case (0, 0): return "No filters. Use Project filters above to limit the widget to some projects."
        case (_, 0): return sessions == 1 ? "1 session chosen." : "\(sessions) sessions chosen."
        case (0, _): return projects == 1 ? "1 project filter is on." : "\(projects) project filters are on."
        default: return "\(sessions) sessions and \(projects) project filters chosen."
        }
    }

    private func patch(_ values: [String: WidgetJSON]) {
        model.action(["action": "preferences", "patch": .object(values)])
    }
}

private struct WidgetProviderSettings: View {
    @ObservedObject var model: WidgetModel
    private let providers = ["claude", "codex", "grok", "unknown"]
    private var selected: [String] { model.snapshot?.state.preferences.providers ?? [] }
    var body: some View {
        VStack(spacing: 18) {
        WidgetSettingsLoading(model: model)
        if model.settingsLoaded {
        NativeSettingsCard("Coding agents", subtitle: "An empty filter shows every supported source.") {
            ForEach(providers, id: \.self) { provider in
                if provider != providers.first { Divider() }
                NativeSettingsToggle(
                    provider == "unknown" ? "External questions and answers" : provider.capitalized,
                    detail: provider == "unknown"
                        ? "Questions and answers from agents this app does not recognise, posted through the answer tool."
                        : nil,
                    identifier: "widget.provider.\(provider)",
                    isOn: Binding(
                        get: { selected.isEmpty || selected.contains(provider) },
                        set: { enabled in
                            var values = selected.isEmpty ? providers : selected
                            if enabled {
                                if !values.contains(provider) { values.append(provider) }
                            } else {
                                values.removeAll { $0 == provider }
                            }
                            if values.isEmpty {
                                model.error = "Keep at least one source enabled."
                                return
                            }
                            model.action([
                                "action": "preferences", "patch": ["providers": .array(values.map(WidgetJSON.string))],
                            ])
                        }))
            }
            Divider()
            Button("Show all providers") {
                model.action(["action": "preferences", "patch": ["providers": []]])
            }.buttonStyle(.bordered).nativeSettingsPointer().disabled(selected.isEmpty)
            WidgetSettingsError(model: model)
        }
        }
        }.task { model.refreshSettings() }
    }
}

private struct WidgetModuleSettings: View {
    @ObservedObject var model: WidgetModel
    let modules: [WidgetModuleChoice]
    var body: some View {
        VStack(spacing: 18) {
            WidgetSettingsLoading(model: model)
            if model.settingsLoaded {
                group("Top notch", index: nil)
                ForEach(0..<3) { index in group("Side group \(index + 1)", index: index) }
            }
            WidgetSettingsError(model: model)
        }.task { model.refreshSettings() }
    }
    private func group(_ title: String, index: Int?) -> some View {
        let placement = model.snapshot?.state.preferences.placement ?? "both"
        // "Visible edges" hides this edge, so a module change here showed nothing (Martin, 2026-10-22).
        let hidden = index == nil ? placement == "side" : placement == "top"
        return NativeSettingsCard(title) {
            if hidden {
                HStack(spacing: 10) {
                    Image(systemName: "eye.slash").foregroundStyle(.orange)
                    Text(index == nil
                         ? "The top notch is hidden: Visible edges is set to Side."
                         : "The side groups are hidden: Visible edges is set to Top.")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                    Button(index == nil ? "Show the top notch" : "Show the side groups") {
                        model.action(["action": "preferences", "patch": ["placement": "both"]])
                    }.buttonStyle(.bordered).nativeSettingsPointer()
                        .accessibilityIdentifier("widget.modules.\(index == nil ? "top" : "side").show")
                }
                Divider()
            }
            ForEach(modules) { module in
                let selected = index.map { model.layout.sideGroups[$0] } ?? model.layout.topModules
                NativeSettingsToggle(
                    module.title, detail: module.detail,
                    // One identifier per edge group: the same module appears in four cards on this page.
                    identifier: "widget.modules.\(index.map { "side\($0 + 1)" } ?? "top").\(module.id)",
                    isOn: Binding(
                        get: { selected.contains(module.id) },
                        set: { enabled in
                            var ids = selected
                            if enabled { ids.append(module.id) } else { ids.removeAll { $0 == module.id } }
                            if let index {
                                var groups = model.layout.sideGroups
                                groups[index] = WidgetLayoutConfiguration.unique(ids)
                                model.action([
                                    "action": "preferences",
                                    "patch": [
                                        "sideGroups": .array(groups.map { .array($0.map(WidgetJSON.string)) })
                                    ],
                                ])
                            } else {
                                model.action([
                                    "action": "preferences",
                                    "patch": [
                                        "topModules": .array(
                                            WidgetLayoutConfiguration.unique(ids).map(WidgetJSON.string))
                                    ],
                                ])
                            }
                        }))
            }
        }
    }
}

private struct VoiceConfiguration: Decodable {
    struct Provider: Decodable, Identifiable {
        struct Account: Decodable, Identifiable {
            var id: String
            var name: String
        }
        var id: String
        var title: String
        var defaultModel: String
        var models: [String]
        var accounts: [Account]
    }
    var providers: [Provider]
}

private struct WidgetDictationSettings: View {
    @ObservedObject var model: WidgetModel
    @State private var configuration: VoiceConfiguration?
    @State private var loading = false
    @State private var failure: String?
    @State private var language = ""
    @State private var languageSaved = false
    @State private var savedReset: Task<Void, Never>?
    @FocusState private var languageFocused: Bool
    @GenReduceMotion private var reduceMotion
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }
    private var provider: VoiceConfiguration.Provider? {
        configuration?.providers.first { $0.id == prefs?.voiceProvider }
    }

    var body: some View {
        VStack(spacing: 18) {
            WidgetSettingsLoading(model: model)
            if model.settingsLoaded {
            NativeSettingsCard("Live dictation", subtitle: "Text stays editable before you send it to an agent.") {
                if loading { ProgressView().controlSize(.small) }
                if let failure {
                    Text(failure).foregroundStyle(.orange).font(.caption)
                    Button("Try again") { Task { await load() } }.buttonStyle(.bordered)
                }
                NativeSettingsRow("Provider") {
                    Picker(
                        "Dictation provider",
                        selection: Binding(
                            get: { prefs?.voiceProvider ?? "xai" },
                            set: { patch(["voiceProvider": .string($0), "voiceAccount": .null, "voiceModel": .null]) })
                    ) {
                        ForEach(configuration?.providers ?? []) { item in Text(item.title).tag(item.id) }
                        // The stored choice stays visible while the provider list loads or when it is not offered.
                        if let current = prefs?.voiceProvider,
                            configuration?.providers.contains(where: { $0.id == current }) != true
                        {
                            Text(current).tag(current)
                        }
                    }.labelsHidden().frame(width: 230, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Account", detail: "Uses your existing enabled API accounts.") {
                    Picker(
                        "Dictation account",
                        selection: Binding(
                            get: { prefs?.voiceAccount ?? "" },
                            set: { patch(["voiceAccount": $0.isEmpty ? .null : .string($0)]) })
                    ) {
                        Text("Provider default").tag("")
                        ForEach(provider?.accounts ?? []) { item in Text(item.name).tag(item.id) }
                        if let missing = prefs?.voiceAccount,
                            provider?.accounts.contains(where: { $0.id == missing }) != true
                        {
                            Text("Unavailable — select another account").tag(missing)
                        }
                    }.labelsHidden().frame(width: 230, alignment: .trailing)
                }
                if provider?.accounts.isEmpty == true {
                    Text("No enabled API account for this provider. Add one in the Hub's AI account settings.")
                        .font(.caption).foregroundStyle(.orange)
                }
                Divider()
                NativeSettingsRow("Model") {
                    Picker(
                        "Dictation model",
                        selection: Binding(
                            get: { prefs?.voiceModel ?? "" },
                            set: { patch(["voiceModel": $0.isEmpty ? .null : .string($0)]) })
                    ) {
                        Text(provider.map { "Default · " + $0.defaultModel } ?? "Provider default").tag("")
                        ForEach(provider?.models ?? [], id: \.self) { Text($0).tag($0) }
                        if let custom = prefs?.voiceModel, provider?.models.contains(custom) != true {
                            Text(custom).tag(custom)
                        }
                    }.labelsHidden().frame(width: 280, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Language", detail: "A language code such as en or cs. Leave empty to detect it. Saved when you press Return or leave the field.") {
                    HStack(spacing: 8) {
                        if languageSaved {
                            Label("Saved", systemImage: "checkmark").font(.system(size: 11)).foregroundStyle(.secondary)
                                .transition(.opacity)
                        }
                        TextField("Automatic", text: $language).textFieldStyle(.roundedBorder).frame(width: 130)
                            .focused($languageFocused)
                            .onSubmit(saveLanguage)
                            .accessibilityIdentifier("widget.voiceLanguage")
                    }
                }
            }
            }
            WidgetSettingsError(model: model)
        }.task {
            model.refreshSettings()
            language = prefs?.voiceLanguage ?? ""
            await load()
        }
        .onChange(of: prefs?.voiceLanguage) { _, value in
            if !languageFocused { language = value ?? "" }
        }
        .onChange(of: languageFocused) { _, focused in
            if !focused { saveLanguage() }
        }
    }

    /// Stores the field when it changed, on Return or when focus leaves it. "Saved" shows for two seconds once the
    /// write is stored, never before it and never for a write that failed (the page shows that error instead).
    private func saveLanguage() {
        let value = language.trimmingCharacters(in: .whitespaces)
        language = value
        guard value != (prefs?.voiceLanguage ?? "") else { return }
        savedReset?.cancel()
        languageSaved = false
        model.updatePreferences(["voiceLanguage": .string(value)], saved: confirmLanguageSaved, failed: {
            savedReset?.cancel()
            languageSaved = false
        })
    }

    /// One timer: a second save restarts the two seconds instead of letting the first save's timer hide it early.
    private func confirmLanguageSaved() {
        // A fade is allowed under Reduce Motion, but the page keeps every setting change still (ux checklist, Motion).
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { languageSaved = true }
        savedReset?.cancel()
        savedReset = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { languageSaved = false }
        }
    }

    private func load() async {
        loading = true
        failure = nil
        defer { loading = false }
        do {
            let result = try await model.bridge.run(
                subcommand: "voice", args: ["configuration", "--json"], timeoutSeconds: 20)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
            guard !Task.isCancelled else { return }
            configuration = try JSONDecoder().decode(VoiceConfiguration.self, from: Data(result.stdout.utf8))
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
    private func patch(_ value: [String: WidgetJSON]) {
        model.action(["action": "preferences", "patch": .object(value)])
    }
}

/// What the Agents card reads from `tools agents hooks doctor --json`.
private struct AgentHooksDoctor: Decodable {
    struct Config: Decodable {
        struct Decisions: Decodable {
            var questionNudge: String?
            var harvestListed: Bool?
        }
        var decisions: Decisions
    }
    var config: Config
    var stopHookWired: Bool
}

/// The agents hooks' question nudge (`decisions.questionNudge` in `~/.genesis-tools/agents/hooks.json`) and whether
/// the inbox keeps the decisions it finds only in a reply (`decisions.harvestListed`), read and written through
/// `tools agents hooks`. The nudge writes `block` when on; a `warn` set from the CLI shows as on.
private struct WidgetAgentHooksCard: View {
    let bridge: ToolsBridge
    @State private var nudge: String?
    @State private var harvestListed: Bool?
    @State private var stopWired = true
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NativeSettingsCard("Agents", subtitle: "What the agents hooks do with the decisions an agent asks.") {
            NativeSettingsToggle(
                "Remind agents to log decisions",
                detail: "An agent that asks you to decide in its reply, without sending the decision to your inbox, is sent back once to send it.",
                identifier: "widget.agentsQuestionNudge",
                isOn: Binding(
                    get: { (nudge ?? "off") != "off" },
                    set: { on in Task { await run(["config", "set", "decisions.questionNudge", on ? "block" : "off", "--write"]) } }))
            .disabled(nudge == nil || busy)
            Divider()
            NativeSettingsToggle(
                "Keep decisions found in replies",
                detail: "The inbox saves a decision that an agent wrote only in its reply, so the widget and the hub show and answer the same decisions.",
                identifier: "widget.agentsHarvestListed",
                isOn: Binding(
                    get: { harvestListed ?? true },
                    set: { on in Task { await run(["config", "set", "decisions.harvestListed", on ? "true" : "false", "--write"]) } }))
            .disabled(harvestListed == nil || busy)
            if (nudge ?? "off") != "off" && !stopWired {
                Divider()
                NativeSettingsRow("Stop hook not installed", detail: "The reminder runs in the agents' Stop hook, which is not in your Claude Code settings yet.") {
                    Button("Install") { Task { await run(["install", "--write"]) } }
                        .disabled(busy).nativeSettingsPointer()
                }
            }
            if let failure {
                Text(failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let result = try await bridge.run(subcommand: "agents", args: ["hooks", "doctor", "--json"], timeoutSeconds: 20)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
            let doctor = try JSONDecoder().decode(AgentHooksDoctor.self, from: Data(result.stdout.utf8))
            nudge = doctor.config.decisions.questionNudge ?? "off"
            harvestListed = doctor.config.decisions.harvestListed ?? true
            stopWired = doctor.stopHookWired
            failure = nil
        } catch {
            if !Task.isCancelled { failure = "Could not read the agents hooks: \(error.localizedDescription)" }
        }
    }

    /// One `tools agents hooks …` write, then a fresh read so the card shows what the file now holds.
    private func run(_ args: [String]) async {
        busy = true
        defer { busy = false }
        do {
            let result = try await bridge.run(subcommand: "agents", args: ["hooks"] + args, timeoutSeconds: 30)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
        } catch {
            failure = error.localizedDescription
            return
        }
        await load()
    }
}

/// Stands in for the controls until the first snapshot with the stored preferences arrives, so a page never shows
/// the defaults as if they were your settings. A failed load offers a retry.
private struct WidgetSettingsLoading: View {
    @ObservedObject var model: WidgetModel
    var body: some View {
        if !model.settingsLoaded {
            HStack(spacing: 10) {
                if model.error == nil {
                    ProgressView().controlSize(.small)
                    Text("Loading your widget settings…").font(.system(size: 12)).foregroundStyle(.secondary)
                } else {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                    Text("Your widget settings could not be read.").font(.system(size: 12))
                }
                Spacer(minLength: 0)
                if model.error != nil {
                    Button("Try again") {
                        model.error = nil
                        model.refreshSettings()
                    }
                    .buttonStyle(.bordered).nativeSettingsPointer()
                }
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .nativeGlassSurface()
            .accessibilityIdentifier("widget.settings.loading")
        }
    }
}

private struct WidgetSettingsError: View {
    @ObservedObject var model: WidgetModel
    var body: some View {
        if let error = model.error {
            HStack {
                Image(systemName: "exclamationmark.triangle")
                Text(error).font(.caption).textSelection(.enabled)
                Spacer()
                Button("Dismiss") { model.error = nil }
            }.padding(10).background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

/// The hover list's filter and order choices, shared by the settings card and the list's own controls.
enum WidgetPreviewChoices {
    static let filters: [NativeSettingsOption<String>] = [
        .init("needs-you", "Waiting for you", detail: "Sessions with a question or decision waiting for your answer."),
        .init("active", "Active too", detail: "Also the sessions that work now or hold unread answers."),
    ]
    static let sorts: [NativeSettingsOption<String>] = [
        .init("attention", "Waiting first", detail: "Sessions that wait for you first, then working ones, newest first."),
        .init("recent", "Newest activity", detail: "The session that did something last comes first."),
        .init("project", "By project", detail: "Grouped by project name, newest first inside a project."),
    ]

    static func title(sort: String) -> String { sorts.first { $0.value == sort }?.title ?? sort }
    /// The one-word name the inbox header shows beside the sort button.
    static func shortTitle(sort: String) -> String {
        switch sort {
        case "attention": return "Waiting"
        case "recent": return "Newest"
        case "project": return "Project"
        default: return title(sort: sort)
        }
    }
}
