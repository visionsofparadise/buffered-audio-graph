import { sortKeysRecursive } from "../../shared/utilities/sortKeysRecursive";

export { sortKeysRecursive };

export async function contentHash(
	upstreamHash: string,
	packageName: string,
	packageVersion: string,
	nodeName: string,
	parameters: Record<string, unknown>,
	bypass: boolean,
): Promise<string> {
	const input =
		upstreamHash +
		packageName +
		packageVersion +
		nodeName +
		JSON.stringify(sortKeysRecursive(parameters)) +
		String(bypass);

	const buffer = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);

	const hashArray = Array.from(new Uint8Array(buffer));
	const hashHex = hashArray
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");

	return hashHex.slice(0, 16);
}
