/**
 * Colormap definition shape. Matches the `ColormapDefinition` exported by the
 * published `spectral-display` package (kept as a local type so design-system
 * carries no runtime/type dependency on spectral-display).
 */
export interface ColormapDefinition {
	colors: ReadonlyArray<{
		position: number;
		color: readonly [number, number, number];
	}>;
}

function fromPoints(points: ReadonlyArray<readonly [number, number, number]>): ColormapDefinition {
	return {
		colors: points.map((color, index) => ({
			position: index / (points.length - 1),
			color,
		})),
	};
}

export const lavaColormap: ColormapDefinition = fromPoints([
	[0, 0, 0],
	[5, 5, 30],
	[15, 20, 70],
	[30, 15, 50],
	[80, 10, 5],
	[140, 20, 0],
	[185, 55, 0],
	[215, 100, 5],
	[240, 155, 25],
	[252, 210, 70],
	[255, 240, 140],
	[255, 255, 255],
]);

export const viridisColormap: ColormapDefinition = fromPoints([
	[0, 0, 0],
	[68, 1, 84],
	[72, 35, 116],
	[64, 68, 135],
	[52, 96, 141],
	[33, 137, 136],
	[26, 158, 123],
	[42, 182, 91],
	[118, 191, 47],
	[168, 186, 35],
	[208, 200, 29],
	[240, 218, 28],
	[253, 231, 37],
]);
