import { Link } from "react-router";
import { Archive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { archiveCount, useArchiveList } from "./use-archive";

/** The way to the archive from the pages whose things end up there; hidden while it is empty. */
export function ArchiveLink() {
  const { t } = useTranslation("archive");
  const { data } = useArchiveList();
  const count = archiveCount(data);
  if (!count) return null;
  return (
    <Button asChild variant="ghost" className="text-muted-foreground">
      <Link to="/archive">
        <Archive /> {t("open")} <span className="tabular-nums">{count}</span>
      </Link>
    </Button>
  );
}
