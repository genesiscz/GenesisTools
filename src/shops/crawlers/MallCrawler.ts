import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class MallCrawler extends ShopCrawler {
    readonly strategy = "mall-graphql";
}
