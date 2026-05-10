import type { Migration } from "@app/utils/database/migrations";
import { migration001 } from "@app/shops/db/migrations/001-initial";
import { migration002 } from "@app/shops/db/migrations/002-descriptions";

export const SHOPS_MIGRATIONS: Migration[] = [migration001, migration002];
