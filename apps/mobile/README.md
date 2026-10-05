# Godmode for iOS and Android

The phone app for Godmode: hand over tasks with photos and files, follow answers as they stream, stop runs, run
automations, and watch an agent's browser, shared screen or VM live (tap to take control). The chat input works like
the desktop's: photos and files, Claude Code's slash commands, a queue for messages sent while the agent works, and the
model, effort and Ultracode. It controls the Godmode running on your computer and
nothing else.

Built with [Expo](https://expo.dev) SDK 57 and Expo Router: native tabs and headers (Liquid Glass on iOS 26),
`expo-glass-effect` for floating controls, `expo-camera` for pairing, `expo-secure-store` for the device key,
`expo-image-picker` and `expo-document-picker` for attachments.

## Connecting

1. Tailscale on the computer and the phone, same account, or the computer linked to Godmode Cloud (Settings → Cloud)
   with phone access on. The app tries every address the computer lists and learns new ones (such as the gateway
   `https://<cloud>/gw/<id>`) from `GET /api/mobile/me`.
2. On the computer: Godmode → **Settings → Phone → Connect a phone**.
3. In the app: **Scan QR code**. The camera app works too (`godmode://pair?d=…` opens the app).

See [Phone app in docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#phone-app) for how pairing and access work.

## Develop

The app has its own toolchain (bun) and is not part of the pnpm workspace. It imports `@godmode/shared` from
`../../packages/shared` (Metro `watchFolders` + a tsconfig path).

```bash
cd apps/mobile
bun install
bun run ios          # development build in the iOS Simulator (Xcode 26+)
bun run android      # development build on an emulator or device (Android SDK)
bun run start        # Metro for an installed development build
bun run typecheck
```

Run a core with phone access on (`pnpm dev` at the repo root), open Settings → Phone, and pair. The iOS Simulator can
use the Mac's own Tailscale address; open a pairing link with
`xcrun simctl openurl booted "godmode://pair?d=…"` (copy it from the QR code dialog's request in the network tab, or
use **Paste pairing link** in the scanner).

Builds for devices go through EAS (`bunx eas-cli build --profile preview`, see `eas.json`).

## Releasing

The app is **Godmode Bot** in both stores (Codext GmbH): App Store app id 6817670733 and Google Play package
`de.codext.godmode`. The first release, 0.1.0 (iOS build 1, Android versionCode 2), was built locally. Bump
`ios.buildNumber` and `android.versionCode` in `app.json` for every upload; each store accepts a number only once.

- **iOS**: `bunx expo prebuild --platform ios --clean`, archive the `Godmode` scheme in Release, export for App Store
  Connect with the "Godmode App Store" provisioning profile (Apple Distribution certificate), and upload with
  `xcrun altool --upload-app`.
- **Android**: `bunx expo prebuild --platform android --clean`, add a release `signingConfig` for the upload key (kept
  outside the repo; Google Play App Signing holds the app signing key), then `./gradlew :app:bundleRelease`.
- Store texts, screenshots and the review notes live in the consoles. The support page (`/support`) and the privacy
  policy's phone app section are on the website, which also hosts the reviewers' demo video
  (`/media/phone-app-demo.mp4`).

## Layout

```
src/app/                routes (Expo Router)
  (tabs)/               Home, Chats, Screens, Agents — native tabs, a stack per tab
  chat/[id].tsx         a conversation with streaming replies
  agent/[id].tsx        an agent: tasks, automations, recent chats
  live.tsx              full-screen browser / shared screen / VM, take control
  compose.tsx           new chat (sheet)
  settings.tsx          connection, Face ID lock, disconnect (sheet)
  welcome.tsx scan.tsx pair.tsx   pairing
src/lib/                api (address failover), realtime (WebSocket), session (Keychain), live state, attachments, theme
src/components/         glass, icons (SF Symbols / Material Symbols), rows, markdown, composer, attachments, live views
```
