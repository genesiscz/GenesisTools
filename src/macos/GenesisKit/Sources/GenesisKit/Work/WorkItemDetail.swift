/// The selected item from work.show, including the members when it is a handoff or epic.
public struct WorkItemDetail: Decodable, Equatable, Sendable {
    public struct Item: Decodable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var type: String
        public var state: String
        public var project: String?
        public var body: String?
        public var acceptance: String?
    }
    public var item: Item
    public var members: [WorkRowValue]?
}
