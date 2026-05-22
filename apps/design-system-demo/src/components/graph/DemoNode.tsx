import { useState, useRef, useEffect, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Plus, Power, RotateCcw, X } from "lucide-react";
import {
	Knob,
	Fader,
	Toggle,
	ButtonSelection,
	Select,
	Input,
	FileInput,
	Button,
	IconButton,
	cn,
} from "@buffered-audio/design-system";
import type {
	DemoNodeData,
	Param,
	NumberParam,
	ToggleParam,
	SelectParam,
	InputParam,
	FileParam,
	ObjectArrayParam,
	PortDef,
} from "./types";

const CATEGORY_HEADER_BG: Record<DemoNodeData["category"], string> = {
	source: "bg-category-source",
	transform: "bg-category-transform",
	target: "bg-category-target",
};

function snapToStep(value: number, step: number): number {
	if (step <= 0) return value;

	return Math.round(value / step) * step;
}

/** Format a number param for its on-node readout — step decides precision. */
function formatParamValue(value: number, step: number): string {
	const decimals = (step.toString().split(".")[1] ?? "").length;

	return value.toFixed(decimals);
}

function NumberControl({
	name,
	param,
	onChange,
}: {
	readonly name: string;
	readonly param: NumberParam;
	readonly onChange?: (name: string, value: number) => void;
}) {
	const range = param.max - param.min;
	const normalize = (raw: number) => (range === 0 ? 0 : (raw - param.min) / range);
	const denormalize = (norm: number) => param.min + norm * range;

	const [localValue, setLocalValue] = useState(param.value);
	const draggingRef = useRef(false);

	useEffect(() => {
		if (!draggingRef.current) setLocalValue(param.value);
	}, [param.value]);

	const handleChange = onChange
		? (norm: number) => {
				draggingRef.current = true;
				setLocalValue(snapToStep(denormalize(norm), param.step));
			}
		: undefined;
	const handleEnd = onChange
		? (norm: number) => {
				draggingRef.current = false;
				const committed = snapToStep(denormalize(norm), param.step);

				setLocalValue(committed);
				onChange(name, committed);
			}
		: undefined;

	const normalized = normalize(localValue);

	if (param.type === "fader") {
		// Fader has no onChangeEnd hook — commit on every change for now.
		const faderOnChange = onChange
			? (norm: number) => {
					const committed = snapToStep(denormalize(norm), param.step);

					setLocalValue(committed);
					onChange(name, committed);
				}
			: undefined;

		return <Fader value={normalized} onChange={faderOnChange} />;
	}

	return (
		<div className="flex flex-col items-center gap-1">
			{/* Value readout above the dial. Fixed width + centered so the digits
			    don't jitter the layout as the value changes mid-drag. */}
			<span className="type-value w-12 text-center text-label text-text-secondary">
				{formatParamValue(localValue, param.step)}
			</span>
			<Knob
				value={normalized}
				size={32}
				hideValue
				onChange={handleChange}
				onChangeEnd={handleEnd}
			/>
			{/* Unit as the label below the dial. */}
			{param.unit !== undefined && (
				<span className="type-label text-text-secondary">{param.unit}</span>
			)}
		</div>
	);
}

function ToggleControl({
	name,
	param,
	onChange,
}: {
	readonly name: string;
	readonly param: ToggleParam;
	readonly onChange?: (name: string, value: boolean) => void;
}) {
	return (
		<Toggle
			value={param.value}
			label={param.value ? "ON" : "OFF"}
			onChange={onChange ? (next) => onChange(name, next) : undefined}
		/>
	);
}

function SelectControl({
	name,
	param,
	onChange,
}: {
	readonly name: string;
	readonly param: SelectParam;
	readonly onChange?: (name: string, value: string) => void;
}) {
	if (param.type === "buttonSelection") {
		return (
			<ButtonSelection
				active={param.value}
				options={param.options}
				onSelect={onChange ? (option) => onChange(name, option) : undefined}
			/>
		);
	}

	return (
		<Select
			value={param.value}
			options={param.options}
			onChange={onChange ? (next) => onChange(name, next) : undefined}
		/>
	);
}

function InputControl({
	name,
	param,
	onChange,
}: {
	readonly name: string;
	readonly param: InputParam;
	readonly onChange?: (name: string, value: string) => void;
}) {
	return (
		<Input
			type="text"
			defaultValue={param.value}
			onChange={onChange ? (next) => onChange(name, next) : undefined}
		/>
	);
}

function FileControl({
	name,
	param,
	onChange,
}: {
	readonly name: string;
	readonly param: FileParam;
	readonly onChange?: (name: string, value: string) => void;
}) {
	return (
		<FileInput
			defaultValue={param.value}
			// Surface the schema's file-extension filter as an empty-field hint.
			placeholder={param.accept === undefined ? undefined : `${param.accept} file`}
			onChange={onChange ? (next) => onChange(name, next) : undefined}
		/>
	);
}

