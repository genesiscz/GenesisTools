/// One part of an edit for the undo menu: how to tell it changed, what a change of it is called, the tab that shows
/// it, and for a list how many items it holds (an add or a delete is named so). `EditorModel.changedParts` and
/// `changeName` read this one table, so a new EditProject field is one row.
struct EditPart {
    let key: String
    let name: String
    let tab: InspectorTab?
    let count: ((EditProject) -> Int)?
    let differs: (EditProject, EditProject) -> Bool

    init(_ key: String, _ name: String, _ tab: InspectorTab?, count: ((EditProject) -> Int)? = nil,
         differs: @escaping (EditProject, EditProject) -> Bool) {
        self.key = key
        self.name = name
        self.tab = tab
        self.count = count
        self.differs = differs
    }
}

enum EditParts {
    /// The camera bubble without its hidden parts, which are their own part (lane items).
    static func bubble(_ camera: EditProject.Camera?) -> EditProject.Camera? {
        camera.map { var bubble = $0; bubble.hidden = []; return bubble }
    }

    /// In the order the gesture key lists them.
    static let all: [EditPart] = [
        EditPart("clips", "Cut", .clip, count: { $0.clips.count }) { $0.clips != $1.clips },
        EditPart("zooms", "Zoom", .zoom, count: { $0.zooms.count }) { $0.zooms != $1.zooms },
        EditPart("audio", "Sound Change", .audio) { $0.audio != $1.audio },
        EditPart("export", "Export Settings", .export) { $0.export != $1.export },
        EditPart("clicks", "Click Style", .style) { $0.clicks != $1.clicks },
        EditPart("frame", "Background", .style) { $0.frame != $1.frame },
        EditPart("cursor", "Cursor Style", .cursor) { $0.cursor != $1.cursor },
        EditPart("captions", "Captions", .captions) { $0.captions != $1.captions },
        EditPart("keys", "Shortcuts", .captions) { $0.keys != $1.keys },
        EditPart("redactions", "Hidden Part", .hide, count: { $0.redactions?.count ?? 0 }) { $0.redactions != $1.redactions },
        EditPart("texts", "Text", .text, count: { $0.texts?.count ?? 0 }) { $0.texts != $1.texts },
        EditPart("shapes", "Shape", .text, count: { $0.shapes?.count ?? 0 }) { $0.shapes != $1.shapes },
        EditPart("transcript", "Caption Fix", .captions) { $0.transcript != $1.transcript },
        EditPart("motion", "Motion Blur", .zoom) { $0.motion != $1.motion },
        EditPart("lanes", "Lane Change", nil) { $0.lanes != $1.lanes },
        EditPart("camera", "Camera Bubble", .style) { bubble($0.camera) != bubble($1.camera) },
        EditPart("cameraHidden", "Camera-Hidden Part", .style, count: { $0.camera?.hidden.count ?? 0 }) {
            ($0.camera?.hidden ?? []) != ($1.camera?.hidden ?? [])
        },
        EditPart("markers", "Marker", nil, count: { $0.markers?.count ?? 0 }) { $0.markers != $1.markers },
        EditPart("transitions", "Transitions", .style) { $0.transitions != $1.transitions },
        EditPart("lens", "Lens", .style) { $0.lens != $1.lens },
        EditPart("tilt", "3D Tilt", .style) { $0.tilt != $1.tilt },
        // The intro and the end card are two ops (EditOpDiff), so two parts.
        EditPart("introCard", "Intro Card", .captions) { $0.cards?.intro != $1.cards?.intro },
        EditPart("endCard", "End Card", .captions) { $0.cards?.end != $1.cards?.end },
        EditPart("captionsStyle", "Caption Animation", .captions) { $0.captionsStyle != $1.captionsStyle },
        EditPart("progress", "Progress Bar", .captions) { $0.progress != $1.progress },
        EditPart("cursorSmooth", "Smooth Cursor", .cursor) { $0.cursorSmooth != $1.cursorSmooth },
        EditPart("autoSpeed", "Speed Badge", .clip) { $0.autoSpeed != $1.autoSpeed },
        EditPart("redactionJoins", "Hidden Part Edges", .hide) { $0.redactionJoins != $1.redactionJoins },
        EditPart("privacy", "Private Data", .hide) { $0.privacy != $1.privacy },
    ]
}
