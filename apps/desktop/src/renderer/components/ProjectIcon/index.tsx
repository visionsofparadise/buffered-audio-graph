import type { ComponentType } from "react";
import { cn } from "../../utils/cn";
import type { IconProps } from "./IconProps";
import { hashString } from "./utils/hashString";
import { BarcodeIcon } from "./Icon/BarcodeIcon";
import { CheckerboardIcon } from "./Icon/CheckerboardIcon";
import { ConcentricIcon } from "./Icon/ConcentricIcon";
import { CornersIcon } from "./Icon/CornersIcon";
import { CrosshatchIcon } from "./Icon/CrosshatchIcon";
import { DiagonalIcon } from "./Icon/DiagonalIcon";
import { DotCircleIcon } from "./Icon/DotCircleIcon";
import { DotGridIcon } from "./Icon/DotGridIcon";
import { LinesIcon } from "./Icon/LinesIcon";
import { PrimaryIcon } from "./Icon/PrimaryIcon";
import { QuarterIcon } from "./Icon/QuarterIcon";
import { RingsIcon } from "./Icon/RingsIcon";
import { StairsIcon } from "./Icon/StairsIcon";

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
