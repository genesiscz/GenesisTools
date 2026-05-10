import { migration001 } from "@app/shops/db/migrations/001-initial";
import { migration002 } from "@app/shops/db/migrations/002-descriptions";
import { migration003 } from "@app/shops/db/migrations/003-providers";
import type { Migration } from "@app/utils/database/migrations";

export const SHOPS_MIGRATIONS: Migration[] = [migration001, migration002, migration003];
