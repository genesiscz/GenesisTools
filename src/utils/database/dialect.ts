import type { Database as BunDatabase } from "bun:sqlite";
import {
    CompiledQuery,
    type DatabaseConnection,
    type DatabaseIntrospector,
    type Dialect,
    type DialectAdapter,
    type Driver,
    type Kysely,
    type QueryCompiler,
    type QueryResult,
    SqliteAdapter,
    SqliteIntrospector,
    SqliteQueryCompiler,
} from "kysely";

export interface BunSqliteDialectConfig {
    database: BunDatabase | (() => BunDatabase | Promise<BunDatabase>);
    onCreateConnection?: (connection: DatabaseConnection) => Promise<void>;
}

export class BunSqliteDialect implements Dialect {
    readonly #config: BunSqliteDialectConfig;

    constructor(config: BunSqliteDialectConfig) {
        this.#config = Object.freeze({ ...config });
    }

    createDriver(): Driver {
        return new BunSqliteDriver(this.#config);
    }

    createQueryCompiler(): QueryCompiler {
        return new SqliteQueryCompiler();
    }

    createAdapter(): DialectAdapter {
        return new SqliteAdapter();
    }

    createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
        return new SqliteIntrospector(db);
    }
}

class BunSqliteDriver implements Driver {
    readonly #config: BunSqliteDialectConfig;
    readonly #mutex = new ConnectionMutex();
    #db?: BunDatabase;
    #connection?: BunSqliteConnection;

    constructor(config: BunSqliteDialectConfig) {
        this.#config = config;
    }

    async init(): Promise<void> {
        this.#db = typeof this.#config.database === "function" ? await this.#config.database() : this.#config.database;
        this.#connection = new BunSqliteConnection(this.#db);

        if (this.#config.onCreateConnection) {
            await this.#config.onCreateConnection(this.#connection);
        }
    }

    async acquireConnection(): Promise<DatabaseConnection> {
        await this.#mutex.lock();

        if (!this.#connection) {
            throw new Error("BunSqliteDriver not initialized");
        }

        return this.#connection;
    }

    async beginTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw("begin"));
    }

    async commitTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw("commit"));
    }

    async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw("rollback"));
    }

    async releaseConnection(): Promise<void> {
        this.#mutex.unlock();
    }

    async destroy(): Promise<void> {
        this.#db?.close();
    }
}

class BunSqliteConnection implements DatabaseConnection {
    readonly #db: BunDatabase;

    constructor(db: BunDatabase) {
        this.#db = db;
    }

    executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
        const { sql, parameters } = compiledQuery;
        const stmt = this.#db.prepare(sql);
        const params = parameters as unknown[];
        const isSelectLike = stmt.columnNames.length > 0;

        if (isSelectLike) {
            const rows = stmt.all(...(params as Parameters<typeof stmt.all>)) as R[];

            return Promise.resolve({ rows });
        }

        const result = stmt.run(...(params as Parameters<typeof stmt.run>));
        const changes = typeof result.changes === "number" ? BigInt(result.changes) : undefined;
        const insertId =
            typeof result.lastInsertRowid === "bigint"
                ? result.lastInsertRowid
                : typeof result.lastInsertRowid === "number"
                  ? BigInt(result.lastInsertRowid)
                  : undefined;

        return Promise.resolve({
            numAffectedRows: changes,
            insertId,
            rows: [] as R[],
        });
    }

    async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
        const { sql, parameters } = compiledQuery;
        const stmt = this.#db.prepare(sql);

        if (stmt.columnNames.length === 0) {
            throw new Error("BunSqliteDialect only supports streaming of select queries");
        }

        for (const row of stmt.iterate(...(parameters as Parameters<typeof stmt.iterate>))) {
            yield { rows: [row as R] };
        }
    }
}

class ConnectionMutex {
    #promise?: Promise<void>;
    #resolve?: () => void;

    async lock(): Promise<void> {
        while (this.#promise) {
            await this.#promise;
        }

        this.#promise = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    unlock(): void {
        const resolve = this.#resolve;
        this.#promise = undefined;
        this.#resolve = undefined;
        resolve?.();
    }
}
