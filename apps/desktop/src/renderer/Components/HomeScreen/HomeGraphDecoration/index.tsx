import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../../utils/cn";
import { buildLayout, LABEL_HEIGHT, LABEL_WIDTH, VIEW_H, VIEW_W } from "./utils/layout";

export interface HomeGraphAnchor {
	readonly id: string;
	readonly label: string;
	readonly secondaryLabel?: string;
	readonly icon?: ReactNode;
}

export interface HomeGraphDecorationProps {
	readonly anchors: ReadonlyArray<HomeGraphAnchor>;
	readonly onAnchorClick?: (id: string) => void;
}

export function HomeGraphDecoration({ anchors, onAnchorClick }: HomeGraphDecorationProps) {
	const layout = useMemo(() => buildLayout(anchors.length, Math.floor(Math.random() * 0x7fffffff)), [anchors.length]);
	const [hoveredAnchorId, setHoveredAnchorId] = useState<string | null>(null);

	const circleRefs = useRef<Array<SVGCircleElement | null>>([]);
	const edgeRefs = useRef<Array<SVGLineElement | null>>([]);

	useEffect(() => {
		let rafId = 0;
		const start = performance.now();

		const tick = (now: number) => {
			const time = (now - start) / 1000;
			const positions: Array<{ x: number; y: number }> = [];

			layout.points.forEach((point) => {
				if (point.isAnchor) {
					positions.push({ x: point.baseX, y: point.baseY });
				} else {
					const dx = Math.sin(time * point.speed + point.phaseX) * point.amp;
					const dy = Math.cos(time * point.speed * 1.1 + point.phaseY) * point.amp;

					positions.push({ x: point.baseX + dx, y: point.baseY + dy });
				}
			});

			positions.forEach((pos, pointIndex) => {
				const circle = circleRefs.current[pointIndex];

				if (circle) {
					circle.setAttribute("cx", pos.x.toFixed(2));
					circle.setAttribute("cy", pos.y.toFixed(2));
				}
			});

			layout.edges.forEach((edge, edgeIndex) => {
				const line = edgeRefs.current[edgeIndex];

				if (!line) return;

				const posA = positions[edge.endpointA];
				const posB = positions[edge.endpointB];

				if (!posA || !posB) return;

				line.setAttribute("x1", posA.x.toFixed(2));
				line.setAttribute("y1", posA.y.toFixed(2));
				line.setAttribute("x2", posB.x.toFixed(2));
				line.setAttribute("y2", posB.y.toFixed(2));
			});

			rafId = requestAnimationFrame(tick);
		};

		rafId = requestAnimationFrame(tick);

		return () => {
			cancelAnimationFrame(rafId);
		};
	}, [layout]);

	return (
		<svg
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			preserveAspectRatio="xMidYMid meet"
			className="absolute inset-0 h-full w-full"
		>
			{layout.edges.map((edge, edgeIndex) => {
				const pointA = layout.points[edge.endpointA];
				const pointB = layout.points[edge.endpointB];

				if (!pointA || !pointB) return null;

				return (
					<line
						key={`edge-${edgeIndex}`}
						ref={(node) => {
							edgeRefs.current[edgeIndex] = node;
						}}
						x1={pointA.baseX}
						y1={pointA.baseY}
						x2={pointB.baseX}
						y2={pointB.baseY}
						stroke="var(--color-border)"
						strokeWidth={1}
					/>
				);
			})}

			{layout.annotations.map((ann) => {
				const point = layout.points[ann.pointIndex];
				const anchor = anchors[ann.anchorIndex];

				if (!point || !anchor) return null;

				const isHovered = hoveredAnchorId === anchor.id;

				return (
					<line
						key={`tether-${anchor.id}`}
						x1={point.baseX}
						y1={point.baseY}
						x2={point.baseX + ann.labelOffsetX}
						y2={point.baseY + ann.labelOffsetY}
						stroke={isHovered ? "var(--color-text-primary)" : "var(--color-border)"}
						strokeWidth={1}
					/>
				);
			})}

			{layout.points.map((point, pointIndex) => (
				<circle
					key={`point-${pointIndex}`}
					ref={(node) => {
						circleRefs.current[pointIndex] = node;
					}}
					cx={point.baseX}
					cy={point.baseY}
					r={point.isAnchor ? 4.5 : 2.4}
					fill="var(--color-text-secondary)"
				/>
			))}

			{layout.annotations.map((ann) => {
				const point = layout.points[ann.pointIndex];
				const anchor = anchors[ann.anchorIndex];

				if (!point || !anchor) return null;

				if (hoveredAnchorId !== anchor.id) return null;

				return (
					<circle
						key={`ring-${anchor.id}`}
						cx={point.baseX}
						cy={point.baseY}
						r={10}
						fill="none"
						stroke="var(--color-text-primary)"
						strokeWidth={1}
					/>
				);
			})}

			{layout.annotations.map((ann) => {
				const point = layout.points[ann.pointIndex];
				const anchor = anchors[ann.anchorIndex];

				if (!point || !anchor) return null;

				const isHovered = hoveredAnchorId === anchor.id;
				const labelX = point.baseX + ann.labelOffsetX;
				const labelY = point.baseY + ann.labelOffsetY;
				const isEndAligned = ann.align === "end";

				const handleEnter = () => setHoveredAnchorId(anchor.id);
				const handleLeave = () => setHoveredAnchorId(null);
				const handleClick = () => onAnchorClick?.(anchor.id);
				const handleKeyDown = (event: React.KeyboardEvent) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						handleClick();
					}
				};

				return (
					<g key={`label-${anchor.id}`}>
						<circle
							cx={point.baseX}
							cy={point.baseY}
							r={18}
							fill="transparent"
							style={{ cursor: "pointer" }}
							onMouseEnter={handleEnter}
							onMouseLeave={handleLeave}
							onClick={handleClick}
						/>

						<foreignObject
							x={isEndAligned ? labelX - LABEL_WIDTH : labelX}
							y={labelY - LABEL_HEIGHT / 2}
							width={LABEL_WIDTH}
							height={LABEL_HEIGHT}
							style={{ overflow: "visible" }}
						>
							<div
								role="button"
								tabIndex={0}
								className={cn(
									"flex h-full items-center justify-start gap-3",
									isEndAligned ? "flex-row-reverse" : "flex-row",
								)}
								style={{ cursor: "pointer" }}
								onMouseEnter={handleEnter}
								onMouseLeave={handleLeave}
								onClick={handleClick}
								onKeyDown={handleKeyDown}
							>
								{anchor.icon !== undefined && (
									<span className={isHovered ? "text-text-primary" : "text-text-secondary"}>
										{anchor.icon}
									</span>
								)}
								<div className={cn("flex flex-col gap-0.5", isEndAligned ? "items-end" : "items-start")}>
									<span
										className={cn(
											"text-[14px] whitespace-nowrap leading-tight",
											isHovered ? "text-text-primary" : "text-text-secondary",
										)}
									>
										{anchor.label}
									</span>
									{anchor.secondaryLabel !== undefined && (
										<span className="type-label whitespace-nowrap text-dimmed">{anchor.secondaryLabel}</span>
									)}
								</div>
							</div>
						</foreignObject>
					</g>
				);
			})}
		</svg>
	);
}
