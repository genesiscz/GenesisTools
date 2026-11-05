// Generated from the face declarations in src/macos/lib/permissions/parts.ts by
// `bun scripts/native/app-faces.ts --write` (a build writes it too). Do not edit it: change parts.ts.
// src/macos/lib/permissions/permissions.test.ts fails when this file and the declarations drift apart.

extension AppFaces {
    /// Every face: each part's faces in the order of APP_PARTS, then the host's own window.
    static let declared: [AppFace] = [
        AppFace(flag: "--features", aliases: ["--clicky"], part: "features", window: true, quit: .init(name: "Settings", order: 20)),
        AppFace(flag: "--hub", aliases: [], part: "hub", window: true, quit: .init(name: "Hub", order: 30)),
        AppFace(flag: "--review", aliases: [], part: "hub", window: true, quit: .init(name: "Review", order: 40)),
        AppFace(flag: "--widget", aliases: [], part: "widget", window: true, quit: .init(name: "Widget", order: 10)),
        AppFace(flag: "--markdown", aliases: [], part: "markdown", window: true, quit: .init(name: "Markdown viewer", order: 50)),
        AppFace(flag: "--recorder", aliases: [], part: "recorder", window: false, quit: nil),
        AppFace(flag: "--meetings", aliases: [], part: "meetings", window: true, quit: .init(name: "Meetings", order: 60)),
        AppFace(flag: "--window", aliases: [], part: nil, window: true, quit: .init(name: "Permissions", order: 100)),
    ]
}
