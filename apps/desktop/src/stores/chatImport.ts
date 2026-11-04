import { create } from "zustand";

export const useChatImport = create<{ open: boolean; data: string | null; name: string | null }>(() => ({ open: false, data: null, name: null }));

export function openChatImport(input: { data?: string; name?: string } = {}) {
  useChatImport.setState({ open: true, data: input.data ?? null, name: input.name ?? null });
}

export function closeChatImport() {
  useChatImport.setState({ open: false, data: null, name: null });
}

export const CHAT_FILE_EXT = ".godmode-chat";

export function isChatFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(CHAT_FILE_EXT);
}

export function readChatFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
