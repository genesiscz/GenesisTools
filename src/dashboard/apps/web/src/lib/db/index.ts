/**
 * Shared database utilities
 * Exports PowerSync database instance and connector
 */
export { APP_SCHEMA, db, initializeDatabase, isDatabaseInitialized, syncToServer } from "./powersync";
export { DashboardConnector } from "./powersync-connector";
