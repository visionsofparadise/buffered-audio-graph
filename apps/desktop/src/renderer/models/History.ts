import { applyPatch } from "fast-json-patch";
import { createMeta, createState, ref, type Group, type Op, type State } from "opshot";

export interface GraphMeta {
	replay?: boolean;
	external?: boolean;
	transactionKey?: string;
}

export const graphMeta = createMeta<GraphMeta>();

export interface HistoryBatch {
	state: State<object, GraphMeta, GraphMeta>;
	ops: Array<Op>;
}

export interface HistoryEntry {
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

export type History = State<HistoryData>;

export function createHistory(group: Group<GraphMeta, GraphMeta>): History {
	const history = createState<HistoryData>((mutate, get) => ({
		index: -1,
		stackLength: 0,
		stack: ref(new Array<HistoryEntry>()),
		undo: () => {
			const { index, stack } = get();
			const entry = stack[index];

			if (!entry) return;

			for (const batch of [...entry.batches].reverse()) {
				batch.state.mutate(
					(mutable) => {
						applyPatch(
							mutable,
							[...batch.ops].reverse().map((op) => op.undo),
						);
					},
					{ replay: true },
				);
			}

			mutate((mutable) => {
				mutable.index -= 1;
			});
		},
		redo: () => {
			const { index, stack } = get();
			const entry = stack[index + 1];

			if (!entry) return;

			for (const batch of entry.batches) {
				batch.state.mutate(
					(mutable) => {
						applyPatch(
							mutable,
							batch.ops.map((op) => op.do),
						);
					},
					{ replay: true },
				);
			}

			mutate((mutable) => {
				mutable.index += 1;
			});
		},
		get canUndo() {
			return this.index >= 0;
		},
		get canRedo() {
			return this.index < this.stackLength - 1;
		},
	}));

	group.subscribe((state, ops, meta) => {
		if (meta.replay) return;

		if (meta.external) {
			history.mutate((mutable) => {
				mutable.stack.splice(0);
				mutable.stackLength = 0;
				mutable.index = -1;
			});

			return;
		}

		history.mutate((mutable) => {
			const atTop = mutable.index === mutable.stack.length - 1;
			const current = mutable.stack[mutable.index];

			if (atTop && meta.transactionKey !== undefined && current?.transactionKey === meta.transactionKey) {
				const batch = current.batches.find((candidate) => candidate.state.op === state.op);

				if (batch) batch.ops.push(...ops);
				else current.batches.push({ state, ops: [...ops] });

				return;
			}

			mutable.stack.splice(mutable.index + 1);
			mutable.stack.push({ transactionKey: meta.transactionKey ?? crypto.randomUUID(), batches: [{ state, ops: [...ops] }] });
			mutable.stackLength = mutable.stack.length;
			mutable.index = mutable.stack.length - 1;
		});
	});

	return history;
}
