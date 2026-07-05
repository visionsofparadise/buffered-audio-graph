import { proxy as valtioProxy, type Snapshot } from "valtio/vanilla";
import type { Mutable, State } from "../State";

export class ProxyStore {
	private readonly _map = new Map<symbol, object>();

	createState<T extends State>(initial: Omit<T, "_key">): T {
		const key = Symbol();

		Object.defineProperty(initial, "_key", {
			value: key,
			enumerable: true,
			writable: false,
			configurable: false,
		});

		const proxied = valtioProxy(initial as T);

		this._map.set(key, proxied);

		return proxied;
	}

	dangerouslyGetProxy<T extends object>(key: symbol): T | undefined {
		return this._map.get(key) as T | undefined;
	}

	mutate<T extends { _key: symbol }>(snapshot: Snapshot<T>, callback: (proxy: Mutable<T>) => void): void {
		const proxy = this._map.get(snapshot._key);

		if (!proxy) {
			throw new Error("ProxyStore.mutate: proxy not found for key");
		}

		callback(proxy as Mutable<T>);
	}
}
