/**
 * Shared database utilities
 * Exports PowerSync database instance and connector
 */
export { db, APP_SCHEMA, initializeDatabase, syncToServer, isDatabaseInitialized } from './powersync'
export { DashboardConnector } from './powersync-connector'
