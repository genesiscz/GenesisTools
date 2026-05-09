import type { ShopApiClient } from "../api/ShopApiClient";
import { AlbertCrawler } from "../crawlers/AlbertCrawler";
import { AlzaCrawler } from "../crawlers/AlzaCrawler";
import { BenuCrawler } from "../crawlers/BenuCrawler";
import { BillaCrawler } from "../crawlers/BillaCrawler";
import { DmCrawler } from "../crawlers/DmCrawler";
import { DrmaxCrawler } from "../crawlers/DrmaxCrawler";
import { HornbachCrawler } from "../crawlers/HornbachCrawler";
import { ItescoCrawler } from "../crawlers/ItescoCrawler";
import { KauflandCrawler } from "../crawlers/KauflandCrawler";
import { KnihyDobrovskyCrawler } from "../crawlers/KnihyDobrovskyCrawler";
import { KosikRestCrawler } from "../crawlers/KosikRestCrawler";
import { LidlCrawler } from "../crawlers/LidlCrawler";
import { MallCrawler } from "../crawlers/MallCrawler";
import { MojaDmCrawler } from "../crawlers/MojaDmCrawler";
import { MountfieldCrawler } from "../crawlers/MountfieldCrawler";
import { NotinoCrawler } from "../crawlers/NotinoCrawler";
import { PilulkaCrawler } from "../crawlers/PilulkaCrawler";
import { RohlikRestCrawler } from "../crawlers/RohlikRestCrawler";
import type { ShopCrawler } from "../crawlers/ShopCrawler";
import { TetaCrawler } from "../crawlers/TetaCrawler";
import type { ShopsDatabase } from "../db/ShopsDatabase";

export function createCrawlerForShop(client: ShopApiClient, db: ShopsDatabase): ShopCrawler {
    switch (client.shopOrigin) {
        case "rohlik.cz":
            return new RohlikRestCrawler(client, db);
        case "kosik.cz":
            return new KosikRestCrawler(client, db);
        case "kaufland.cz":
            return new KauflandCrawler(client, db);
        case "drmax.cz":
            return new DrmaxCrawler(client, db);
        case "benu.cz":
            return new BenuCrawler(client, db);
        case "itesco.cz":
            return new ItescoCrawler(client, db);
        case "dm.cz":
            return new DmCrawler(client, db);
        case "billa.cz":
            return new BillaCrawler(client, db);
        case "lidl.cz":
            return new LidlCrawler(client, db);
        case "tetadrogerie.cz":
            return new TetaCrawler(client, db);
        case "albert.cz":
            return new AlbertCrawler(client, db);
        case "alza.cz":
            return new AlzaCrawler(client, db);
        case "notino.cz":
            return new NotinoCrawler(client, db);
        case "mall.cz":
            return new MallCrawler(client, db);
        case "mountfield.cz":
            return new MountfieldCrawler(client, db);
        case "pilulka.cz":
            return new PilulkaCrawler(client, db);
        case "knihydobrovsky.cz":
            return new KnihyDobrovskyCrawler(client, db);
        case "hornbach.cz":
            return new HornbachCrawler(client, db);
        case "mojadm.sk":
            return new MojaDmCrawler(client, db);
        default:
            throw new Error(`no crawler registered for ${client.shopOrigin}`);
    }
}
