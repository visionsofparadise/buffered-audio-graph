export type IpcHandlerAction<Ipc> = Ipc extends AsyncRendererIpc<infer A, infer _P, infer _R> ? A : never;
export type IpcHandlerParameters<Ipc> = Ipc extends AsyncRendererIpc<infer _A, infer P, infer _R> ? P : never;
export type IpcHandlerReturn<Ipc> = Ipc extends AsyncRendererIpc<infer _A, infer _P, infer R> ? R : never;

export abstract class AsyncRendererIpc<A extends string, P extends Array<unknown>, R> {
	abstract action: A;

	register(ipcRenderer: { invoke: (action: string, ...args: Array<unknown>) => Promise<unknown> }): [A, (...parameters: P) => Promise<R>] {
		return [this.action, (...parameters: P) => ipcRenderer.invoke(this.action, ...parameters) as Promise<R>];
	}
}
