import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class MountfieldCrawler extends ShopCrawler {
    readonly strategy = "mountfield-html";
}
