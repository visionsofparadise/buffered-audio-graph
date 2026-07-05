import type { ComponentPropsWithRef, ComponentType } from "react";
import { cn } from "../utils/cn";
import { Barcode } from "./Barcode";

/**
 * Project icons — copied from Resequence's design-system icon set. Thirteen
 * geometric marks; a project name hashes to a stable one. They are monochrome
 * here (filled via `currentColor`), so they inherit whatever text color their
 * context provides — the tab's text color, a recent-project label's color.
 */

export interface IconProps extends Omit<ComponentPropsWithRef<"div">, "color"> {
	readonly color: string;
	readonly size?: number;
}

function PrimaryIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div
			ref={ref}
			style={{ width: size, height: size, backgroundColor: color, ...style }}
			className={className}
			{...rest}
		/>
	);
}

const BARCODE_ICON_WIDTHS = [2, 1, 3, 1, 2, 1, 1, 3, 1, 2, 1, 3, 1, 1, 2];

function BarcodeIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<Barcode
			widths={BARCODE_ICON_WIDTHS}
			height={size}
			gap={1}
			color={color}
			className={className}
			ref={ref}
			style={style}
			{...rest}
		/>
	);
}

function ConcentricIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<rect x="0.5" y="0.5" width="31" height="31" stroke={color} fill="none" strokeWidth="1" />
				<rect x="6.5" y="6.5" width="19" height="19" stroke={color} fill="none" strokeWidth="1" />
				<rect x="12.5" y="12.5" width="7" height="7" stroke={color} fill="none" strokeWidth="1" />
			</svg>
		</div>
	);
}

function DotCircleIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<circle cx="16" cy="16" r="14.5" stroke={color} fill="none" strokeWidth="1" />
				<circle cx="16" cy="16" r="3" fill={color} />
			</svg>
		</div>
	);
}

function DotGridIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div
			ref={ref}
			className={cn("grid", className)}
			style={{
				width: size,
				height: size,
				gridTemplateColumns: "repeat(5, 1fr)",
				gridTemplateRows: "repeat(5, 1fr)",
				placeItems: "center",
				...style,
			}}
			{...rest}
		>
			{Array.from({ length: 25 }, (_, ix) => (
				<div
					key={`dot-${ix}`}
					style={{
						width: 3,
						height: 3,
						borderRadius: "50%",
						backgroundColor: color,
						opacity: ix % 5 === 0 || ix < 5 || ix >= 20 || ix % 5 === 4 ? 1 : 0.4,
					}}
				/>
			))}
		</div>
	);
}

function LinesIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div
			ref={ref}
			className={cn("flex flex-col justify-between", className)}
			style={{ width: size, height: size, ...style }}
			{...rest}
		>
			{Array.from({ length: 8 }, (_, ix) => (
				<div
					key={`line-${ix}`}
					style={{
						width: `${60 + ((ix * 37) % 41)}%`,
						height: 1,
						backgroundColor: color,
						opacity: ix % 2 === 0 ? 1 : 0.4,
					}}
				/>
			))}
		</div>
	);
}

function DiagonalIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				{Array.from({ length: 8 }, (_, ix) => (
					<line
						key={`a${ix}`}
						x1={ix * 5}
						y1={0}
						x2={0}
						y2={ix * 5}
						stroke={color}
						strokeWidth="1"
						opacity={ix % 2 === 0 ? 1 : 0.4}
					/>
				))}
				{Array.from({ length: 8 }, (_, ix) => (
					<line
						key={`b${ix}`}
						x1={32}
						y1={ix * 5 + 2}
						x2={ix * 5 + 2}
						y2={32}
						stroke={color}
						strokeWidth="1"
						opacity={ix % 2 === 0 ? 1 : 0.4}
					/>
				))}
			</svg>
		</div>
	);
}

function CrosshatchIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				{Array.from({ length: 6 }, (_, ix) => (
					<line key={`h${ix}`} x1={0} y1={ix * 7} x2={32} y2={ix * 7} stroke={color} strokeWidth="1" opacity={0.6} />
				))}
				{Array.from({ length: 6 }, (_, ix) => (
					<line key={`v${ix}`} x1={ix * 7} y1={0} x2={ix * 7} y2={32} stroke={color} strokeWidth="1" opacity={0.6} />
				))}
			</svg>
		</div>
	);
}

function CheckerboardIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	const cellSize = size / 4;

	return (
		<div
			ref={ref}
			className={cn("grid", className)}
			style={{
				width: size,
				height: size,
				gridTemplateColumns: `repeat(4, ${cellSize}px)`,
				gridTemplateRows: `repeat(4, ${cellSize}px)`,
				...style,
			}}
			{...rest}
		>
			{Array.from({ length: 16 }, (_, ix) => (
				<div
					key={`cell-${ix}`}
					style={{
						backgroundColor: (Math.floor(ix / 4) + (ix % 4)) % 2 === 0 ? color : "transparent",
					}}
				/>
			))}
		</div>
	);
}

function CornersIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<rect x="0" y="0" width="8" height="8" fill={color} />
				<rect x="24" y="0" width="8" height="8" fill={color} />
				<rect x="0" y="24" width="8" height="8" fill={color} />
				<rect x="24" y="24" width="8" height="8" fill={color} />
				<rect x="12" y="12" width="8" height="8" fill={color} opacity="0.4" />
			</svg>
		</div>
	);
}

function RingsIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<circle cx="16" cy="16" r="14.5" stroke={color} fill="none" strokeWidth="1" />
				<circle cx="16" cy="16" r="10" stroke={color} fill="none" strokeWidth="1" opacity="0.6" />
				<circle cx="16" cy="16" r="5.5" stroke={color} fill="none" strokeWidth="1" opacity="0.4" />
			</svg>
		</div>
	);
}

function QuarterIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<rect x="0.5" y="0.5" width="31" height="31" stroke={color} fill="none" strokeWidth="1" />
				<rect x="0" y="16" width="16" height="16" fill={color} />
			</svg>
		</div>
	);
}

function StairsIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<rect x="0" y="0" width="8" height="32" fill={color} opacity="0.25" />
				<rect x="8" y="8" width="8" height="24" fill={color} opacity="0.45" />
				<rect x="16" y="16" width="8" height="16" fill={color} opacity="0.65" />
				<rect x="24" y="24" width="8" height="8" fill={color} />
			</svg>
		</div>
	);
}

const PROJECT_ICONS: ReadonlyArray<ComponentType<IconProps>> = [
	PrimaryIcon,
	BarcodeIcon,
	ConcentricIcon,
	DotCircleIcon,
	DotGridIcon,
	LinesIcon,
	DiagonalIcon,
	CrosshatchIcon,
	CheckerboardIcon,
	CornersIcon,
	RingsIcon,
	QuarterIcon,
	StairsIcon,
];

/** djb2 string hash — Resequence's project-icon assignment hash. */
function hashString(input: string): number {
	let hash = 5381;

	for (let index = 0; index < input.length; index++) {
		hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
	}

	return Math.abs(hash);
}

interface ProjectIconProps {
	/** Project name — the seed for which geometric mark is shown. */
	readonly name: string;
	readonly size?: number;
	readonly className?: string;
}

/**
 * ProjectIcon — renders the geometric mark deterministically assigned to a
 * project name. Monochrome: `color` is `currentColor`, so the mark inherits
 * the surrounding text color.
 */
export function ProjectIcon({ name, size = 16, className }: ProjectIconProps) {
	const Icon = PROJECT_ICONS[hashString(name) % PROJECT_ICONS.length] ?? PrimaryIcon;

	return <Icon color="currentColor" size={size} className={cn("shrink-0", className)} />;
}
