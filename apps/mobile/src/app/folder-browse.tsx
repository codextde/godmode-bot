import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { computerFolders, FolderBrowser, serverFolders } from "@/components/folder-browser";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { folderRequest, settleFolder } from "@/lib/folder-pick";
import { space, useColors } from "@/lib/theme";

/** The folder sheet another screen opens with `pickFolder`, for the computer or an SSH server. */
export default function FolderBrowse() {
  const c = useColors();
  const { fullAccess } = useFullAccess();
  const [request] = useState(folderRequest);
  const [source] = useState(() => (request?.serverId ? serverFolders(request.serverId) : computerFolders));
  // Swiped away: the screen that asked goes on without a folder.
  useEffect(() => () => settleFolder(null, request), [request]);

  if (fullAccess === false || !request) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  return (
    <FolderBrowser
      title={request.title}
      action={request.action}
      source={source}
      start={request.start}
      enabled={fullAccess === true}
      onUse={(path) => {
        settleFolder(path, request);
        router.back();
      }}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center", padding: space.lg },
});
