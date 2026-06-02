import { appPage } from "@e2e/pages/app.page";

// NOTE: a connected baseUrl gates the (tabs) group (Stack.Protected). For this smoke
// spec the app must boot into the tabs — either seed a baseUrl in a debug build or run
// the connect flow first (ConnectPage, added by plan 02). Until then this spec documents
// the expected post-connect state and is the harness later features extend.
describe("app boots", () => {
    it("shows the native tabs", async () => {
        expect(await appPage.tabsVisible()).toBe(true);
    });

    it("switches to the Terminals tab", async () => {
        await appPage.openTab("Terminals");
        await appPage.waitForVisible("screen-terminals");
    });
});
