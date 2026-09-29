import { useState } from "react";

/** Pull-to-refresh state that only spins for the user's own pull, not for background refetches. */
export function usePullRefresh(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };
  return { refreshing, onRefresh: () => void onRefresh() };
}
