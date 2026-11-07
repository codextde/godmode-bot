import { useEffect, useRef } from "react";
import { TextInput, type TextInputInstance, type TextInputProps } from "react-native";

const android = process.env.EXPO_OS === "android";
/** Until the dialog's window can take the keyboard. */
const FOCUS_DELAY_MS = 250;

/**
 * The text field of a Modal, typed in at once. `autoFocus` runs before an Android dialog's window has focus, so the
 * keyboard stays away: there it focuses itself a moment later.
 */
export function ModalTextInput(props: TextInputProps) {
  const field = useRef<TextInputInstance>(null);
  useEffect(() => {
    if (!android) return;
    const timer = setTimeout(() => field.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return <TextInput ref={field} autoFocus={!android} {...props} />;
}
