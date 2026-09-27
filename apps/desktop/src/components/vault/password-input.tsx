import { forwardRef, useState, type ComponentProps, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Masked input with a show/hide toggle. Extra trailing controls can be passed via `trailing`. */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<ComponentProps<"input">, "type"> & { trailing?: ReactNode; groupClassName?: string; leading?: ReactNode }
>(function PasswordInput({ trailing, leading, groupClassName, className, ...props }, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup className={cn("h-10", groupClassName)}>
      {leading && <InputGroupAddon>{leading}</InputGroupAddon>}
      <InputGroupInput
        ref={ref}
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn("font-mono tracking-wide placeholder:font-sans placeholder:tracking-normal", className)}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        {trailing}
        <Tooltip>
          <TooltipTrigger asChild>
            <InputGroupButton
              size="icon-xs"
              aria-label={visible ? "Hide" : "Show"}
              aria-pressed={visible}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </TooltipTrigger>
          <TooltipContent>{visible ? "Hide" : "Show"}</TooltipContent>
        </Tooltip>
      </InputGroupAddon>
    </InputGroup>
  );
});
