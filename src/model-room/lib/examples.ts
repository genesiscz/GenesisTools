import { type ModelDocument, readModelDocument } from "./document";

export function supportCapacityModel(): ModelDocument {
    return readModelDocument({
        format: "genesis-model-room",
        version: 1,
        id: "support_capacity",
        title: "Support capacity",
        description:
            "An illustrative backlog model. Arrivals and service capacity are assumptions, not a forecast. Stocks use explicit Euler integration and cannot fall below zero.",
        time: { unit: "day", duration: 10, step: 1 },
        quantities: [
            {
                id: "arrivals",
                label: "Daily arrivals",
                kind: "input",
                value: 90,
                unit: "tickets/day",
                range: { min: 0, max: 160, step: 5 },
                position: { x: 60, y: 60 },
            },
            {
                id: "agents",
                label: "Support agents",
                kind: "input",
                value: 4,
                unit: "people",
                range: { min: 1, max: 8, step: 1 },
                position: { x: 60, y: 250 },
            },
            {
                id: "productivity",
                label: "Tickets per agent",
                kind: "input",
                value: 25,
                unit: "tickets/person/day",
                range: { min: 5, max: 50, step: 1 },
                position: { x: 60, y: 410 },
            },
            {
                id: "capacity",
                label: "Service capacity",
                kind: "formula",
                expression: "agents * productivity",
                unit: "tickets/day",
                provenance: "identity",
                position: { x: 340, y: 270 },
            },
            {
                id: "backlog",
                label: "Waiting tickets",
                kind: "stock",
                initial: 80,
                derivative: "arrivals - capacity",
                min: 0,
                unit: "tickets",
                position: { x: 620, y: 100 },
            },
        ],
        scenarios: [
            { id: "three_agents", label: "Three agents", color: "#dfacff", overrides: { agents: 3 } },
            {
                id: "self_service",
                label: "Self-service on day 4",
                color: "#7adbc8",
                overrides: { agents: 3 },
                interventions: [{ at: 4, label: "Help center launches", values: { arrivals: 65 } }],
            },
        ],
        presentation: {
            controls: ["agents", "arrivals", "productivity"],
            outputs: ["backlog", "capacity"],
            steps: [
                {
                    title: "A small surplus",
                    text: "Four agents provide capacity for 100 tickets each day. With 90 arrivals, the backlog shrinks by 10 tickets per day.",
                    time: 6,
                },
                {
                    title: "One fewer agent",
                    text: "Three agents provide capacity for 75 tickets per day. The backlog grows by 15 tickets each day.",
                    scenario: "three_agents",
                    time: 6,
                },
                {
                    title: "Change the arrivals",
                    text: "Starting on day four, the help center reduces arrivals to 65 per day. The backlog begins to shrink again.",
                    scenario: "self_service",
                    time: 6,
                },
            ],
        },
    });
}

export function classroomModel(): ModelDocument {
    return readModelDocument({
        format: "genesis-model-room",
        version: 1,
        id: "classroom",
        title: "Community workshop",
        time: { unit: "week", duration: 12, step: 1 },
        description: "Compare room capacity with instructor preparation time. All inputs are illustrative assumptions.",
        quantities: [
            {
                id: "instructors",
                label: "Instructors",
                kind: "input",
                value: 3,
                unit: "people",
                range: { min: 1, max: 10, step: 1 },
                position: { x: 40, y: 50 },
            },
            {
                id: "available",
                label: "Hours per instructor",
                kind: "input",
                value: 12,
                unit: "hour/person/week",
                position: { x: 40, y: 230 },
            },
            {
                id: "preparation",
                label: "Preparation and teaching",
                kind: "input",
                value: 6,
                unit: "hour/class",
                position: { x: 40, y: 410 },
            },
            {
                id: "rooms",
                label: "Weekly room slots",
                kind: "input",
                value: 8,
                unit: "classes/week",
                position: { x: 340, y: 410 },
            },
            {
                id: "capacity",
                label: "Classes each week",
                kind: "formula",
                expression: "min(instructors * available / preparation, rooms)",
                unit: "classes/week",
                provenance: "identity",
                position: { x: 620, y: 180 },
            },
            {
                id: "taught",
                label: "Classes delivered",
                kind: "stock",
                initial: 0,
                derivative: "capacity",
                unit: "classes",
                position: { x: 900, y: 180 },
            },
        ],
        scenarios: [
            { id: "extra_room", label: "More room slots", overrides: { rooms: 12 } },
            { id: "extra_instructor", label: "One more instructor", overrides: { instructors: 4 } },
        ],
        presentation: { controls: ["instructors", "rooms", "preparation"], outputs: ["capacity", "taught"], steps: [] },
    });
}

export function projectBudgetModel(): ModelDocument {
    return readModelDocument({
        format: "genesis-model-room",
        version: 1,
        id: "project_budget",
        title: "Project runway",
        time: { unit: "week", duration: 16, step: 1 },
        description:
            "An illustrative project budget with recurring costs and a staffing scenario. Currency units cannot be combined without an explicit exchange-rate quantity.",
        quantities: [
            {
                id: "people",
                label: "Contributors",
                kind: "input",
                value: 4,
                unit: "people",
                range: { min: 1, max: 10, step: 1 },
                position: { x: 40, y: 50 },
            },
            {
                id: "cost",
                label: "Cost per contributor",
                kind: "input",
                value: 1800,
                unit: "USD/person/week",
                position: { x: 40, y: 240 },
            },
            {
                id: "hosting",
                label: "Hosting each week",
                kind: "input",
                value: 300,
                unit: "USD/week",
                position: { x: 40, y: 420 },
            },
            {
                id: "spend",
                label: "Weekly spending",
                kind: "formula",
                expression: "people * cost + hosting",
                unit: "USD/week",
                provenance: "identity",
                position: { x: 350, y: 160 },
            },
            {
                id: "remaining",
                label: "Budget remaining",
                kind: "stock",
                initial: 100000,
                derivative: "-spend",
                unit: "USD",
                position: { x: 640, y: 160 },
            },
        ],
        scenarios: [{ id: "lean_team", label: "Three contributors", overrides: { people: 3 } }],
        presentation: { controls: ["people", "cost", "hosting"], outputs: ["remaining", "spend"], steps: [] },
    });
}
