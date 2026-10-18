//
//  ClickyKeymap.swift
//  GenesisKit
//
//  The feature settings process menu (GenesisTools Parts/Features/FeaturesEntry.swift). Two app-wide keys. Clicky has no Help menu,
//  so this library is not opened from one.
//

import AppKit

@MainActor
public enum ClickyKeymap {
    public static let shared = Keymap(library: library)

    public static let settings = "clicky.app.settings"
    public static let quit = "clicky.app.quit"

    public static let library = KeymapLibrary(id: "clicky", title: "Clicky", commands: [
        KeymapCommand(settings, "Feature Settings", group: "App", keys: [.character(",", .command)], scope: .app),
        KeymapCommand(quit, "Quit", group: "App", keys: [.character("q", .command)], scope: .app, configurable: false),
    ])
}
