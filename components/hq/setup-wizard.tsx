"use client";

import { Check, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type SetupAnswers = Record<string, string>;

export type SetupField = {
  id: string;
  label: string;
  /** A `choice` is one of a few options, shown as buttons. */
  type: "text" | "email" | "select" | "connect" | "choice";
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  span?: "half" | "full";
  options?: { value: string; label: string }[];
  /** Connect fields: a link to open, used when there is no `onConnect`. */
  href?: string;
  onConnect?: () => void;
  connected?: boolean;
  connectedLabel?: string;
  waitHint?: string;
};

export type SetupSection = {
  id: string;
  label: string;
  title: string;
  description: string;
  /** Shown above the description, e.g. a mascot introducing the step. */
  illustration?: ReactNode;
  fields: SetupField[];
};

export type SetupWizardProps = {
  sections: SetupSection[];
  heading: string;
  subheading?: string;
  submitLabel?: string;
  successTitle?: string;
  successDescription?: string;
  successCta?: { label: string; href: string };
  initialAnswers?: SetupAnswers;
  /** Which section to open on. Read once, when the wizard mounts. */
  initialStep?: number;
  onAnswersChange?: (answers: SetupAnswers) => void;
  /** Return false to stay on the last step, for example when saving failed. */
  onComplete?: (answers: SetupAnswers) => boolean | void | Promise<boolean | void>;
  className?: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Connections come only from the caller (the server's state), never from answers. */
function isConnected(field: SetupField) {
  return Boolean(field.connected);
}

/** The same rule `validate` applies to a section's connections, without answers. */
function connectionsSatisfied(section: SetupSection) {
  const connects = section.fields.filter((field) => field.type === "connect");
  if (connects.some((field) => field.required && !isConnected(field))) return false;
  return connects.length === 0 || connects.some(isConnected);
}

/**
 * The first section still missing a connection, or the last one when they are
 * all satisfied. Setup is left and returned to — creating the GitHub App goes
 * to GitHub and comes back — so a caller whose sections describe server state
 * can pass this as `initialStep` and reopen where the reader left off instead
 * of at the top.
 */
export function firstUnfinishedSection(sections: SetupSection[]) {
  const index = sections.findIndex((section) => !connectionsSatisfied(section));
  return index === -1 ? Math.max(sections.length - 1, 0) : index;
}

/** Returns an error message per field id for one section. */
function validate(section: SetupSection, answers: SetupAnswers) {
  const errors: Record<string, string> = {};
  const connects = section.fields.filter((field) => field.type === "connect");

  for (const field of section.fields) {
    const value = answers[field.id]?.trim() ?? "";
    if (field.type === "connect") {
      if (field.required && !isConnected(field)) {
        errors[field.id] = "Connect this to continue.";
      }
      continue;
    }
    if (field.required && !value) errors[field.id] = "This is required.";
    else if (field.type === "email" && value && !EMAIL.test(value)) {
      errors[field.id] = "Enter a valid email address.";
    }
  }

  // A section of optional connections still needs at least one of them.
  const anyRequired = connects.some((field) => field.required);
  if (connects.length && !anyRequired && !connects.some((f) => isConnected(f))) {
    errors[connects[0].id] = "Connect at least one to continue.";
  }
  return errors;
}

const inputClass =
  "h-11 w-full rounded-xl border border-fog bg-paper-white px-3 text-[14px] text-carbon outline-none placeholder:text-ash focus:border-carbon aria-invalid:border-ember";

/**
 * A multi-step setup form: one section at a time, required-field checks per
 * step, and a success panel at the end.
 */
export function SetupWizard({
  sections,
  heading,
  subheading,
  submitLabel = "Finish",
  successTitle = "All set.",
  successDescription,
  successCta,
  initialAnswers,
  initialStep,
  onAnswersChange,
  onComplete,
  className,
}: SetupWizardProps) {
  const [step, setStep] = useState(initialStep ?? 0);
  const [answers, setAnswers] = useState<SetupAnswers>(initialAnswers ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const safeStep = Math.min(step, Math.max(sections.length - 1, 0));
  const section = sections[safeStep];
  const last = safeStep === sections.length - 1;

  function update(id: string, value: string) {
    setAnswers((current) => {
      const next = { ...current, [id]: value };
      onAnswersChange?.(next);
      return next;
    });
    setErrors((current) => ({ ...current, [id]: "" }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!section) return;
    const found = validate(section, answers);
    setErrors(found);
    const firstInvalid = section.fields.find((field) => found[field.id]);
    if (firstInvalid) {
      document.getElementById(`setup-${firstInvalid.id}`)?.focus();
      return;
    }
    if (last) {
      setFinishing(true);
      const result = await onComplete?.(answers);
      setFinishing(false);
      if (result !== false) setDone(true);
      return;
    }
    setStep(safeStep + 1);
  }

  if (done) {
    return (
      <div className={cn("mx-auto w-full max-w-3xl px-4 pt-10 pb-16 sm:px-6", className)}>
        <div className="rounded-2xl border border-fog bg-paper-white p-8 text-center">
          <CircleCheck aria-hidden="true" className="mx-auto size-8 text-mint" />
          <h2 className="mt-4 text-[24px] font-semibold tracking-[-0.48px]">{successTitle}</h2>
          {successDescription ? (
            <p className="mt-2 text-[15px] leading-6 text-graphite">{successDescription}</p>
          ) : null}
          {successCta ? (
            <Link
              href={successCta.href}
              className="mt-6 inline-flex h-11 items-center rounded-full bg-brand px-5 text-[14px] font-medium text-brand-foreground"
            >
              {successCta.label}
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  if (!section) return null;

  return (
    <div className={cn("mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-6", className)}>
      <h1 className="text-[32px] font-semibold tracking-[-0.64px]">{heading}</h1>
      {subheading ? (
        <p className="mt-2 text-[15px] leading-6 text-graphite">{subheading}</p>
      ) : null}

      <ol className="mt-6 flex flex-wrap gap-2" aria-label="Setup steps">
        {sections.map((item, index) => {
          const state = index < safeStep ? "done" : index === safeStep ? "current" : "todo";
          return (
            <li
              key={item.id}
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium",
                state === "current" && "border-carbon bg-carbon text-linen",
                state === "done" && "border-fog text-graphite",
                state === "todo" && "border-fog text-ash",
              )}
            >
              {state === "done" ? (
                <Check aria-hidden="true" className="size-3.5" />
              ) : (
                <span aria-hidden="true">{index + 1}</span>
              )}
              {item.label}
            </li>
          );
        })}
      </ol>

      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        className="mt-6 rounded-2xl border border-fog bg-paper-white p-5 sm:p-6"
      >
        {section.illustration ? (
          <div className="mb-4 flex justify-center">{section.illustration}</div>
        ) : null}
        <h2 className="text-[20px] font-semibold tracking-[-0.4px]">{section.title}</h2>
        <p className="mt-1.5 text-[14px] leading-6 text-graphite">{section.description}</p>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {section.fields.map((field) => {
            const error = errors[field.id];
            const fieldId = `setup-${field.id}`;
            const errorId = `${fieldId}-error`;
            if (field.type === "choice") {
              return (
                <Field
                  key={field.id}
                  data-invalid={Boolean(error) || undefined}
                  className={cn("min-w-0", field.span !== "half" && "sm:col-span-2")}
                >
                  <FieldLabel htmlFor={fieldId} className="text-[13px] font-medium text-carbon">
                    {field.label}
                    {field.required ? <span className="text-ash"> *</span> : null}
                  </FieldLabel>
                  <ToggleGroup
                    id={fieldId}
                    variant="outline"
                    size="lg"
                    value={answers[field.id] ? [answers[field.id]] : []}
                    onValueChange={(value) => update(field.id, String(value[0] ?? ""))}
                    aria-invalid={Boolean(error) || undefined}
                    aria-describedby={error ? errorId : undefined}
                    className="flex-wrap"
                  >
                    {(field.options ?? []).map((option) => (
                      <ToggleGroupItem
                        key={option.value}
                        value={option.value}
                        className="rounded-full px-5 data-pressed:border-brand data-pressed:bg-brand data-pressed:text-brand-foreground"
                      >
                        {option.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {error ? (
                    <p id={errorId} className="text-[12px] text-ember">
                      {error}
                    </p>
                  ) : null}
                </Field>
              );
            }
            return (
              <div
                key={field.id}
                className={cn("flex min-w-0 flex-col gap-1.5", field.span !== "half" && "sm:col-span-2")}
              >
                <label htmlFor={fieldId} className="text-[13px] font-medium text-carbon">
                  {field.label}
                  {field.required ? <span className="text-ash"> *</span> : null}
                </label>

                {field.type === "connect" ? (
                  <ConnectControl
                    id={fieldId}
                    field={field}
                    connected={isConnected(field)}
                    describedBy={error ? errorId : undefined}
                  />
                ) : field.type === "select" ? (
                  <select
                    id={fieldId}
                    value={answers[field.id] ?? ""}
                    onChange={(event) => update(field.id, event.target.value)}
                    aria-invalid={Boolean(error) || undefined}
                    aria-describedby={error ? errorId : undefined}
                    className={inputClass}
                  >
                    <option value="" disabled>
                      {field.placeholder ?? "Select…"}
                    </option>
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={fieldId}
                    type={field.type}
                    value={answers[field.id] ?? ""}
                    onChange={(event) => update(field.id, event.target.value)}
                    placeholder={field.placeholder}
                    autoComplete={field.autoComplete}
                    aria-invalid={Boolean(error) || undefined}
                    aria-describedby={error ? errorId : undefined}
                    className={inputClass}
                  />
                )}

                {error ? (
                  <p id={errorId} className="text-[12px] text-ember">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-8 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setErrors({});
              setStep(Math.max(safeStep - 1, 0));
            }}
            disabled={safeStep === 0}
            className="h-10 rounded-full border border-fog px-4 text-[13px] font-medium text-carbon disabled:opacity-40"
          >
            Back
          </button>
          <button
            type="submit"
            disabled={finishing}
            className="h-10 rounded-full bg-brand px-5 text-[13px] font-medium text-brand-foreground disabled:opacity-60"
          >
            {last ? submitLabel : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConnectControl({
  id,
  field,
  connected,
  describedBy,
}: {
  id: string;
  field: SetupField;
  connected: boolean;
  describedBy?: string;
}) {
  const label = connected
    ? (field.connectedLabel ?? "Connected")
    : (field.placeholder ?? "Connect");
  const buttonClass = cn(
    "inline-flex h-10 items-center justify-center rounded-full px-4 text-[13px] font-medium",
    connected ? "border border-fog text-carbon" : "bg-brand text-brand-foreground",
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      {field.onConnect ? (
        <button
          id={id}
          type="button"
          onClick={field.onConnect}
          aria-describedby={describedBy}
          className={buttonClass}
        >
          {label}
        </button>
      ) : (
        <Link
          id={id}
          href={field.href ?? "#"}
          aria-describedby={describedBy}
          className={buttonClass}
        >
          {label}
        </Link>
      )}
      {connected ? (
        <span className="flex items-center gap-1 text-[12px] text-mint">
          <Check aria-hidden="true" className="size-3.5" />
          Ready
        </span>
      ) : field.waitHint ? (
        <span className="text-[12px] text-ash">{field.waitHint}</span>
      ) : null}
    </div>
  );
}
