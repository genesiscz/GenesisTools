import { ShopCrawler } from "./ShopCrawler";

export class MallCrawler extends ShopCrawler {
    readonly strategy = "mall-graphql";
}
