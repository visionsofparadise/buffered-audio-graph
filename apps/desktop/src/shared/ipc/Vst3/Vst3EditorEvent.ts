import { z } from "zod";

const readyEventSchema = z.object({ event: z.literal("ready") });
const openEventSchema = z.object({ event: z.literal("open"), path: z.string() });
const savedEventSchema = z.object({ event: z.literal("saved"), path: z.string() });
const closedEventSchema = z.object({ event: z.literal("closed") });

export const vst3EditorStdoutEventSchema = z.discriminatedUnion("event", [readyEventSchema, openEventSchema, savedEventSchema, closedEventSchema]);

export type Vst3EditorStdoutEvent = z.infer<typeof vst3EditorStdoutEventSchema>;

export interface Vst3EditorExitedEvent {
	readonly event: "exited";
	readonly code: number | null;
	readonly stderrTail: string;
}

export type Vst3EditorEvent = Vst3EditorStdoutEvent | Vst3EditorExitedEvent;

export interface Vst3EditorEventPayload {
	readonly launchId: string;
	readonly event: Vst3EditorEvent;
}

export const parseVst3EditorLine = (line: string): Vst3EditorStdoutEvent | undefined => {
	const trimmed = line.trim();

	if (trimmed.length === 0) return undefined;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		const result = vst3EditorStdoutEventSchema.safeParse(parsed);

		return result.success ? result.data : undefined;
	} catch {
		return undefined;
	}
};
