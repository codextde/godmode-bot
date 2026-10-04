import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ControlProps = {
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

/**
 * Label, control, hint and inline error (house rule 6). The single child control receives `id`, `aria-invalid` and
 * `aria-describedby`, so pass a bare <Input>, <Textarea>, <SelectTrigger> or <InputOTP>:
 *
 *   <FormField label="Name" error={fields.name} hint="Shown to people you invite.">
 *     <Input value={name} onChange={(e) => setName(e.target.value)} />
 *   </FormField>
 */
export function FormField({
  label,
  hint,
  error,
  optional = false,
  id: idProp,
  labelAction,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** The field's error sentence; also marks the control invalid. */
  error?: string | null;
  /** Adds a muted "optional" after the label. */
  optional?: boolean;
  id?: string;
  /** Something small at the end of the label row, e.g. a "Generate" link. */
  labelAction?: ReactNode;
  children: ReactElement<ControlProps>;
  className?: string;
}) {
  const autoId = useId();
  const id = idProp ?? children.props.id ?? `field${autoId.replace(/[^\w-]/g, "")}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, "aria-invalid": error ? true : children.props["aria-invalid"], "aria-describedby": describedBy })
    : children;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
          {optional && <span className="text-[11px] font-normal text-muted-foreground">optional</span>}
        </Label>
        {labelAction}
      </div>
      {control}
      {hint && (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Stacks FormFields with the house rhythm. */
export function FormStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-5", className)}>{children}</div>;
}

/**
 * The action row at the end of a page-long form. On narrow containers (phones) it sticks to the bottom of the
 * screen with the safe-area inset (house rule 12); from `@xl` it sits inline, right-aligned.
 */
export function FormActions({ children, sticky = true, className }: { children: ReactNode; sticky?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2",
        sticky &&
          "@max-xl:sticky @max-xl:bottom-0 @max-xl:z-10 @max-xl:-mx-5 @max-xl:border-t @max-xl:bg-background/90 @max-xl:px-5 @max-xl:pt-3 @max-xl:pb-[calc(0.75rem+env(safe-area-inset-bottom))] @max-xl:backdrop-blur-md @max-xl:[&>*]:flex-1",
        className,
      )}
    >
      {children}
    </div>
  );
}
