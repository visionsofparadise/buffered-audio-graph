export namespace Logger {
	export interface LogData {
		message: string;
		[key: string]: unknown;
	}

	export type BaseLogger = Record<Logger.Level, (data: string | LogData) => void>;

	export type Namespace = string;

	export interface EntryContext {
		namespace?: Namespace;
		action?: string;
		transactionId?: string;
		[key: string]: unknown;
	}

	export interface Entry {
		timestamp: string;
		level: Level;
		source: "main" | "renderer";
		message: string;
		context?: EntryContext;
		error?: {
			message: string;
			stack?: string;
			name?: string;
		};
	}

	export type Level = "debug" | "info" | "warn" | "error";
}

export class Logger {
	private static readonly LEVEL_PRIORITY: Record<Logger.Level, number> = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3,
	};

	static level: Logger.Level = "info";

	private static shouldLog(level: Logger.Level): boolean {
		return Logger.LEVEL_PRIORITY[level] >= Logger.LEVEL_PRIORITY[Logger.level];
	}

	private readonly source: "main" | "renderer";
	private readonly baseLogger: Logger.BaseLogger;
	private _context: Partial<Logger.EntryContext> = {};

	constructor(source: "main" | "renderer", baseLogger: Logger.BaseLogger = console) {
		this.source = source;
		this.baseLogger = baseLogger;
	}

	get context(): Partial<Logger.EntryContext> {
		return this._context;
	}

	setContext(context: Partial<Logger.EntryContext>): void {
		this._context = context;
	}

	createLogEntry(level: Logger.Level, message: string, context?: Logger.EntryContext, error?: Error): Logger.Entry {
		const entry: Logger.Entry = {
			timestamp: new Date().toISOString(),
			level,
			source: this.source,
			message,
			context: {
				...this._context,
				...context,
			},
		};

		if (error) {
			entry.error = {
				message: error.message,
				stack: error.stack,
				name: error.name,
			};
		}

		return entry;
	}

	private serialize(value: unknown): unknown {
		if (value === null || value === undefined) return value;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;

		if (value instanceof Error) {
			return { message: value.message, name: value.name, stack: value.stack };
		}

		if (Array.isArray(value)) {
			return value.map((item) => this.serialize(item));
		}

		if (typeof value === "object") {
			const result: Record<string, unknown> = {};

			for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
				result[key] = this.serialize(entry);
			}

			return result;
		}

		return `${value as number}`;
	}

	private toLogData(entry: Logger.Entry): Logger.LogData {
		const { message, context, ...rest } = entry;

		return this.serialize({
			message,
			...rest,
			...context,
		}) as Logger.LogData;
	}

	debug(message: string, context?: Logger.EntryContext): void {
		if (!Logger.shouldLog("debug")) return;
		const entry = this.createLogEntry("debug", message, context);

		this.baseLogger.debug(this.toLogData(entry));
	}

	info(message: string, context?: Logger.EntryContext): void {
		if (!Logger.shouldLog("info")) return;
		const entry = this.createLogEntry("info", message, context);

		this.baseLogger.info(this.toLogData(entry));
	}

	warn(message: string, context?: Logger.EntryContext): void {
		if (!Logger.shouldLog("warn")) return;
		const entry = this.createLogEntry("warn", message, context);

		this.baseLogger.warn(this.toLogData(entry));
	}

	error(message: string, error?: Error, context?: Logger.EntryContext): void {
		if (!Logger.shouldLog("error")) return;
		const entry = this.createLogEntry("error", message, context, error);

		this.baseLogger.error(this.toLogData(entry));
	}

	log(entry: Logger.Entry): void {
		const data = this.toLogData(entry);

		switch (entry.level) {
			case "debug":
				this.baseLogger.debug(data);
				break;
			case "info":
				this.baseLogger.info(data);
				break;
			case "warn":
				this.baseLogger.warn(data);
				break;
			case "error":
				this.baseLogger.error(data);
				break;
		}
	}

	static generateTransactionId(): string {
		return crypto.randomUUID();
	}
}
