// Core types
export type LogLevel = {
    name: string;
    severity: number;
};

// LoggerPath represents the dot-notation path of a logger in the hierarchy
export type LoggerPath = string;

// Transport interface
export interface ITransport {
    log(props: {
        message: string;
        rawData: unknown[];
        level: LogLevel;
        namespace: string | null;
        path: LoggerPath;
        timestamp: Date;
        options?: Record<string, unknown>;
    }): void;
}

// Formatter interface
export interface IFormatter {
    format(props: {
        level: LogLevel;
        namespace: string | null;
        path: LoggerPath;
        timestamp: Date;
        data: unknown[];
    }): string;
}

// Configuration interface
export interface LoggerConfig {
    levels?: Record<string, number>;
    defaultLevel?: string;
    transports?: ITransport[];
    formatter?: IFormatter;
    enabled?: boolean;
    async?: boolean;
    asyncMethod?: (callback: () => void) => void;
    printLevel?: boolean;
    printTimestamp?: boolean;
    timestampFormat?: "time" | "local" | "utc" | "iso" | ((date: Date) => string);
    context?: Record<string, unknown>;
}

// Logger interface with specific log methods
export interface ILogger {
    // Standard log level methods
    silly(...data: unknown[]): boolean;
    debug(...data: unknown[]): boolean;
    info(...data: unknown[]): boolean;
    warn(...data: unknown[]): boolean;
    error(...data: unknown[]): boolean;

    // Core methods
    extend(namespace: string): ILogger;
    enable(namespaceOrPath?: string): boolean;
    disable(namespaceOrPath?: string): boolean;
    setSeverity(level: string): string;
    getSeverity(): string;

    // Tree structure methods
    getChildren(): ILogger[];
    getNamespace(): string | null;
    getPath(): LoggerPath;
    getParent(): ILogger | null;

    // Context methods
    setContext(context: Record<string, unknown>): void;
    getContext(): Record<string, unknown>;
    withContext(context: Record<string, unknown>): ILogger;

    // Transport methods
    addTransport(transport: ITransport): void;
    removeTransport(transport: ITransport): boolean;

    // Formatter method
    setFormatter(formatter: IFormatter): void;

    // Console patching
    patchConsole(): () => void;
}

// Helper function to stringify objects, errors, etc.
function stringify(data: unknown): string {
    if (data === null) return "null";
    if (data === undefined) return "undefined";

    if (typeof data === "string") return data;
    if (typeof data === "number" || typeof data === "boolean") return String(data);

    if (data instanceof Error) {
        return `${data.name}: ${data.message}\n${data.stack || ""}`;
    }

    if (typeof data === "function") {
        return `[Function: ${data.name || "anonymous"}]`;
    }

    try {
        return JSON.stringify(
            data,
            (key, value) => {
                if (value && typeof value === "object") {
                    return Object.getOwnPropertyNames(value).reduce((acc: Record<string, unknown>, prop) => {
                        acc[prop] = value[prop];
                        return acc;
                    }, {});
                }
                return value;
            },
            2
        );
    } catch (e) {
        return "[Object]";
    }
}

// Default formatter implementation
export const defaultFormatter: IFormatter = {
    format(props) {
        const { level, namespace, path, timestamp, data } = props;

        // Format timestamp based on configuration
        const timeStr = timestamp.toLocaleTimeString();

        // Format namespace and level
        const namespaceStr = namespace ? `[${namespace}]` : "";
        const pathStr = path && path !== namespace ? `(${path})` : "";
        const levelStr = level.name.toUpperCase();

        // Format message parts
        const messageParts = data.map((item) => {
            if (typeof item === "string") return item;
            return stringify(item);
        });

        // Combine all parts
        return `${timeStr} ${namespaceStr}${pathStr} ${levelStr}: ${messageParts.join(" ")}`;
    },
};

// Default async method
const defaultAsyncMethod = (callback: () => void) => {
    setTimeout(callback, 0);
};

// Main Logger class implementation
export class Logger implements ILogger {
    // Standard log level methods (will be dynamically set in constructor)
    silly!: (...data: unknown[]) => boolean;
    debug!: (...data: unknown[]) => boolean;
    info!: (...data: unknown[]) => boolean;
    warn!: (...data: unknown[]) => boolean;
    error!: (...data: unknown[]) => boolean;

