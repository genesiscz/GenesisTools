import { describe, expect, test } from "bun:test";
import { extractTeamFromUrl } from "@app/azure-devops/url-parser";

describe("extractTeamFromUrl", () => {
    test("reads the team from a backlog URL and decodes it", () => {
        expect(
            extractTeamFromUrl("https://dev.azure.com/contoso/Widgets/_backlogs/backlog/Payments%20Team/Stories")
        ).toBe("Payments Team");
    });

    test("reads the team from a sprint taskboard URL", () => {
        expect(
            extractTeamFromUrl(
                "https://dev.azure.com/contoso/Widgets/_sprints/taskboard/Payments%20Team/Widgets/Sprint%201"
            )
        ).toBe("Payments Team");
    });

    test("reads the team from a /_boards/board/t/ URL", () => {
        expect(extractTeamFromUrl("https://dev.azure.com/contoso/Widgets/_boards/board/t/Team%20A/Stories")).toBe(
            "Team A"
        );
    });

    test("reads the team from a /_boards/board/<team>/<level> URL", () => {
        expect(extractTeamFromUrl("https://dev.azure.com/contoso/Widgets/_boards/board/Team%20B/Stories")).toBe(
            "Team B"
        );
    });

    test("a team query parameter wins over the path", () => {
        expect(extractTeamFromUrl("https://dev.azure.com/contoso/Widgets/_workitems?team=Team%20D&view=list")).toBe(
            "Team D"
        );
    });

    test("a plus sign in the query parameter decodes to a space", () => {
        expect(extractTeamFromUrl("https://dev.azure.com/contoso/Widgets/_workitems?team=Team+D")).toBe("Team D");
    });

    test("returns null for a work item URL, which carries no team", () => {
        expect(extractTeamFromUrl("https://dev.azure.com/contoso/Widgets/_workitems/edit/12345")).toBeNull();
    });

    test("returns null for a query URL", () => {
        expect(
            extractTeamFromUrl(
                "https://dev.azure.com/contoso/Widgets/_queries/query/00000000-0000-0000-0000-000000000000"
            )
        ).toBeNull();
    });
});
