import { useId, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUi } from "@/stores/ui";

export interface EditableNavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

export function EditSidebarButton({ items }: { items: EditableNavItem[] }) {
  const { t } = useTranslation("layout");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-sidebar-foreground/70 opacity-0 transition group-hover/section:opacity-100 hover:text-sidebar-foreground focus-visible:opacity-100 data-[state=delayed-open]:opacity-100 pointer-coarse:opacity-100 group-data-[collapsible=icon]:hidden [&_svg]:size-3.5"
            aria-label={t("editSidebar.title")}
            onClick={() => setOpen(true)}
          >
            <Menu />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("editSidebar.title")}</TooltipContent>
      </Tooltip>
      <EditSidebarDialog open={open} onOpenChange={setOpen} items={items} />
    </>
  );
}

function EditSidebarDialog({ open, onOpenChange, items }: { open: boolean; onOpenChange: (open: boolean) => void; items: EditableNavItem[] }) {
  const { t } = useTranslation(["layout", "common"]);
  const hidden = useUi((s) => s.hiddenNav);
  const toggle = useUi((s) => s.toggleNavHidden);
  const baseId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("editSidebar.title")}</DialogTitle>
          <DialogDescription>{t("editSidebar.description")}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1">
          {items.map((item) => {
            const id = `${baseId}-${item.to}`;
            return (
              <li key={item.to}>
                <label htmlFor={id} className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 text-sm [&>svg]:size-4 [&>svg]:text-muted-foreground">
                  <Checkbox id={id} checked={!hidden.includes(item.to)} onCheckedChange={() => toggle(item.to)} />
                  {item.icon}
                  {item.label}
                </label>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common:actions.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
