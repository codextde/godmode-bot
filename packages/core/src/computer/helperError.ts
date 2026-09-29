/** Error from a computer helper (macOS binary, Windows PowerShell host or the X11 tools). */
export class HelperError extends Error {
  constructor(
    message: string,
    /** "permission_screen" | "permission_accessibility" | "window_gone" | "display_gone" | "unsupported" | "bad_request" | "failed" | … */
    public code: string,
  ) {
    super(message);
  }
}
