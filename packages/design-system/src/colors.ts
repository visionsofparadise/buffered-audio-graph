/**
 * JS color constants mirroring the CSS tokens in `css/tokens.css`. Used by
 * canvas / Three.js / other non-DOM contexts that can't read CSS custom
 * properties. Keep in sync with the `@theme` block.
 */

export const surface = "#100F0D";
export const elevated = "#1D1A16";
export const border = "#3E3833";
export const dimmed = "#685F54";
export const textSecondary = "#918979";
export const textPrimary = "#F5F0E6";

export const accentPrimary = "#E05A47";
export const accentSecondary = "#47A5A5";

export const categorySource = "#45A8A0";
export const categoryTransform = "#7B85C4";
export const categoryTarget = "#C98A6C";

export const meterGreen = "#4A7A5A";
export const meterYellow = "#A59A4A";

export const light = {
	surface: "#F5F0E8",
	elevated: "#EDE8E0",
	border: "#D5D0C8",
	dimmed: "#B0A898",
	textSecondary: "#8A8070",
	textPrimary: "#2A2520",
} as const;
