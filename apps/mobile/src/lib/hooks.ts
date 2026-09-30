import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Agent } from "@godmode/shared";
import { api } from "./api";
import { qk } from "./query";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useAgents() {
  const query = useQuery({ queryKey: qk.agents, queryFn: api.agents.list });
  const byId = useMemo(() => new Map<string, Agent>((query.data ?? []).map((a) => [a.id, a])), [query.data]);
  return { ...query, byId };
}
