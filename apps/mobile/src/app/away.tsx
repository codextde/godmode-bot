import { ScrollView, StyleSheet } from "react-native";
import { AwayDetail } from "@/components/away-summary";
import { space, useColors } from "@/lib/theme";

/** What the team did while the human was away, opened from the one line on Home. */
export default function AwaySheet() {
  const c = useColors();
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <AwayDetail />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: space.xl,
    paddingHorizontal: space.lg,
    paddingBottom: 60,
  },
});