    private _config: LoggerConfig;
    private _namespace: string | null;
    private _parent: Logger | null;
    private _children: Map<string, Logger> = new Map();
    private _levels: Record<string, LogLevel> = {};
    private _currentLevel: LogLevel;
    private _enabled: boolean;
    private _path: LoggerPath;
    private _context: Record<string, unknown> = {};

    /**
     * Constructor for Logger
     *
     * @param config - Logger configuration
     * @param namespace - Logger namespace (null for root logger)
     * @param parent - Parent logger (null for root logger)
     */
    constructor(config: LoggerConfig, namespace: string | null = null, parent: Logger | null = null) {
        // Apply defaults to configuration
        this._config = this._mergeWithDefaults(config);
        this._namespace = namespace;
        this._parent = parent;
        this._enabled = this._config.enabled ?? true;
        this._context = { ...(this._config.context || {}) };

        // Build the full path of this logger (dot notation)
        this._path = this._buildPath();

        // Setup log levels
        this._setupLevels();

        // Set initial severity level
        const defaultLevelName = this._config.defaultLevel || Object.keys(this._levels)[0];
        this._currentLevel = this._levels[defaultLevelName];

        // Create dynamic log methods
        this._createLogMethods();
    }

    /**
     * Create a child logger with the specified namespace
     *
     * @param namespace - Namespace for the child logger
     * @returns New logger instance that's a child of this logger
     */
    extend(namespace: string): Logger {
        // Check if this namespace already exists
        if (this._children.has(namespace)) {
            return this._children.get(namespace) as Logger;
        }

        // Create a new child logger
        const childLogger = new Logger({ ...this._config }, namespace, this);

        // Store reference to the child
        this._children.set(namespace, childLogger);

        return childLogger;
    }

    /**
     * Enable this logger or a specific child logger by path
     *
     * @param namespaceOrPath - Optional path to a child logger (dot notation)
     * @returns true if successful
     */
    enable(namespaceOrPath?: string): boolean {
        // If no path provided, enable this logger
        if (!namespaceOrPath) {
            this._enabled = true;
            return true;
        }

        // Handle dot notation paths (for nested loggers)
        if (namespaceOrPath.includes(".")) {
            const parts = namespaceOrPath.split(".");
            const childNamespace = parts[0];
            const remainingPath = parts.slice(1).join(".");

            const child = this._children.get(childNamespace);
            if (!child) {
                throw new Error(`Logger with namespace "${childNamespace}" not found`);
            }

            return child.enable(remainingPath);
        }

        // Enable a direct child
        const child = this._children.get(namespaceOrPath);
        if (!child) {
            throw new Error(`Logger with namespace "${namespaceOrPath}" not found`);
        }

        return child.enable();
    }

    /**
     * Disable this logger or a specific child logger by path
     *
     * @param namespaceOrPath - Optional path to a child logger (dot notation)
     * @returns true if successful
     */
    disable(namespaceOrPath?: string): boolean {
        // If no path provided, disable this logger
        if (!namespaceOrPath) {
            this._enabled = false;
            return true;
        }

        // Handle dot notation paths (for nested loggers)
        if (namespaceOrPath.includes(".")) {
            const parts = namespaceOrPath.split(".");
            const childNamespace = parts[0];
            const remainingPath = parts.slice(1).join(".");

            const child = this._children.get(childNamespace);
            if (!child) {
                throw new Error(`Logger with namespace "${childNamespace}" not found`);
            }

            return child.disable(remainingPath);
        }

        // Disable a direct child
        const child = this._children.get(namespaceOrPath);
        if (!child) {
            throw new Error(`Logger with namespace "${namespaceOrPath}" not found`);
        }

        return child.disable();
    }

    /**
     * Set the minimum severity level for this logger
     *
     * @param level - Level name to set as minimum
     * @returns The level name that was set
     */
    setSeverity(level: string): string {
        if (!(level in this._levels)) {
            throw new Error(`Level "${level}" not defined in this logger`);
        }

        this._currentLevel = this._levels[level];
        return level;
    }

    /**
     * Get the current minimum severity level name
     *
     * @returns Current level name
     */
    getSeverity(): string {
        return this._currentLevel.name;
    }

    /**
     * Get all child loggers
     *
     * @returns Array of child loggers
     */
    getChildren(): Logger[] {
        return Array.from(this._children.values());
    }

    /**
     * Get this logger's namespace
     *
     * @returns Namespace string or null for root logger
     */
    getNamespace(): string | null {
        return this._namespace;
    }

