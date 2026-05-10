import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class AlbertCrawler extends ShopCrawler {
    readonly strategy = "albert-graphql";
}