// Stable id source for the editable list controls — keying rows by id (not
// array index) keeps React reconciliation correct as rows are added / removed.
let listRowCounter = 0;

function freshListRowId(): string {
	listRowCounter += 1;

	return `list-row-${listRowCounter}`;
}

/**
 * Small "add a row" affordance for the object-array editor. A thin wrapper over
 * the `Button` `ghost` variant with a leading `Plus` icon — left-aligned to its
 * row via `self-start`.
 */
function AddRowButton({
	label,
	onClick,
}: {
	readonly label: string;
	readonly onClick: () => void;
}) {
	return (
		<Button
			variant="ghost"
			size="sm"
			icon={Plus}
			onClick={onClick}
			className="self-start px-1"
		>
			{label}
		</Button>
	);
}

/**
 * ObjectArrayControl — editor for an `objectArray` param (an array of
 * sub-forms, e.g. the VST3 node's `stages`). Each element renders its own
 * params as a stack of `ParamRow`s; elements are separated by a divider and
 * the array is edited by adding / removing them.
 */
function ObjectArrayControl({ param }: { readonly param: ObjectArrayParam }) {
	const [items, setItems] = useState(() =>
		param.value.map((fields) => ({ id: freshListRowId(), fields })),
	);

	return (
		<div className="flex flex-col gap-3">
			{items.map((item, index) => (
				<div
					key={item.id}
					className={cn(
						"flex flex-col gap-3",
						// Single-edge divider between elements — no wrapping border.
						index > 0 && "border-t border-border pt-3",
					)}
				>
					<div className="flex items-center justify-between">
						<span className="type-label text-text-secondary">
							{`${param.itemNoun} ${index + 1}`}
						</span>
						<IconButton
							icon={X}
							label={`Remove ${param.itemNoun} ${index + 1}`}
							variant="ghost"
							size="sm"
							onClick={() => {
								setItems(items.filter((entry) => entry.id !== item.id));
							}}
						/>
					</div>
					{Object.entries(item.fields).map(([fieldName, fieldParam]) => (
						<ParamRow key={fieldName} name={fieldName} param={fieldParam} />
					))}
				</div>
			))}
			<AddRowButton
				label={`Add ${param.itemNoun}`}
				onClick={() => {
					setItems([
						...items,
						{ id: freshListRowId(), fields: param.itemTemplate },
					]);
				}}
			/>
		</div>
	);
}

/** Render a camelCase schema field name as spaced words (`type-label` uppercases). */
function humanizeFieldName(name: string): string {
	return name.replace(/([A-Z])/g, " $1").trim();
}

function ParamRow({
	name,
	param,
	onChange,
}: {
	readonly name: string;
	readonly param: Param;
	readonly onChange?: (name: string, value: Param["value"]) => void;
}) {
	// `text-xs` (12px) matches the node's other functional labels — param names
	// read at the same scale as the rest of the node's functional text, not
	// smaller.
	const labelClass = cn(
		"type-label text-xs",
		param.complete ? "text-text-secondary" : "text-accent-primary",
	);

	let control: React.ReactNode;

	switch (param.type) {
		case "knob":
		case "fader":
			control = (
				<NumberControl
					name={name}
					param={param}
					onChange={onChange as ((name: string, value: number) => void) | undefined}
				/>
			);
			break;
		case "toggle":
			control = (
				<ToggleControl
					name={name}
					param={param}
					onChange={onChange as ((name: string, value: boolean) => void) | undefined}
				/>
			);
			break;
		case "buttonSelection":
		case "select":
			control = (
				<SelectControl
					name={name}
					param={param}
					onChange={onChange as ((name: string, value: string) => void) | undefined}
				/>
			);
			break;
		case "input":
			control = (
				<InputControl
					name={name}
					param={param}
					onChange={onChange as ((name: string, value: string) => void) | undefined}
				/>
			);
			break;
		case "file":
			control = (
				<FileControl
					name={name}
					param={param}
					onChange={onChange as ((name: string, value: string) => void) | undefined}
				/>
			);
			break;
		case "objectArray":
			control = <ObjectArrayControl param={param} />;
			break;
	}

	// Knobs and Toggles render compact and align well in a single horizontal row.
	// Faders, Selects, ButtonSelections, Inputs, file fields, and object-array
	// editors need a stacked layout so the control can take the full row width.
	const stacked =
		param.type === "fader" ||
		param.type === "select" ||
		param.type === "buttonSelection" ||
		param.type === "input" ||
		param.type === "file" ||
		param.type === "objectArray";

	if (stacked) {
		return (
			<div className="flex flex-col">
				<span className={cn(labelClass, "mb-1")}>{humanizeFieldName(name)}</span>
				{control}
			</div>
		);
	}

	return (
		<div className="flex items-center justify-between gap-3">
			<span className={labelClass}>{humanizeFieldName(name)}</span>
			<div className="shrink-0">{control}</div>
		</div>
	);
}

