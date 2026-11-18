export function dbToLinear(db: number): number {
	if (db === -Infinity) return 0;

	return Math.pow(10, db / 20);
}
