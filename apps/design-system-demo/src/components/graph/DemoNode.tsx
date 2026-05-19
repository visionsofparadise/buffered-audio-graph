import { useState, useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Icon } from "@iconify/react";
import { Knob, Toggle, ButtonSelection, Select, Button, IconButton, DropdownButton } from "@buffered-audio/design-system";
import type { MenuItem } from "@buffered-audio/design-system";
import type { AudioNodeData, NumberParameter } from "./types";

function snapToStep(value: number, step: number): number {
  if (step <= 0) return value;

  return Math.round(value / step) * step;
}

function EditableKnob({
  param,
  dimmed,
  onParameterChange,
}: {
  readonly param: NumberParameter;
  readonly dimmed?: boolean;
  readonly onParameterChange?: (name: string, value: unknown) => void;
}) {
  const range = param.max - param.min;
  const normalize = (raw: number) => (raw - param.min) / range;
  const denormalize = (normalized: number) => param.min + normalized * range;

  const [localValue, setLocalValue] = useState(param.value);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) setLocalValue(param.value);
  }, [param.value]);

  const normalized = normalize(localValue);
  const displayValue = draggingRef.current ? localValue : param.value;

  return (
    <div className={`flex items-center justify-between gap-3 ${dimmed ? "opacity-40" : ""}`}>
      <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] text-chrome-text-secondary">
        {param.name}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-technical text-[length:var(--text-xs)] tabular-nums text-chrome-text">
          {displayValue}{param.unit ? ` ${param.unit}` : ""}
        </span>
        <Knob
          value={normalized}
          label=""
          size={32}
          hideValue
          onChange={onParameterChange ? (norm: number) => {
            draggingRef.current = true;
            setLocalValue(snapToStep(denormalize(norm), param.step));
          } : undefined}
          onChangeEnd={onParameterChange ? (norm: number) => {
            draggingRef.current = false;
            const committed = snapToStep(denormalize(norm), param.step);

            setLocalValue(committed);
            onParameterChange(param.name, committed);
          } : undefined}
        />
      </div>
    </div>
  );
}

function ReadOnlyKnob({ param, dimmed }: { readonly param: NumberParameter; readonly dimmed?: boolean }) {
  const normalized = (param.value - param.min) / (param.max - param.min);

  return (
    <div className={`flex items-center justify-between gap-3 ${dimmed ? "opacity-40" : ""}`}>
      <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] text-chrome-text-secondary">
        {param.name}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-technical text-[length:var(--text-xs)] tabular-nums text-chrome-text">
          {param.value}{param.unit ? ` ${param.unit}` : ""}
        </span>
        <Knob value={normalized} label="" size={32} hideValue />
      </div>
    </div>
  );
}

function NodeMenu({ isSource, isProcessing, isPending, isBypassed, isInspected }: {
  readonly isSource: boolean;
  readonly isProcessing: boolean;
  readonly isPending: boolean;
  readonly isBypassed: boolean;
  readonly isInspected: boolean;
  readonly isRendered: boolean;
}) {
  let renderLabel = "Render";
  let renderColor = "text-chrome-text";

  if (isProcessing) { renderLabel = "Abort"; renderColor = "text-state-error"; }
  else if (isPending) { renderLabel = "Pending"; renderColor = "text-chrome-text-dim"; }

  const items: Array<MenuItem> = [];

  if (isSource) {
    items.push({
      kind: "action",
      label: "Inspect",
      icon: "lucide:eye",
      color: isInspected ? "text-primary" : undefined,
    });
  }

  if (!isSource) {
    items.push({
      kind: "action",
      label: renderLabel,
      icon: isProcessing ? "lucide:square" : "lucide:play",
      color: renderColor,
    });
  }

  items.push({
    kind: "action",
    label: isBypassed ? "Enable" : "Bypass",
    icon: "lucide:power",
    color: isBypassed ? "text-secondary" : undefined,
  });

  items.push({ kind: "separator" });

  items.push({
    kind: "action",
    label: "Delete",
    icon: "lucide:trash-2",
    color: "text-state-error",
  });

  return (
    <DropdownButton
      trigger={<IconButton icon="lucide:ellipsis-vertical" label="Node menu" dim />}
      items={items}
      align="right"
    />
  );
}

