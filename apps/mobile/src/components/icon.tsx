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
  attach: ["paperclip", "attach_file"],
  photo: ["photo", "image"],
  film: ["film", "movie"],
  archiveFile: ["doc.zipper", "folder_zip"],
  table: ["tablecells", "table"],
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
  up: ["chevron.up", "expand_less"],
  wifi: ["wifi.slash", "wifi_off"],
  pin: ["pin.fill", "push_pin"],
  phone: ["iphone", "smartphone"],
  layers: ["square.stack.3d.up.fill", "layers"],
  tasks: ["checklist", "checklist"],
  branch: ["arrow.triangle.branch", "merge"],
  external: ["arrow.up.right", "open_in_new"],
  archive: ["archivebox", "archive"],
  unarchive: ["arrow.uturn.backward", "unarchive"],
  workflow: ["flowchart", "account_tree"],
  brain: ["brain.head.profile", "psychology"],
  wrench: ["wrench.and.screwdriver", "build"],
  folder: ["folder.fill", "folder"],
  dollar: ["dollarsign.circle", "paid"],
  gauge: ["gauge.with.dots.needle.67percent", "speed"],
  pulse: ["waveform.path.ecg", "monitor_heart"],
  person: ["person.crop.circle", "account_circle"],
  text: ["text.alignleft", "notes"],
  cpu: ["cpu", "memory"],
  moon: ["moon.stars", "bedtime"],
  shield: ["checkmark.shield", "verified_user"],
  minus: ["minus", "remove"],
  slider: ["slider.horizontal.3", "tune"],
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
