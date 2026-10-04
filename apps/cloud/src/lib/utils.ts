// One class merger for the whole app: the `cn` package is a compiled drop-in for clsx + tailwind-merge.
// The ui primitives import it from "cn" directly (as in apps/desktop); everything else imports it from here.
export { cn, type ClassValue } from "cn";
