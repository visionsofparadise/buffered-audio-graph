export type Vst3ScanEntryStatus = "pending" | "ready" | "error";

export interface Vst3ScanEntry {
	readonly entryKey: string;
	readonly name: string;
	readonly modulePath: string;
	readonly rootPath: string;
	readonly vendorFolder: string;
	readonly className?: string;
	readonly status: Vst3ScanEntryStatus;
	readonly error?: string;
}

export const buildEntryKey = (modulePath: string, className?: string): string => (className === undefined ? modulePath : `${modulePath}::${className}`);
