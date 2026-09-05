import { batch, createMutableState, flush, subscribe } from "opshot";
import { describe, expect, it } from "vitest";

import { createHistory } from "./History";

const createFixture = () => {
	const definition = createMutableState({
		name: "g",
		nodes: new Array<{ id: string; parameters: Record<string, unknown> }>(),
		edges: new Array<{ from: string; to: string }>(),
	});
	const positions = createMutableState({ positions: {} as Record<string, { x: number; y: number }> });
	const history = createHistory([definition, positions]);

	const settle = () => {
		flush(definition);
		flush(positions);
		flush(history);
	};

	return { definition, positions, history, settle };
};

describe("History", () => {
	it("records one entry for a mutation", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "renamed";
		settle();

		expect(history.canUndo).toBe(true);
		expect(history.stack).toHaveLength(1);
		expect(history.stackLength).toBe(1);
	});

	it("undo restores the previous value and redo replays it", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "renamed";
		settle();

		history.undo();
		settle();

		expect(definition.name).toBe("g");

		history.redo();
		settle();

		expect(definition.name).toBe("renamed");
	});

	it("exact-restores the document across push, nested write, and splice", () => {
		const { definition, history, settle } = createFixture();

		definition.nodes.push({ id: "gain-1", parameters: {} });
		settle();

		const node = definition.nodes[0];

		if (node) node.parameters.amount = 0.5;

		settle();

		definition.nodes.splice(0, 1);
		settle();

		history.undo();
		settle();

		expect(JSON.stringify(definition.nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: { amount: 0.5 } }]));

		history.undo();
		settle();

		expect(JSON.stringify(definition.nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: {} }]));

		history.undo();
		settle();

		expect(JSON.stringify(definition)).toBe(JSON.stringify({ name: "g", nodes: [], edges: [] }));

		history.redo();
		settle();

		expect(JSON.stringify(definition.nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: {} }]));

		history.redo();
		settle();

		expect(JSON.stringify(definition.nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: { amount: 0.5 } }]));

		history.redo();
		settle();

		expect(JSON.stringify(definition)).toBe(JSON.stringify({ name: "g", nodes: [], edges: [] }));
		expect(history.canRedo).toBe(false);
	});

	it("coalesces definition and positions writes under one transactionKey into one entry", () => {
		const { definition, positions, history, settle } = createFixture();

		const transactionKey = "add-node-1";

		batch(
			() => {
				definition.nodes.push({ id: "gain-1", parameters: {} });
			},
			{ transactionKey },
		);

		batch(
			() => {
				positions.positions["gain-1"] = { x: 10, y: 20 };
			},
			{ transactionKey },
		);

		settle();

		expect(history.stack).toHaveLength(1);

		history.undo();
		settle();

		expect(definition.nodes).toHaveLength(0);
		expect(positions.positions["gain-1"]).toBeUndefined();
		expect(history.canUndo).toBe(false);

		history.redo();
		settle();

		expect(JSON.stringify(definition.nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: {} }]));
		expect(positions.positions["gain-1"]).toEqual({ x: 10, y: 20 });
	});

	it("concatenates same-key emissions into the top entry and opens a new entry for a different key", () => {
		const { positions, history, settle } = createFixture();

		batch(
			() => {
				positions.positions["a"] = { x: 1, y: 1 };
			},
			{ transactionKey: "drag-1" },
		);

		settle();

		batch(
			() => {
				positions.positions["a"] = { x: 2, y: 2 };
			},
			{ transactionKey: "drag-1" },
		);

		settle();

		expect(history.stack).toHaveLength(1);

		batch(
			() => {
				positions.positions["a"] = { x: 3, y: 3 };
			},
			{ transactionKey: "drag-2" },
		);

		settle();

		expect(history.stack).toHaveLength(2);

		history.undo();
		settle();

		expect(positions.positions["a"]).toEqual({ x: 2, y: 2 });

		history.undo();
		settle();

		expect(positions.positions["a"]).toBeUndefined();
	});

	it("appends into the existing same-state batch when states interleave under one key", () => {
		const { definition, positions, history, settle } = createFixture();

		const transactionKey = "insert-1";

		batch(
			() => {
				definition.nodes.push({ id: "a", parameters: {} });
			},
			{ transactionKey },
		);

		settle();

		batch(
			() => {
				positions.positions["a"] = { x: 1, y: 1 };
			},
			{ transactionKey },
		);

		settle();

		batch(
			() => {
				definition.nodes.push({ id: "b", parameters: {} });
			},
			{ transactionKey },
		);

		settle();

		const entry = history.stack[0];

		expect(history.stack).toHaveLength(1);
		expect(entry?.batches).toHaveLength(2);

		history.undo();
		settle();

		expect(definition.nodes).toHaveLength(0);
		expect(positions.positions["a"]).toBeUndefined();
	});

	it("a new mutation after undo truncates forward history", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "one";
		settle();

		definition.name = "two";
		settle();

		history.undo();
		settle();

		definition.name = "three";
		settle();

		expect(history.canRedo).toBe(false);
		expect(history.stack).toHaveLength(2);

		history.redo();
		settle();

		expect(definition.name).toBe("three");
	});

	it("replays are not recorded", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "renamed";
		settle();

		expect(history.stack).toHaveLength(1);

		history.undo();
		settle();

		expect(history.stack).toHaveLength(1);

		history.redo();
		settle();

		expect(history.stack).toHaveLength(1);
	});

	it("records only the user run when a replay run and a user run share one window", () => {
		const { definition, history, settle } = createFixture();

		batch(
			() => {
				definition.name = "replayed";
			},
			{ replay: true },
		);

		definition.edges.push({ from: "a", to: "b" });
		settle();

		const entry = history.stack[0];

		expect(history.stack).toHaveLength(1);
		expect(entry?.batches).toHaveLength(1);
		expect(entry?.batches[0]?.operations.map((operation) => operation.key)).toEqual(["0", "length"]);

		history.undo();
		settle();

		expect(definition.edges).toHaveLength(0);
		expect(definition.name).toBe("replayed");
	});

	it("an external batch clears the stack and recording resumes from the post-external document", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "local";
		settle();

		expect(history.canUndo).toBe(true);

		batch(
			() => {
				definition.name = "reconciled";
			},
			{ external: true },
		);

		settle();

		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(false);
		expect(history.stack).toHaveLength(0);

		definition.name = "after";
		settle();

		expect(history.stack).toHaveLength(1);

		history.undo();
		settle();

		expect(definition.name).toBe("reconciled");
	});

	it("undo below the bottom and redo past the top are noops", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "renamed";
		settle();

		expect(() => {
			history.redo();
		}).not.toThrow();

		settle();

		expect(definition.name).toBe("renamed");

		history.undo();
		settle();

		expect(() => {
			history.undo();
		}).not.toThrow();

		settle();

		expect(definition.name).toBe("g");
		expect(history.canUndo).toBe(false);
	});

	it("canUndo and canRedo are reactive across generations", () => {
		const { definition, history, settle } = createFixture();

		const heard = new Array<{ canUndo: boolean; canRedo: boolean }>();

		subscribe(history, () => {
			heard.push({ canUndo: history.canUndo, canRedo: history.canRedo });
		});

		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(false);

		definition.name = "renamed";
		settle();

		expect(history.canUndo).toBe(true);
		expect(history.canRedo).toBe(false);

		history.undo();
		settle();

		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(true);
		expect(heard).toEqual([
			{ canUndo: true, canRedo: false },
			{ canUndo: false, canRedo: true },
		]);
	});

	it("a state not handed to createHistory is inaudible", () => {
		const { history, settle } = createFixture();

		const standalone = createMutableState({ count: 0 });

		standalone.count = 1;
		flush(standalone);
		settle();

		expect(history.stack).toHaveLength(0);
		expect(history.canUndo).toBe(false);
	});

	it("an external clear at the bottom of the stack flips canRedo through the tracked stack length", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "renamed";
		settle();

		history.undo();
		settle();

		expect(history.canRedo).toBe(true);

		batch(
			() => {
				definition.name = "reconciled";
			},
			{ external: true },
		);

		settle();

		expect(history.canRedo).toBe(false);
	});

	it("replays a restored array that was written into after undo in both directions", () => {
		const { definition, history, settle } = createFixture();

		const nodeA = { id: "a", parameters: {} };
		const nodeB = { id: "b", parameters: {} };
		const nodeC = { id: "c", parameters: {} };

		definition.nodes = [nodeA];
		settle();

		definition.nodes = [nodeA, nodeB];
		settle();

		history.undo();
		settle();

		definition.nodes.push(nodeC);
		settle();

		history.undo();
		settle();

		history.undo();
		settle();

		expect(definition.nodes).toEqual([]);

		history.redo();
		settle();

		expect(definition.nodes).toEqual([{ id: "a", parameters: {} }]);

		history.redo();
		settle();

		expect(definition.nodes).toEqual([
			{ id: "a", parameters: {} },
			{ id: "c", parameters: {} },
		]);
	});
	it("records a pending write before undo runs", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "one";
		settle();

		definition.name = "two";
		history.undo();
		settle();

		expect(definition.name).toBe("one");
		expect(history.stack).toHaveLength(2);
		expect(history.canRedo).toBe(true);

		history.redo();
		settle();

		expect(definition.name).toBe("two");
	});

	it("records a pending write before redo runs", () => {
		const { definition, history, settle } = createFixture();

		definition.name = "one";
		settle();

		history.undo();
		settle();

		definition.name = "two";
		history.redo();
		settle();

		expect(definition.name).toBe("two");
		expect(history.canRedo).toBe(false);
	});
});
