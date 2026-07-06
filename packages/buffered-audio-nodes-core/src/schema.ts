export interface FileInputMeta {
	readonly input: "file" | "folder";
	readonly mode?: "open" | "save";
	readonly accept?: string;
	readonly binary?: string;
	readonly download?: string;
}

export type { ZodType as NodeSchema } from "zod";
