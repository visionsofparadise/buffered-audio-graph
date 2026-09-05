import { batch, createMutableState, flush, ignore, subscribe, type Operation } from "opshot";

export interface GraphMeta {
	replay?: boolean;
	external?: boolean;
	transactionKey?: string;
}

interface HistoryBatch {
	state: object;
	operations: Array<Operation>;
}

interface HistoryEntry {
	transactionKey: string;
	batches: Array<HistoryBatch>;
}

interface HistoryData {
	index: number;
	stackLength: number;
	stack: Array<HistoryEntry>;
	undo: () => void;
	redo: () => void;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
}

export type History = HistoryData;

interface MetaRun {
	meta: unknown;
	operations: Array<Operation>;
}

const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";

function isGraphMeta(meta: unknown): meta is GraphMeta {
	if (typeof meta !== "object" || meta === null) return false;

	const candidate = meta as Record<string, unknown>;

	return (
		isOptionalBoolean(candidate.replay) &&
		isOptionalBoolean(candidate.external) &&
		(candidate.transactionKey === undefined || typeof candidate.transactionKey === "string")
	);
}

const partitionByMeta = (operations: ReadonlyArray<Operation>): Array<MetaRun> => {
	const runs = new Array<MetaRun>();

	let run: MetaRun | undefined;

	for (const operation of operations) {
		if (run && operation.meta === run.meta) {
			run.operations.push(operation);

			continue;
		}

		run = { meta: operation.meta, operations: [operation] };

		runs.push(run);
	}

	return runs;
};

export function createHistory(states: ReadonlyArray<object>): History {
	function settle(): void {
		for (const state of states) flush(state);
	}

	function undo(): void {
		settle();

		const entry = history.stack[history.index];

		if (!entry) return;

		for (const historyBatch of [...entry.batches].reverse()) {
			batch(
				() => {
					for (const operation of [...historyBatch.operations].reverse()) {
						if ("before" in operation) Reflect.set(operation.node, operation.key, operation.before);
						else Reflect.deleteProperty(operation.node, operation.key);
					}
				},
				{ replay: true } satisfies GraphMeta,
			);
		}

		history.index -= 1;
	}

	function redo(): void {
		settle();

		const entry = history.stack[history.index + 1];

		if (!entry) return;

		for (const historyBatch of entry.batches) {
			batch(
				() => {
					for (const operation of historyBatch.operations) {
						if ("after" in operation) Reflect.set(operation.node, operation.key, operation.after);
						else Reflect.deleteProperty(operation.node, operation.key);
					}
				},
				{ replay: true } satisfies GraphMeta,
			);
		}

		history.index += 1;
	}

	const history = createMutableState<HistoryData>({
		index: -1,
		stackLength: 0,
		stack: ignore(new Array<HistoryEntry>()),
		undo,
		redo,
		get canUndo() {
			return this.index >= 0;
		},
		get canRedo() {
			return this.index < this.stackLength - 1;
		},
	});

	for (const state of states) {
		subscribe(state, (operations) => {
			for (const run of partitionByMeta(operations)) {
				const meta: GraphMeta = isGraphMeta(run.meta) ? run.meta : {};

				if (meta.replay) continue;

				if (meta.external) {
					history.stack.splice(0);
					history.stackLength = 0;
					history.index = -1;

					continue;
				}

				const atTop = history.index === history.stack.length - 1;
				const current = history.stack[history.index];

				if (atTop && meta.transactionKey !== undefined && current?.transactionKey === meta.transactionKey) {
					const historyBatch = current.batches.find((candidate) => candidate.state === state);

					if (historyBatch) historyBatch.operations.push(...run.operations);
					else current.batches.push({ state, operations: [...run.operations] });

					continue;
				}

				history.stack.splice(history.index + 1);
				history.stack.push({
					transactionKey: meta.transactionKey ?? crypto.randomUUID(),
					batches: [{ state, operations: [...run.operations] }],
				});
				history.stackLength = history.stack.length;
				history.index = history.stack.length - 1;
			}
		});
	}

	return history;
}
