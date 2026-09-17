"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Cpu, Search } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { ModelOption } from "@/lib/hq/model-option";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "./provider-icons";

export type ModelPickerOption = ModelOption & {
  /** Overrides the provider logo, e.g. a folder icon for repos. */
  icon?: ReactNode;
};

type OptionGroup = { value: string; items: ModelPickerOption[] };

export type ModelPickerProps = {
  models: readonly ModelPickerOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  emptyIcon?: ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  searchPlaceholder?: string;
  /** Screen-reader label for the trigger. */
  triggerLabel?: string;
  /** Open the menu at the trigger's width instead of a fixed width. */
  matchTriggerWidth?: boolean;
  side?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
};

function matchesQuery(option: ModelPickerOption, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    option.name,
    option.provider,
    option.id,
    option.description ?? "",
    ...(option.keywords ?? []),
  ].some((part) => part.toLowerCase().includes(needle));
}

function OptionMark({ option }: { option: ModelPickerOption }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"
    >
      {option.icon ?? <ProviderIcon id={option.providerId} className="size-4" />}
    </span>
  );
}

/**
 * Searchable, grouped single-select built on Base UI's Combobox: a trigger
 * button opens a popup with the search field inside it. Rows are grouped by
 * their `provider` value, in the order the groups first appear.
 */
export function ModelPicker({
  models,
  value,
  onValueChange,
  disabled = false,
  placeholder = "Select model",
  emptyIcon,
  emptyTitle = "No models found",
  emptyHint = "Try a model name or provider.",
  searchPlaceholder = "Search models or providers…",
  triggerLabel = "Select model",
  matchTriggerWidth = false,
  side = "bottom",
  align = "start",
  className,
}: ModelPickerProps) {
  const groups = useMemo<OptionGroup[]>(() => {
    const byGroup = new Map<string, ModelPickerOption[]>();
    for (const option of models) {
      const list = byGroup.get(option.provider) ?? [];
      list.push(option);
      byGroup.set(option.provider, list);
    }
    return [...byGroup].map(([group, items]) => ({ value: group, items }));
  }, [models]);

  const selected = models.find((option) => option.id === value) ?? null;

  return (
    <Combobox.Root
      items={groups}
      value={selected}
      onValueChange={(next: ModelPickerOption | null) => {
        if (next) onValueChange?.(next.id);
      }}
      itemToStringLabel={(option: ModelPickerOption) => option.name}
      isItemEqualToValue={(item: ModelPickerOption, current: ModelPickerOption) =>
        item.id === current.id
      }
      filter={(option: ModelPickerOption, query: string) =>
        matchesQuery(option, query)
      }
      disabled={disabled}
      autoHighlight
    >
      <Combobox.Trigger
        aria-label={`${triggerLabel}${selected ? `, current: ${selected.name}` : ""}`}
        className={cn(
          "inline-flex h-10 min-w-52 items-center justify-between gap-2 rounded-full border border-border bg-transparent px-3 text-foreground outline-none transition-colors hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selected ? (
            <OptionMark option={selected} />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"
            >
              {emptyIcon ?? <Cpu className="size-4" />}
            </span>
          )}
          <span className="truncate text-sm">{selected?.name ?? placeholder}</span>
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </Combobox.Trigger>

      <Combobox.Portal>
        <Combobox.Positioner
          side={side}
          align={align}
          sideOffset={8}
          className="isolate z-50 outline-none"
        >
          <Combobox.Popup
            className={cn(
              "flex max-h-[min(26rem,var(--available-height))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg outline-none",
              matchTriggerWidth ? "w-(--anchor-width)" : "w-80",
            )}
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <Combobox.Input
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <Combobox.Empty className="flex flex-col items-center gap-1.5 px-5 py-8 text-center empty:hidden">
              <Search aria-hidden="true" className="size-5 text-muted-foreground" />
              <p className="text-sm font-medium">{emptyTitle}</p>
              <p className="text-xs text-muted-foreground">{emptyHint}</p>
            </Combobox.Empty>

            <Combobox.List className="min-h-0 overflow-y-auto p-1.5 empty:hidden">
              {(group: OptionGroup) => (
                <Combobox.Group key={group.value} items={group.items} className="py-1">
                  <Combobox.GroupLabel className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {group.value}
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(option: ModelPickerOption) => (
                      <Combobox.Item
                        key={option.id}
                        value={option}
                        disabled={option.disabled}
                        className="flex cursor-default items-center gap-2 rounded-xl px-2 py-2 outline-none select-none data-disabled:opacity-40 data-highlighted:bg-muted"
                      >
                        <OptionMark option={option} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm">{option.name}</span>
                            {option.badge ? (
                              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {option.badge}
                              </span>
                            ) : null}
                          </span>
                          {option.description ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                        <Combobox.ItemIndicator className="shrink-0 text-foreground">
                          <Check aria-hidden="true" className="size-4" />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