    /**
     * Get the full path of this logger (dot notation)
     *
     * @returns Path string
     */
    getPath(): LoggerPath {
        return this._path;
    }

    /**
     * Get the parent logger
     *
     * @returns Parent logger or null if this is the root
     */
    getParent(): Logger | null {
        return this._parent;
    }

    /**
     * Set context data for this logger
     *
     * @param context - Context object to set
     */
    setContext(context: Record<string, unknown>): void {
        this._context = { ...context };
    }

    /**
     * Get the current context data
     *
     * @returns Current context object
     */
    getContext(): Record<string, unknown> {
        // Combine with parent context if available
        if (this._parent) {
            return { ...this._parent.getContext(), ...this._context };
        }

        return { ...this._context };
    }

    /**
     * Create a new logger with added context
     *
     * @param additionalContext - Context to add
     * @returns New logger instance with combined context
     */
    withContext(additionalContext: Record<string, unknown>): Logger {
        // Create a new logger with the same config
        const newLogger = new Logger({ ...this._config }, this._namespace, this._parent);

        // Set the combined context
        newLogger.setContext({
            ...this.getContext(),
            ...additionalContext,
        });

        return newLogger;
    }

    /**
     * Patch the global console object to use this logger
     *
     * @returns Function to restore the original console
     */
    patchConsole(): () => void {
        // Store original console methods
        const originalConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
        };

        // Map console methods to our methods
        console.log = this.debug.bind(this);
        console.info = this.info.bind(this);
        console.warn = this.warn.bind(this);
        console.error = this.error.bind(this);
        console.debug = this.debug.bind(this);

