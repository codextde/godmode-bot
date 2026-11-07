import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

// Firebase's Android config stays out of the public repository; release builds copy it in.
export default ({ config }: ConfigContext): ExpoConfig => {
  const firebase = existsSync(join(__dirname, "google-services.json"));
  return { ...(config as ExpoConfig), android: { ...config.android, ...(firebase ? { googleServicesFile: "./google-services.json" } : {}) } };
};
