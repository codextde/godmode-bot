"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { useTheme } from "@/components/theme-provider"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved: theme } = useTheme()
  const { t } = useTranslation()
  // The close button sits on the corner next to the screen edge, and shows on hover where there is a mouse.
  const right = props.position?.endsWith("right") ?? false

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      toastOptions={{
        closeButtonAriaLabel: t("actions.close"),
        classNames: {
          toast: "group/toast",
          description: "line-clamp-4",
          closeButton:
            "[@media(hover:hover)]:opacity-0 group-hover/toast:opacity-100 focus-visible:opacity-100",
        },
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          ...(right && {
            "--toast-close-button-start": "unset",
            "--toast-close-button-end": "0",
            "--toast-close-button-transform": "translate(35%, -35%)",
          }),
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
