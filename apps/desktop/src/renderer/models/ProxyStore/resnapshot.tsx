import { memo, useCallback, useMemo, useRef, type FC } from "react";
import { useSyncExternalStore } from "react";
import { snapshot as valtioSnapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import type { ProxyStore } from "./ProxyStore";

const isSnapshot = (value: unknown): value is { _key: symbol } => typeof value === "object" && value !== null && "_key" in value && typeof (value as { _key: unknown })._key === "symbol";

const shouldTraverse = (value: unknown): boolean => {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return true;

	const proto: unknown = Object.getPrototypeOf(value);

	return proto === Object.prototype || proto === null;
};

type PropPath = Array<string | number>;

const findSnapshotPaths = (value: unknown, path: PropPath = [], paths: Array<PropPath> = []): Array<PropPath> => {
	if (isSnapshot(value)) {
		paths.push(path);

		return paths;
	}

	if (!shouldTraverse(value)) return paths;

	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			findSnapshotPaths(item, [...path, index], paths);
		});
	} else {
		for (const [key, propertyValue] of Object.entries(value as object)) {
			if (key === "children") continue;

			findSnapshotPaths(propertyValue, [...path, key], paths);
		}
	}

	return paths;
};

function getAtPath(object: unknown, path: PropPath): unknown {
	let current = object;

	for (const segment of path) {
		if (current === null || current === undefined) return undefined;

		current = (current as Record<string | number, unknown>)[segment];
	}

	return current;
}

function setAtPath<T>(object: T, path: PropPath, value: unknown): T {
	if (path.length === 0) return value as T;

	const head = path[0];

	if (head === undefined) throw new Error("setAtPath: non-empty path yielded no head segment");

	const tail = path.slice(1);
	const current = (object as Record<string | number, unknown>)[head];
	const updated = setAtPath(current, tail, value);

	if (Array.isArray(object)) {
		const clone = [...object];

		clone[head as number] = updated;

		return clone as T;
	}

	return { ...object, [head]: updated } as T;
}

function resolveProxy(stores: ReadonlyArray<ProxyStore>, key: symbol): object {
	for (const store of stores) {
		const proxy = store.dangerouslyGetProxy(key);

		if (proxy) return proxy;
	}

	throw new Error(`resnapshot: no store holds a proxy for snapshot key ${String(key)}`);
}

function useResnapshotAll(stores: ReadonlyArray<ProxyStore>, snapshots: Array<{ _key: symbol }>): Array<object> {
	const proxies = useMemo(
		() => snapshots.map((snap) => resolveProxy(stores, snap._key)),
		[...stores, ...snapshots.map((snap) => snap._key)],
	);

	const lastSnapshots = useRef<Array<object>>([]);

	const getSnapshot = useCallback((): Array<object> => {
		const next = proxies.map((proxy) => valtioSnapshot(proxy));
		const last = lastSnapshots.current;

		if (last.length === next.length && last.every((snap, index) => snap === next[index])) {
			return last;
		}

		lastSnapshots.current = next;

		return next;
	}, [proxies]);

	const subscribe = useCallback(
		(callback: () => void) => {
			const unsubscribes = proxies.map((proxy) => valtioSubscribe(proxy, callback));

			return () => {
				for (const unsub of unsubscribes) unsub();
			};
		},
		[proxies],
	);

	return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Constraint for components that pass through `resnapshot`. Every context level
 * carries `appStore`; `graphStore` is present on extended levels (GraphContext).
 * The HOC tries each store when resolving a snapshot `_key`.
 */
interface StoreContext {
	readonly appStore: ProxyStore;
	readonly graphStore?: ProxyStore;
}

export const resnapshot = <P extends { context: StoreContext }>(component: FC<P>): FC<P> => {
	const componentName = component.name || "Anonymous";

	const Resnapshotted: FC<P> = (props) => {
		const { appStore, graphStore } = props.context;
		const stores = useMemo(
			() => (graphStore ? [graphStore, appStore] : [appStore]),
			[graphStore, appStore],
		);

		const snapshotPaths = useMemo(() => findSnapshotPaths(props), [props]);

		const staleSnapshots = useMemo(() => snapshotPaths.map((path) => getAtPath(props, path) as { _key: symbol }), [props, snapshotPaths]);

		const freshSnapshots = useResnapshotAll(stores, staleSnapshots);

		const freshProps = useMemo(() => {
			if (staleSnapshots.every((snapshot, index) => snapshot === freshSnapshots[index])) return props;

			return snapshotPaths.reduce<P>((acc, path, index) => setAtPath(acc, path, freshSnapshots[index]), props);
		}, [props, snapshotPaths, staleSnapshots, freshSnapshots]);

		return component(freshProps);
	};

	Resnapshotted.displayName = `resnapshot(${componentName})`;

	return memo(Resnapshotted);
};
