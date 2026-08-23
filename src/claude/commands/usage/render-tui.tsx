import { renderFullScreen } from "@genesiscz/utils/ink";
import { App } from "./app";

export async function renderUsageTui(accountFilter: string | undefined): Promise<void> {
    await renderFullScreen(<App accountFilter={accountFilter} />);
}
