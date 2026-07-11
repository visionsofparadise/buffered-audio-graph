import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown } from "lucide-react";
import { cn } from "../utils/cn";

export interface SelectProps {
	readonly value: string;
	readonly options: ReadonlyArray<string>;
	readonly onChange?: (value: string) => void;
	readonly label?: string;
	readonly className?: string;
	readonly placeholder?: string;
}

export function Select({
	value,
	options,
	onChange,
	label,
	className,
	placeholder,
}: SelectProps) {
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			{label && (
				<span className="type-label text-text-secondary">{label}</span>
			)}
			<SelectPrimitive.Root value={value} onValueChange={onChange}>
				<SelectPrimitive.Trigger
					className={cn(
						"type-label inline-flex items-center justify-between gap-2 rounded-xs",
						"bg-elevated text-text-primary px-2 py-1 outline-none",
						"focus:ring-1 focus:ring-accent-primary",
					)}
				>
					<SelectPrimitive.Value placeholder={placeholder} />
					<SelectPrimitive.Icon asChild>
						<ChevronDown size={12} strokeWidth={1.5} />
					</SelectPrimitive.Icon>
				</SelectPrimitive.Trigger>
				<SelectPrimitive.Portal>
					<SelectPrimitive.Content
						position="popper"
						sideOffset={4}
						collisionPadding={8}
						className={cn(
							"z-50 overflow-hidden rounded-xs bg-elevated outline-none",
							"min-w-(--radix-select-trigger-width)",
						)}
					>
						<SelectPrimitive.Viewport className="py-1">
							{options.map((option) => (
								<SelectPrimitive.Item
									key={option}
									value={option}
									className={cn(
										"type-label flex cursor-pointer items-center px-2 py-1 outline-none",
										"text-text-primary",
										"data-[highlighted]:bg-text-primary data-[highlighted]:text-surface",
										"data-[disabled]:cursor-default data-[disabled]:text-dimmed",
									)}
								>
									<SelectPrimitive.ItemText>{option}</SelectPrimitive.ItemText>
								</SelectPrimitive.Item>
							))}
						</SelectPrimitive.Viewport>
					</SelectPrimitive.Content>
				</SelectPrimitive.Portal>
			</SelectPrimitive.Root>
		</div>
	);
}
