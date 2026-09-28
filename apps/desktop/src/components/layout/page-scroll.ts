import { createContext, useContext } from "react";

/** The app shell's scrolling viewport, for pages that virtualize long lists against the page scroll. */
export const PageScrollContext = createContext<HTMLElement | null>(null);

export const usePageScroll = () => useContext(PageScrollContext);
