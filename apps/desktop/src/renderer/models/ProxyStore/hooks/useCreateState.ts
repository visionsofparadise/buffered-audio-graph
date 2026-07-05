import { useMemo } from "react";
import { useSnapshot } from "valtio";
import type { Snapshot } from "valtio/vanilla";
import type { State } from "../../State";
import type { ProxyStore } from "../ProxyStore";

export function useCreateState<T extends State>(initial: Omit<T, "_key">, store: ProxyStore): Snapshot<T> {
	const proxy = useMemo(() => store.createState<T>(initial), [store]);

	return useSnapshot(proxy) as Snapshot<T>;
}
