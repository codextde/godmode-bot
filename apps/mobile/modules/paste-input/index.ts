import { requireOptionalNativeModule, type NativeModule } from "expo";

export interface PastedFile {
  uri: string;
  name: string;
  mime: string;
  size: number;
}

type Events = { onPaste: (event: { files: PastedFile[] }) => void };

declare class PasteInputModule extends NativeModule<Events> {
  setActive(active: boolean): void;
}

const native = requireOptionalNativeModule<PasteInputModule>("PasteInput");

export function setPasteActive(active: boolean) {
  native?.setActive(active);
}

export function addPasteListener(listener: (files: PastedFile[]) => void) {
  const sub = native?.addListener("onPaste", (e) => listener(e.files));
  return () => sub?.remove();
}
