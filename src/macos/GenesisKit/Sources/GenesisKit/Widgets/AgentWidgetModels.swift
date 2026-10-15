import SwiftUI

public enum AgentWidgetStatus: String {
    case working, waiting, finished, recent
    public var label: String {
        switch self {
        case .working: return "Working"
        case .waiting: return "Needs your answer"
        case .finished: return "Finished"
        case .recent: return "Recent activity"
        }
    }
    public var color: Color {
        switch self {
        case .working: return Color(red: 0.23, green: 0.62, blue: 1)
        case .waiting: return Color(red: 1, green: 0.76, blue: 0.32)
        case .finished: return Color(red: 0.24, green: 0.84, blue: 0.48)
        case .recent: return .gray
        }
    }
}

public struct AgentWidgetChoice: Identifiable {
    public let id: String
    public let title: String
    public let detail: String
    public let recommended: Bool
    public init(id: String, title: String, detail: String = "", recommended: Bool = false) {
        self.id = id
        self.title = title
        self.detail = detail
        self.recommended = recommended
    }
}

public struct AgentWidgetItem: Identifiable {
    public let id: String
    public let provider: String
    public let project: String
    public let title: String
    public let request: String
    public let context: String
    public let question: String
    public var status: AgentWidgetStatus
    public let choices: [AgentWidgetChoice]
    public init(
        id: String, provider: String, project: String, title: String, request: String,
        context: String, question: String, status: AgentWidgetStatus, choices: [AgentWidgetChoice] = []
    ) {
        self.id = id
        self.provider = provider
        self.project = project
        self.title = title
        self.request = request
        self.context = context
        self.question = question
        self.status = status
        self.choices = choices
    }
}

public struct AgentWidgetActions {
    public var expand: () -> Void
    public var collapse: () -> Void
    public var select: (String) -> Void
    public var choose: (String) -> Void
    public var submit: () -> Void
    public var settings: () -> Void
    public var next: () -> Void
    public init(
        expand: @escaping () -> Void, collapse: @escaping () -> Void,
        select: @escaping (String) -> Void,
        choose: @escaping (String) -> Void, submit: @escaping () -> Void,
        settings: @escaping () -> Void,
        next: @escaping () -> Void
    ) {
        self.expand = expand
        self.collapse = collapse
        self.select = select
        self.choose = choose
        self.submit = submit
        self.settings = settings
        self.next = next
    }
}

