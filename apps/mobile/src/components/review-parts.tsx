import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { ReviewStatus } from "@godmode/shared";
import type { Tone } from "./ui";
import { api, errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";

export const isActive = (status: ReviewStatus) => status === "queued" || status === "running";

export const STATUS_TONE: Record<ReviewStatus, Tone> = {
  queued: "brand",
  running: "brand",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
};

/** The overview, polled while a review works. */
export function useReviews() {
  return useQuery({
    queryKey: sq.reviews,
    queryFn: settingsApi.reviews.overview,
    refetchInterval: (q) => (q.state.data?.active ? 5_000 : 60_000),
  });
}

/** Stops the review's run; it ends as cancelled. */
export function useStopReview() {
  const { t } = useTranslation("review");
  return useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: sq.reviews }),
    onError: (err) => Alert.alert(t("stopFailed"), errorText(err)),
  });
}
