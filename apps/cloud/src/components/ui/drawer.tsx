"use client"

import * as React from "react"
import { cn } from "cn"
import { Drawer as DrawerPrimitive } from "vaul"

function Drawer({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          "group/drawer-content fixed z-50 flex h-auto flex-col border bg-card text-card-foreground shadow-float outline-none",
          "data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[85svh] data-[vaul-drawer-direction=top]:rounded-b-2xl data-[vaul-drawer-direction=top]:border-t-0 data-[vaul-drawer-direction=top]:pt-[env(safe-area-inset-top)]",
          "data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[85svh] data-[vaul-drawer-direction=bottom]:rounded-t-2xl data-[vaul-drawer-direction=bottom]:border-b-0 data-[vaul-drawer-direction=bottom]:pb-[env(safe-area-inset-bottom)]",
          "data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:border-y-0 data-[vaul-drawer-direction=right]:border-r-0 data-[vaul-drawer-direction=right]:sm:max-w-sm",
          "data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:border-y-0 data-[vaul-drawer-direction=left]:border-l-0 data-[vaul-drawer-direction=left]:sm:max-w-sm",
          className
        )}
        {...props}
      >
        <div
          aria-hidden
          className="mx-auto mt-2.5 hidden h-1 w-10 shrink-0 rounded-full bg-foreground/15 group-data-[vaul-drawer-direction=bottom]/drawer-content:block"
        />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-1 px-5 pt-4 pb-3 text-left", className)}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col-reverse gap-2 px-5 pt-3 pb-4", className)}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        "text-[17px] leading-snug font-medium tracking-[-0.015em] text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
}