        // Return function to restore original console
        return () => {
            console.log = originalConsole.log;
            console.info = originalConsole.info;
            console.warn = originalConsole.warn;
            console.error = originalConsole.error;
            console.debug = originalConsole.debug;
        };
    }

    /**
     * Add a transport to this logger
     *
     * @param transport - Transport to add
     */
    addTransport(transport: ITransport): void {
        if (!this._config.transports) {
            this._config.transports = [];
        }

        this._config.transports.push(transport);
    }

    /**
     * Remove a transport from this logger
     *
     * @param transport - Transport to remove
     * @returns true if the transport was found and removed
     */
    removeTransport(transport: ITransport): boolean {
        if (!this._config.transports) {
            return false;
        }

        const index = this._config.transports.indexOf(transport);
        if (index === -1) {
            return false;
        }

        this._config.transports.splice(index, 1);
        return true;
    }

    /**
     * Set a custom formatter for this logger
     *
     * @param formatter - Formatter to use
     */
    setFormatter(formatter: IFormatter): void {
        this._config.formatter = formatter;
    }

    /**
     * Merge provided config with defaults
     *
     * @param config - User-provided config
     * @returns Config with defaults applied
     */
    private _mergeWithDefaults(config: LoggerConfig): LoggerConfig {
        // Default levels if not provided
        const defaultLevels: Record<string, number> = {
            silly: 0,
            debug: 1,
            info: 2,
            warn: 3,
            error: 4,
        };

        const levels = config.levels || defaultLevels;
        const defaultLevel = config.defaultLevel || "info";

        return {
            levels,
            defaultLevel,
            transports: config.transports || [],
            formatter: config.formatter || defaultFormatter,
            enabled: config.enabled !== undefined ? config.enabled : true,
            async: config.async !== undefined ? config.async : false,
            asyncMethod: config.asyncMethod || defaultAsyncMethod,
            printLevel: config.printLevel !== undefined ? config.printLevel : true,
            printTimestamp: config.printTimestamp !== undefined ? config.printTimestamp : true,
            timestampFormat: config.timestampFormat || "time",
            context: config.context || {},
        };
    }

    /**
     * Build the full path for this logger
     *
     * @returns Dot notation path
     */
    private _buildPath(): LoggerPath {
        if (this._parent && this._parent._path && this._namespace) {
            // If parent has a path, combine with namespace
            return `${this._parent._path}.${this._namespace}`;
        }

        // Root logger or direct child of root
        return this._namespace || "root";
    }

    /**
     * Set up log levels based on configuration
     */
    private _setupLevels(): void {
        const levels = this._config.levels as Record<string, number>;

        // Create LogLevel objects for each level
        Object.keys(levels).forEach((levelName) => {
            this._levels[levelName] = {
                name: levelName,
                severity: levels[levelName],
            };
        });
    }

    /**
     * Create dynamic log methods for each level
     */
    private _createLogMethods(): void {
        // Ensure all standard methods are available
        const requiredMethods = ["silly", "debug", "info", "warn", "error"];
        const configuredLevels = Object.keys(this._levels);

        // Set up each required method
        requiredMethods.forEach((methodName) => {
            let levelToUse = methodName;

            // If this exact level doesn't exist in configuration, map to closest available
            if (!configuredLevels.includes(methodName)) {
                // Find the closest match or use the lowest severity level
                if (methodName === "silly" && configuredLevels.includes("debug")) {
                    levelToUse = "debug";
                } else if (methodName === "debug" && configuredLevels.includes("info")) {
                    levelToUse = "info";
                } else if (methodName === "info" && configuredLevels.includes("warn")) {
                    levelToUse = "warn";
                } else if (methodName === "warn" && configuredLevels.includes("error")) {
                    levelToUse = "error";
                } else {
                    // Default to first available level
                    levelToUse = configuredLevels[0];
                }
            }

            // Create the method (dynamic assignment requires type assertion)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any)[methodName] = (...data: unknown[]): boolean => {
                return this._log(levelToUse, data);
            };
        });

        // Add any other configured levels that aren't standard
        configuredLevels.forEach((levelName) => {
            if (!requiredMethods.includes(levelName)) {
                // Dynamic method assignment requires type assertion
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any)[levelName] = (...data: unknown[]): boolean => {
                    return this._log(levelName, data);
                };
            }
        });
    }

    /**
     * Core logging method that handles all logging logic
     *
     * @param levelName - Level to log at
     * @param data - Data to log
     * @returns true if log was processed, false if filtered
     */
    private _log(levelName: string, data: unknown[]): boolean {
        // Skip if logger is disabled
        if (!this._enabled) {
            return false;
        }

        const level = this._levels[levelName];

        // Skip if level is below current minimum severity
        if (level.severity < this._currentLevel.severity) {
            return false;
        }

        // Handle async logging if configured
        if (this._config.async) {
            const asyncMethod = this._config.asyncMethod || defaultAsyncMethod;
            asyncMethod(() => {
                this._processLog(level, data);
            });
            return true;
        }

        // Synchronous logging
        return this._processLog(level, data);
    }

    /**
     * Process a log entry and send to all transports
     *
     * @param level - Level to log at
     * @param data - Data to log
     * @returns true if log was processed
     */
    private _processLog(level: LogLevel, data: unknown[]): boolean {
        // Create timestamp
        const timestamp = new Date();

        // Add context to data if present
        const contextData = { ...this.getContext() };
        const hasContext = Object.keys(contextData).length > 0;

        // Combine data with context if needed
        const fullData = hasContext ? [...data, { context: contextData }] : data;

        // Format the message
        const formatter = this._config.formatter || defaultFormatter;
        const message = formatter.format({
            level,
            namespace: this._namespace,
            path: this._path,
            timestamp,
            data: fullData,
        });

        // Send to all transports
        const transports = this._config.transports || [];
        transports.forEach((transport) => {
            transport.log({
                message,
                rawData: fullData,
                level,
                namespace: this._namespace,
                path: this._path,
                timestamp,
                options: {},
            });
        });

        return true;
    }
}

/**
 * Factory function to create a new logger
 *
 * @param config - Logger configuration
 * @returns Configured logger instance
 */
export function createLogger(config: LoggerConfig = {}): Logger {
    return new Logger(config);
}

// Define default exports
export default {
    createLogger,
    defaultFormatter,
};

// Define core transports
export const consoleTransport: ITransport = {
    log(props) {
        const { message, level } = props;

        // Use appropriate console method based on level
        switch (level.name) {
            case "error":
                console.error(message);
                break;
            case "warn":
            case "warning":
                console.warn(message);
                break;
            case "info":
                console.info(message);
                break;
            case "debug":
            case "silly":
                console.log(message);
                break;
            default:
                console.log(message);
        }
    },
};

export const fileTransport = (options: { filePath: string; append?: boolean; encoding?: string }): ITransport => ({
    log(props) {
        // Here you would implement file writing logic
        // Using appropriate React Native or Node.js APIs
        const { message } = props;

        // This is a placeholder for actual file writing
        // You would replace this with platform-specific implementation
        console.log(`[FILE TRANSPORT] Would write to ${options.filePath}: ${message}`);
    },
});
