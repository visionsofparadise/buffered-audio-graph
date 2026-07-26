export function snapToStep(value: number, step: number): number {
	if (step <= 0) return value;

	return Math.round(value / step) * step;
}

export function formatParamValue(value: number, step: number): string {
	const decimals = (step.toString().split(".")[1] ?? "").length;

	return value.toFixed(decimals);
}
