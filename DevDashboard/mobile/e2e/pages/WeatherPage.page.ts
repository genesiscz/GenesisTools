import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the standalone Weather screen (plan 09). Locates by the `testID`s on the screen +
 * the compact `WeatherCard` (accessibility-id via the `~` selector in BasePage).
 */
class WeatherPage extends BasePage {
    private readonly ids = {
        screen: "screen-weather",
        card: "weather-card",
        label: "weather-label",
        temp: "weather-temp",
        error: "weather-error",
    } as const;

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    async cardVisible(): Promise<boolean> {
        return this.isVisible(this.ids.card);
    }

    /** Either a temperature reading or the "Unavailable" error state is present. */
    async hasTempOrError(): Promise<boolean> {
        return (await this.byId(this.ids.temp).isExisting()) || (await this.byId(this.ids.error).isExisting());
    }

    /** True when a temperature reading rendered (the provider was reachable), vs the error state. */
    async hasTemp(): Promise<boolean> {
        return this.byId(this.ids.temp).isExisting();
    }

    /** True when the location label rendered with non-empty text (only present with a reading). */
    async hasLabel(): Promise<boolean> {
        return (await this.labelText()).length > 0;
    }

    async labelText(): Promise<string> {
        return this.byId(this.ids.label).getText();
    }
}

export const weatherPage = new WeatherPage();
