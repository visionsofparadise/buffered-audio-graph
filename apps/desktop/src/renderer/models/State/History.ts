import { ref, subscribe, unstable_enableOp, type INTERNAL_Op } from "valtio/vanilla";
import type { Snapshot } from "valtio/vanilla";
import type { Mutable, State } from ".";
import type { ProxyStore } from "../ProxyStore/ProxyStore";

export type ValtioOp = INTERNAL_Op;

interface HistoryEntry {
	readonly ops: Array<ValtioOp>;
	readonly proxy: object;
}

export interface History extends State {
	_index: number;
	_stack: Array<string>;
	_entries: Map<string, HistoryEntry>;

	mutate<T extends State>(
		snap: Snapshot<T>,
		callback: (proxy: Mutable<T>) => void,
		options?: { transactionKey?: string },
	): void;
	undo(): void;
	redo(): void;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
}

function applyOp(proxy: Record<string | symbol, unknown>, op: ValtioOp, isUndo: boolean): void {
	const path = op[1];
	const target = path.slice(0, -1).reduce<Record<string | symbol, unknown>>(
		(node, key) => node[key] as Record<string | symbol, unknown>,
		proxy,
	);
	const leaf = path[path.length - 1];

	if (leaf === undefined) return;

	if (op[0] === "set") {
		const value = isUndo ? op[3] : op[2];

		target[leaf] = value;
	} else {
		if (isUndo) {
			target[leaf] = op[2];
		} else {
			Reflect.deleteProperty(target, leaf);
		}
	}
}

export function createHistory(store: ProxyStore): History {
	unstable_enableOp(true);

	return store.createState<History>({
		_index: -1,
		_stack: ref([] as Array<string>),
		_entries: ref(new Map<string, HistoryEntry>()),

		mutate<T extends State>(
			this: History,
			snap: Snapshot<T>,
			callback: (proxy: Mutable<T>) => void,
			options?: { transactionKey?: string },
		): void {
			const historyProxy = store.dangerouslyGetProxy<History>(this._key);
			const target = store.dangerouslyGetProxy<object>(snap._key);

			if (!historyProxy || !target) {
				throw new Error("History.mutate: proxy not found");
			}

			const captured: Array<ValtioOp> = [];
			const unsubscribe = subscribe(
				target,
				(ops) => {
					for (const op of ops) captured.push(op);
				},
				true,
			);

			try {
				store.mutate<T>(snap, callback);
			} finally {
				unsubscribe();
			}

			if (captured.length === 0) return;

			const topKey = historyProxy._stack[historyProxy._index];
			const transactionKey = options?.transactionKey;

			if (transactionKey !== undefined && topKey === transactionKey) {
				const existing = historyProxy._entries.get(transactionKey);

				if (existing) {
					historyProxy._entries.set(transactionKey, {
						ops: [...existing.ops, ...captured],
						proxy: target,
					});

					return;
				}
			}

			const key = transactionKey ?? crypto.randomUUID();

			historyProxy._stack = historyProxy._stack.slice(0, historyProxy._index + 1);
			for (const droppedKey of historyProxy._stack.slice(historyProxy._index + 1)) {
				historyProxy._entries.delete(droppedKey);
			}

			historyProxy._stack.push(key);
			historyProxy._entries.set(key, { ops: captured, proxy: target });
			historyProxy._index = historyProxy._stack.length - 1;
		},

		undo(this: History): void {
			const historyProxy = store.dangerouslyGetProxy<History>(this._key);

			if (!historyProxy) return;
			if (historyProxy._index < 0) return;

			const key = historyProxy._stack[historyProxy._index];

			if (key === undefined) return;

			const entry = historyProxy._entries.get(key);

			if (!entry) return;

			for (let cursor = entry.ops.length - 1; cursor >= 0; cursor--) {
				const op = entry.ops[cursor];

				if (op === undefined) continue;

				applyOp(entry.proxy as Record<string | symbol, unknown>, op, true);
			}

			historyProxy._index = historyProxy._index - 1;
		},

		redo(this: History): void {
			const historyProxy = store.dangerouslyGetProxy<History>(this._key);

			if (!historyProxy) return;
			if (historyProxy._index >= historyProxy._stack.length - 1) return;

			const nextIndex = historyProxy._index + 1;
			const key = historyProxy._stack[nextIndex];

			if (key === undefined) return;

			const entry = historyProxy._entries.get(key);

			if (!entry) return;

			for (const op of entry.ops) {
				applyOp(entry.proxy as Record<string | symbol, unknown>, op, false);
			}

			historyProxy._index = nextIndex;
		},

		get canUndo(): boolean {
			return this._index >= 0;
		},

		get canRedo(): boolean {
			return this._index < this._stack.length - 1;
		},
	});
}