export function DemoNode({ data, selected, children }: NodeProps & { readonly children?: React.ReactNode }) {
  const nodeData = data as unknown as AudioNodeData;
  const isBypassed = nodeData.bypassed;
  const isInspected = nodeData.inspected ?? false;
  const hasInput = nodeData.category !== "source";
  const hasOutput = nodeData.category !== "target";
  const isSource = nodeData.category === "source";
  const hasSnapshot = nodeData.snapshot ?? false;
  const isProcessing = nodeData.state === "processing";
  const isPending = nodeData.state === "pending";
  const hasError = nodeData.error !== undefined;
  const progress = nodeData.progress;

  const onParameterChange = nodeData.onParameterChange;
  const onParameterBrowse = nodeData.onParameterBrowse;
  const numberParams = nodeData.parameters.filter((param): param is NumberParameter => param.kind === "number");
  const otherParams = nodeData.parameters.filter((param) => param.kind !== "number");

  // Render footer label
  let renderLabel: string | null = null;

  if (!isSource && !isBypassed) {
    if (isProcessing) renderLabel = "Abort";
    else if (isPending) renderLabel = "Pending";
    else renderLabel = "Render";
  }

  return (
    <div className="relative" style={{ width: 260 }}>
      <div
        className={`flex flex-col gap-1 ${isBypassed ? "bg-chrome-base" : "bg-chrome-surface"} ${selected ? "ring-1 ring-interactive-focus" : ""} ${isInspected ? "ring-1 ring-primary" : ""}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span
            className={`font-body text-[length:var(--text-base)] font-medium ${isBypassed ? "text-chrome-text-dim" : "text-chrome-text"}`}
          >
            {nodeData.label}
          </span>
          <div className="flex items-center">
            {isSource && (
              <IconButton icon="lucide:eye" label="Inspect" active={isInspected} activeVariant="primary" />
            )}
            <IconButton icon="lucide:power" label="Bypass" active={isBypassed} activeVariant="secondary" />
            <NodeMenu isSource={isSource} isProcessing={isProcessing} isPending={isPending} isBypassed={isBypassed} isInspected={isInspected} isRendered={false} />
          </div>
        </div>

        {/* Description */}
        {nodeData.description && (
          <div className="px-3 pb-2">
            <span className="font-body text-[length:var(--text-xs)] text-chrome-text-secondary">
              {nodeData.description}
            </span>
          </div>
        )}

        {/* Parameters — non-number */}
        {otherParams.length > 0 && (
          <div className={`flex flex-col gap-3 px-3 pb-3 ${isBypassed ? "opacity-40" : ""}`}>
            {otherParams.map((param) => (
              <div key={param.name} className="flex flex-col gap-0.5">
                {param.kind === "boolean" ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${isBypassed ? "text-chrome-text-dim" : "text-chrome-text-secondary"}`}>
                      {param.name}
                    </span>
                    <Toggle
                      value={param.value}
                      onChange={onParameterChange ? (toggled) => onParameterChange(param.name, toggled) : undefined}
                    />
                  </div>
                ) : param.kind === "enum" ? (
                  <div className="flex flex-col gap-1">
                    <span className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${isBypassed ? "text-chrome-text-dim" : "text-chrome-text-secondary"}`}>
                      {param.name}
                    </span>
                    {param.options.every((opt) => opt.length <= 10) ? (
                      <ButtonSelection
                        active={param.value}
                        options={param.options}
                        onSelect={onParameterChange ? (option) => onParameterChange(param.name, option) : undefined}
                      />
                    ) : (
                      <Select
                        value={param.value}
                        options={param.options}
                        onSelect={onParameterChange ? (option) => onParameterChange(param.name, option) : undefined}
                      />
                    )}
                  </div>
                ) : param.kind === "file" ? (
                  <div className="flex flex-col gap-1">
                    <span className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${isBypassed ? "text-chrome-text-dim" : "text-chrome-text-secondary"}`}>
                      {param.name}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-body text-[length:var(--text-xs)] text-chrome-text">
                        {param.value ? param.value.split(/[/\\]/).pop() : "No file selected"}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onParameterBrowse?.(param.name)}
                        disabled={!onParameterBrowse}
                      >
                        Browse
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${isBypassed ? "text-chrome-text-dim" : "text-chrome-text-secondary"}`}>
                      {param.name}
                    </span>
                    <input
                      key={param.value}
                      type="text"
                      defaultValue={param.value}
                      onBlur={onParameterChange ? (ev) => onParameterChange(param.name, ev.target.value) : undefined}
                      onKeyDown={(ev) => { if (ev.key === "Enter") ev.currentTarget.blur(); }}
                      className="w-full bg-chrome-base px-2 py-1.5 font-technical text-[length:var(--text-sm)] text-chrome-text outline-none"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Number parameters as knobs — label left, value+knob right */}
        {numberParams.length > 0 && (
          <div className="flex flex-col gap-3 px-3 pb-3">
            {numberParams.map((param) => (
              onParameterChange
                ? <EditableKnob key={param.name} param={param} dimmed={isBypassed} onParameterChange={onParameterChange} />
                : <ReadOnlyKnob key={param.name} param={param} dimmed={isBypassed} />
            ))}
          </div>
        )}

        {/* Render / Abort / Pending footer */}
        {renderLabel && (
          <div className="flex items-center justify-end px-3 pb-2">
            {isProcessing && progress !== undefined && (
              <div className="mr-auto flex items-center gap-2">
                <div className="h-1 w-20 bg-chrome-raised">
                  <div className="h-full bg-state-processing" style={{ width: `${progress * 100}%` }} />
                </div>
                <span className="font-technical text-[length:var(--text-xs)] tabular-nums text-state-processing">
                  {Math.round(progress * 100)}%
                </span>
              </div>
            )}
            <span
              className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${
                isProcessing
                  ? "bg-state-error text-void"
                  : isPending
                    ? "bg-chrome-raised text-chrome-text-dim"
                    : "bg-chrome-raised text-chrome-text-dim hover:text-chrome-text-secondary cursor-pointer"
              }`}
            >
              {renderLabel}
            </span>
          </div>
        )}

        {/* Ports — triangles pointing in flow direction */}
        {hasInput && (
          <Handle
            type="target"
            position={Position.Left}
            id="target"
            className="!bg-chrome-text-dim !border-0 !rounded-none"
            style={{
              left: -5,
              width: 8,
              height: 10,
              clipPath: "polygon(0% 0%, 100% 50%, 0% 100%)",
            }}
          />
        )}
        {hasOutput && (
          <Handle
            type="source"
            position={Position.Right}
            id="source"
            className="!bg-chrome-text-dim !border-0 !rounded-none"
            style={{
              right: -5,
              width: 8,
              height: 10,
              clipPath: "polygon(0% 0%, 0% 100%, 100% 50%)",
            }}
          />
        )}
      </div>

      {/* Snapshot — rendered by consumer via children */}
      {hasSnapshot && children}

      {/* Error toast — floating below everything with margin */}
      {hasError && (
        <div className="mt-3 flex items-start gap-1.5 bg-state-error/20 px-3 py-2 ring-1 ring-state-error/40">
          <Icon icon="lucide:alert-triangle" width={12} height={12} className="mt-0.5 shrink-0 text-state-error" />
          <span className="font-body text-[length:var(--text-xs)] text-state-error">
            {nodeData.error}
          </span>
        </div>
      )}
    </div>
  );
}
