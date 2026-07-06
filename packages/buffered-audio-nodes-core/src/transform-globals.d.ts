// Node ≥ 20 Web Streams fire transformer cancel(reason); the bundled DOM lib omits it.
// Declaration-merge requires the type params to match DOM's Transformer<I = any, O = any> exactly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
interface Transformer<I = any, O = any> {
	cancel?: (reason?: unknown) => void | PromiseLike<void>;
}
