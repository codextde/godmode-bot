import { SymbolView, type AndroidSymbol, type SFSymbol, type SymbolWeight } from "expo-symbols";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";

/** One name per meaning: SF Symbols on iOS, Material Symbols on Android. */
const ICONS = {
  home: ["house.fill", "home"],
  chats: ["bubble.left.and.bubble.right.fill", "forum"],
  screens: ["macwindow.on.rectangle", "desktop_windows"],
  agents: ["person.2.fill", "group"],
  settings: ["gearshape.fill", "settings"],
  send: ["arrow.up", "arrow_upward"],
  stop: ["stop.fill", "stop"],
  close: ["xmark", "close"],
  scan: ["qrcode.viewfinder", "qr_code_scanner"],
  check: ["checkmark", "check"],
  globe: ["globe", "language"],
  display: ["display", "computer"],
  vm: ["shippingbox.fill", "deployed_code"],
  play: ["play.fill", "play_arrow"],
  pause: ["pause.fill", "pause"],
  power: ["power", "power_settings_new"],
  hand: ["hand.tap.fill", "touch_app"],
  keyboard: ["keyboard", "keyboard"],
  refresh: ["arrow.clockwise", "refresh"],
  bolt: ["bolt.fill", "bolt"],
  lock: ["lock.fill", "lock"],
  warning: ["exclamationmark.triangle.fill", "warning"],
  chevron: ["chevron.right", "chevron_right"],
  more: ["ellipsis", "more_horiz"],
  trash: ["trash", "delete"],
  faceid: ["faceid", "face"],
  network: ["point.3.connected.trianglepath.dotted", "lan"],
  clock: ["clock", "schedule"],
  search: ["magnifyingglass", "search"],
  plus: ["plus", "add"],
  compose: ["square.and.pencil", "edit_square"],
  link: ["link", "link"],
  camera: ["camera.fill", "photo_camera"],
  back: ["chevron.backward", "arrow_back"],
  doc: ["doc.text", "description"],
  terminal: ["apple.terminal", "terminal"],
  pencil: ["pencil", "edit"],
  list: ["checklist", "list"],
  bell: ["bell.fill", "notifications"],
  key: ["key.fill", "key"],
  cursor: ["cursorarrow.click", "mouse"],
  scroll: ["arrow.up.and.down", "swipe_vertical"],
  expand: ["arrow.up.left.and.arrow.down.right", "fullscreen"],
  eye: ["eye.fill", "visibility"],
  logout: ["rectangle.portrait.and.arrow.right", "logout"],
  copy: ["doc.on.doc", "content_copy"],
  sparkles: ["sparkles", "smart_toy"],
  down: ["chevron.down", "expand_more"],
  wifi: ["wifi.slash", "wifi_off"],
  pin: ["pin.fill", "push_pin"],
  phone: ["iphone", "smartphone"],
} as const satisfies Record<string, readonly [SFSymbol, AndroidSymbol]>;

export type IconName = keyof typeof ICONS;

export function sfSymbol(name: IconName): SFSymbol {
  return ICONS[name][0];
}

export function Icon({
  name,
  size = 20,
  color,
  weight = "medium",
  style,
}: {
  name: IconName;
  size?: number;
  color: ColorValue;
  weight?: SymbolWeight;
  style?: StyleProp<ViewStyle>;
}) {
  const [ios, android] = ICONS[name];
  return <SymbolView name={{ ios, android }} size={size} tintColor={color} weight={weight} style={[{ width: size, height: size }, style]} />;
}
