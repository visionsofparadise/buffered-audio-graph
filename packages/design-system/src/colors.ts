import type { ColormapDefinition } from "./colormaps";
import { lavaColormap, viridisColormap } from "./colormaps";

export type ColormapTheme = "lava" | "viridis";

/** Control points for each colormap (RGB tuples). Used to generate CSS gradients and colormap visualizations. */
export const COLORMAP_POINTS = {
	lava: [
		[0, 0, 0], [5, 5, 30], [15, 20, 70], [30, 15, 50],
		[80, 10, 5], [140, 20, 0], [185, 55, 0], [215, 100, 5],
		[240, 155, 25], [252, 210, 70], [255, 240, 140], [255, 255, 255],
	],
	viridis: [
		[0, 0, 0], [68, 1, 84], [72, 35, 116], [64, 68, 135],
		[52, 96, 141], [33, 137, 136], [26, 158, 123], [42, 182, 91],
		[118, 191, 47], [168, 186, 35], [208, 200, 29], [240, 218, 28],
		[253, 231, 37],
	],
} as const satisfies Record<ColormapTheme, ReadonlyArray<ReadonlyArray<number>>>;

/** Generate a CSS linear-gradient string from colormap control points. */
export function colormapGradient(points: ReadonlyArray<ReadonlyArray<number>>, direction = "to right"): string {
	const stops = points.map((rgb, index) => {
		const pct = (index / (points.length - 1)) * 100;

		return `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${pct.toFixed(1)}%`;
	});

	return `linear-gradient(${direction}, ${stops.join(", ")})`;
}

/** Per-colormap theme values used by spectral display components. */
export interface ColormapThemeColors {
	readonly colormap: ColormapDefinition;
	readonly waveform: [number, number, number];
	readonly waveformCss: string;
	readonly loudness: {
		readonly rms: string;
		readonly momentary: string;
		readonly shortTerm: string;
		readonly integrated: string;
		readonly truePeak: string;
	};
	readonly checks: {
		readonly truePeak: string;
		readonly lufs: string;
		readonly rms: string;
	};
	readonly meterGradient: string;
}

export const THEME_COLORS: Record<ColormapTheme, ColormapThemeColors> = {
	lava: {
		colormap: lavaColormap,
		waveform: [94, 196, 182],
		waveformCss: "rgb(94, 196, 182)",
		loudness: {
			rms: "rgb(26, 122, 108)",
			momentary: "rgb(52, 211, 153)",
			shortTerm: "rgb(52, 211, 153)",
			integrated: "rgb(52, 211, 153)",
			truePeak: "rgb(251, 113, 133)",
		},
		checks: { truePeak: "#FB7185", lufs: "#34D399", rms: "#1A7A6C" },
		meterGradient: colormapGradient(COLORMAP_POINTS.lava, "to top"),
	},
	viridis: {
		colormap: viridisColormap,
		waveform: [233, 30, 144],
		waveformCss: "rgb(233, 30, 144)",
		loudness: {
			rms: "rgb(139, 26, 92)",
			momentary: "rgb(56, 189, 248)",
			shortTerm: "rgb(56, 189, 248)",
			integrated: "rgb(56, 189, 248)",
			truePeak: "rgb(255, 23, 68)",
		},
		checks: { truePeak: "#FF1744", lufs: "#38BDF8", rms: "#8B1A5C" },
		meterGradient: colormapGradient(COLORMAP_POINTS.viridis, "to top"),
	},
};

/** Resolve theme colors for a given colormap. */
export function getThemeColors(theme: ColormapTheme): ColormapThemeColors {
	return THEME_COLORS[theme];
}