function PortHandle({
	port,
	side,
	required,
	connected,
}: {
	readonly port: PortDef;
	readonly side: "left" | "right";
	readonly required: boolean;
	readonly connected: boolean;
}) {
	const bgClass = connected
		? "!bg-text-primary"
		: required
			? "!bg-accent-primary"
			: "!bg-text-secondary";

	return (
		<Handle
			type={side === "left" ? "target" : "source"}
			position={side === "left" ? Position.Left : Position.Right}
			id={port.id}
			className={cn(
				"!h-2.5 !w-2.5 !rounded-none !border-0",
				bgClass,
			)}
			style={{
				[side]: -5,
				// Rightward-facing filled triangle — points along the L→R signal flow,
				// so an input reads as feeding in and an output as feeding out.
				clipPath: "polygon(0 0, 100% 50%, 0 100%)",
			}}
		/>
	);
}

/**
 * The component reads its node data — including the `onParamChange` / `onBypass`
 * / `onReset` handlers — off the React Flow `data` payload (see `DemoNodeData`),
 * not off dedicated component props. `NodeProps` is the only declared shape.
 */
type DemoNodeProps = NodeProps;

export function DemoNode({ data, selected }: DemoNodeProps) {
	const nodeData = data as unknown as DemoNodeData;
	const isBypassed = nodeData.bypassed === true;

	const connectedInputs = new Set(nodeData.connectedInputs ?? []);
	const connectedOutputs = new Set(nodeData.connectedOutputs ?? []);

	const onParamChange = (nodeData.onParamChange as ((name: string, value: Param["value"]) => void) | undefined);
	const onBypass = nodeData.onBypass as (() => void) | undefined;
	const onReset = nodeData.onReset as (() => void) | undefined;

	const panelClass = cn(
		// The panel itself owns layout, background, and the ≤2px outer radius. The
		// header bar inside clips to the same radius via `overflow-hidden`. A
		// subtle `border-border` frames the unit against the canvas (Resequence
		// graph-unit treatment).
		"flex flex-col bg-elevated rounded-xs border border-border overflow-hidden",
		isBypassed && "opacity-60",
		selected && "ring-1 ring-text-primary",
	);

	const paramEntries = Object.entries(nodeData.parameters);

	const handleBypass = useCallback(() => {
		onBypass?.();
	}, [onBypass]);
	const handleReset = useCallback(() => {
		onReset?.();
	}, [onReset]);

	return (
		<div className="relative" style={{ width: nodeData.width ?? 240 }}>
			<div className={panelClass}>
				{/* Header — full-panel-width colored bar carrying category + title.
				    Uses `min-h` + vertical padding (not a fixed `h-`) so multi-line
				    titles like `DeepFilterNet3 (Denoiser)` expand the bar to fit. */}
				<div
					className={cn(
						"flex min-h-9 items-center justify-between gap-2 px-4 py-2",
						CATEGORY_HEADER_BG[nodeData.category],
					)}
				>
					<span className="text-body font-medium uppercase tracking-[0.06em] leading-tight text-surface">
						{nodeData.name}
					</span>
					{/* Bypass / reset — small icon controls at the right of the header.
					    They sit on the colored category bar, so they keep `text-surface`
					    to stay legible; tailwind-merge lets the className override the
					    ghost variant's text color. */}
					<div className="flex shrink-0 items-center gap-1.5">
						<IconButton
							icon={Power}
							label="Bypass"
							variant="ghost"
							size="sm"
							onClick={handleBypass}
							className={cn(
								"text-surface hover:text-surface hover:bg-surface/20",
								!isBypassed && "bg-surface/25",
							)}
						/>
						<IconButton
							icon={RotateCcw}
							label="Reset"
							variant="ghost"
							size="sm"
							onClick={handleReset}
							className="text-surface hover:text-surface hover:bg-surface/20"
						/>
					</div>
				</div>

				{/* Body */}
				{paramEntries.length > 0 && (
					<div className="flex flex-col gap-4 px-4 py-4">
						{paramEntries.map(([name, param]) => (
							<ParamRow
								key={name}
								name={name}
								param={param}
								onChange={onParamChange}
							/>
						))}
					</div>
				)}

			</div>

			{/* Ports — rightward-facing triangle handles, vertically centered via React Flow defaults */}
			{nodeData.ports.inputs.map((port) => (
				<PortHandle
					key={port.id}
					port={port}
					side="left"
					required={port.required === true && !connectedInputs.has(port.id)}
					connected={connectedInputs.has(port.id)}
				/>
			))}
			{nodeData.ports.outputs.map((port) => (
				<PortHandle
					key={port.id}
					port={port}
					side="right"
					required={false}
					connected={connectedOutputs.has(port.id)}
				/>
			))}
		</div>
	);
}
