import type { ReactNode } from "react";
import Link from "next/link";
import { ScrollToHighlight } from "@/components/scroll-to-highlight";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface DataTableColumn<T> {
  id: string;
  /** Column header; also the line label in the stacked card layout. */
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** The card title in the stacked layout (defaults to the first column). */
  title?: boolean;
  /**
   * Place in the stacked layout: "line" = a labelled line (at most three are shown), "aside" = next to the title
   * (a status badge), false = table only. Without any `card` settings the first three other columns become lines.
   */
  card?: "line" | "aside" | false;
  align?: "left" | "right";
  /** Ids, amounts, versions, addresses (house rule 3). */
  mono?: boolean;
  /** Hide this column in the table layout while the list is narrower than this container size. */
  hideBelow?: "3xl" | "4xl" | "5xl";
  /** Extra classes for the column's cells (e.g. a width: "w-40"). */
  className?: string;
}

const HIDE: Record<NonNullable<DataTableColumn<unknown>["hideBelow"]>, string> = {
  "3xl": "hidden @3xl/table:table-cell",
  "4xl": "hidden @4xl/table:table-cell",
  "5xl": "hidden @5xl/table:table-cell",
};

/**
 * The one list component (house rule 7). A table when the list is at least `@2xl` (672 px) wide, stacked cards below
 * it: the title column, up to three labelled lines and the row actions in a trailing menu. Nothing scrolls sideways.
 * Works in server and client components (no hooks). `rowActions` returns the row's trailing control, normally a
 * <RowActions> menu (from "@/components/row-actions"), which also hosts its confirmation dialogs.
 *
 *   <DataTable
 *     caption="People"
 *     rows={users}
 *     getRowId={(u) => u.id}
 *     rowHref={(u) => `/admin/users/${u.id}`}
 * *     columns={[
 *       { id: "name", header: "Name", cell: (u) => u.name ?? u.email },
 *       { id: "status", header: "Status", cell: (u) => <StatusBadge …/>, card: "aside" },
 *       { id: "role", header: "Role", cell: (u) => u.roleName, card: "line" },
 *       { id: "seen", header: "Last sign-in", cell: (u) => <RelativeTime date={u.lastSeenAt} />, card: "line", hideBelow: "4xl" },
 *     ]}
 *     rowActions={(u) => (
 *       <RowActions label={`Actions for ${u.email}`} items={[
 *         { label: "Open", href: `/admin/users/${u.id}` },
 *         { label: "Delete", tone: "danger", separator: true, confirm: { title: "Delete this person?", confirmLabel: "Delete",
 *           pendingLabel: "Deleting…", onConfirm: deleteUserAction.bind(null, u.id), successMessage: "Person deleted" } },
 *       ]} />
 *     )}
 *     footer={<Pagination total={total} noun={["person", "people"]} />}
 *     empty={<EmptyState icon={<Users />} title="No one matches this search." />}
 *   />
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  rowHref,
  rowActions,
  highlightId,
  empty,
  footer,
  bare = false,
  className,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Names the table for screen readers (visually hidden). */
  caption: string;
  /** Makes the title a link (and the whole card tappable in the stacked layout). */
  rowHref?: (row: T) => string | null | undefined;
  /** The row's trailing control (a <RowActions> menu); return null for rows without actions. */
  rowActions?: (row: T) => ReactNode;
  /** Highlights and scrolls to this row (e.g. `?invoice=<id>`). */
  highlightId?: string | null;
  /** Shown instead of the table when there are no rows (usually an EmptyState). */
  empty?: ReactNode;
  /** Below the rows, inside the card — usually <Pagination />. */
  footer?: ReactNode;
  /** No card chrome, for use inside a SettingsGroup with bodyClassName="px-0". */
  bare?: boolean;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  const titleCol = columns.find((c) => c.title) ?? columns[0];
  const others = columns.filter((c) => c !== titleCol);
  const explicit = others.some((c) => c.card !== undefined);
  const asides = others.filter((c) => c.card === "aside");
  const lines = (explicit ? others.filter((c) => c.card === "line") : others).slice(0, 3);
  const hasActions = Boolean(rowActions);

  const title = (row: T, stacked: boolean) => {
    const href = rowHref?.(row);
    const content = titleCol.cell(row);
    if (!href) return content;
    return (
      <Link
        href={href}
        className={cn(
          "rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50",
          // In a card the link covers the whole card; the actions button sits above it.
          stacked && "after:absolute after:inset-0 after:content-['']",
        )}
      >
        {content}
      </Link>
    );
  };

  // Above the card-wide title link of the stacked layout.
  const actions = (row: T) => <div className="relative z-10 flex justify-end">{rowActions?.(row)}</div>;

  return (
    <div
      className={cn(
        "@container/table min-w-0",
        !bare && "animate-enter overflow-hidden rounded-xl border bg-card shadow-card",
        className,
      )}
    >
      {highlightId && <ScrollToHighlight id={highlightId} />}

      {/* Table layout */}
      <div className="hidden @2xl/table:block">
        <Table className="table-auto">
          <caption className="sr-only">{caption}</caption>
          <TableHeader className="bg-paper-2/70">
            <TableRow className="hover:bg-transparent">
              {columns.map((c) => (
                <TableHead
                  key={c.id}
                  scope="col"
                  className={cn(
                    "h-9 px-3 text-xs font-medium text-muted-foreground first:pl-5",
                    c.align === "right" && "text-right",
                    c.hideBelow && HIDE[c.hideBelow],
                    c.className,
                  )}
                >
                  {c.header}
                </TableHead>
              ))}
              {hasActions && (
                <TableHead className="w-12 pr-3">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const id = getRowId(row);
              const highlighted = highlightId === id;
              return (
                <TableRow
                  key={id}
                  data-row-id={id}
                  data-highlighted={highlighted || undefined}
                  className={cn("hover:bg-paper-2/60", highlighted && "bg-accent/70 hover:bg-accent/70")}
                >
                  {columns.map((c) => (
                    <TableCell
                      key={c.id}
                      className={cn(
                        "px-3 py-2.5 whitespace-normal [overflow-wrap:anywhere] first:pl-5",
                        c === titleCol && "font-medium",
                        c.align === "right" && "text-right",
                        c.mono && "font-mono text-xs tabular-nums",
                        c.hideBelow && HIDE[c.hideBelow],
                        c.className,
                      )}
                    >
                      {c === titleCol ? title(row, false) : c.cell(row)}
                    </TableCell>
                  ))}
                  {hasActions && <TableCell className="w-12 py-1.5 pr-3 text-right">{actions(row)}</TableCell>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {rows.length === 0 && <p className="px-5 py-10 text-center text-sm text-muted-foreground">Nothing here yet.</p>}
      </div>

      {/* Stacked layout */}
      <ul aria-label={caption} className="divide-y @2xl/table:hidden">
        {rows.map((row) => {
          const id = getRowId(row);
          const highlighted = highlightId === id;
          return (
            <li
              key={id}
              data-row-id={id}
              data-highlighted={highlighted || undefined}
              className={cn("relative px-4 py-3.5", highlighted && "bg-accent/70")}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 pt-1 text-sm font-medium [overflow-wrap:anywhere]">{title(row, true)}</div>
                {asides.map((c) => (
                  <div key={c.id} className={cn("relative shrink-0 pt-0.5", c.mono && "font-mono text-xs tabular-nums")}>
                    {c.cell(row)}
                  </div>
                ))}
                {hasActions && <div className="-mr-1.5 shrink-0">{actions(row)}</div>}
              </div>
              {lines.length > 0 && (
                <dl className="mt-2 space-y-1">
                  {lines.map((c) => (
                    <div key={c.id} className="flex items-baseline justify-between gap-4 text-[13px]">
                      <dt className="shrink-0 text-muted-foreground">{c.header}</dt>
                      <dd className={cn("min-w-0 text-right [overflow-wrap:anywhere]", c.mono && "font-mono text-xs tabular-nums")}>
                        {c.cell(row)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
        {rows.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing here yet.</li>}
      </ul>

      {footer && <div className={cn("border-t px-4 py-3 @2xl/table:px-5", bare && "px-0 @2xl/table:px-0")}>{footer}</div>}
    </div>
  );
}
