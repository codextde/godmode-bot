import { useLocalSearchParams } from "expo-router";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from "react";
import { Dimensions, ScrollView, StyleSheet, View, type ScrollViewInstance, type ScrollViewProps } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useColors } from "@/lib/theme";

type ViewInstance = ComponentRef<typeof View>;

/** After the screen's way in: rows measured earlier are still moving. */
const SETTLE_MS = 380;
const LIT_MS = 1500;

/** Lower case without accents, so "Gedachtnis" finds "Gedächtnis". */
export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

type Focus = {
  term: string;
  scroll: RefObject<ScrollViewInstance | null>;
  /** True for the first row that asks: two rows can carry the same title. */
  claim: () => boolean;
};

const RowFocus = createContext<Focus | null>(null);

/** A settings screen's ScrollView: opened from the settings search (`focus`, a row's title), it brings that row into view. */
export function SettingsScroll(props: ScrollViewProps) {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const scroll = useRef<ScrollViewInstance>(null);
  const found = useRef(false);
  const value = useMemo(() => {
    if (!focus) return null;
    const claim = () => {
      if (found.current) return false;
      found.current = true;
      return true;
    };
    return { term: norm(focus), scroll, claim };
  }, [focus]);
  return (
    <RowFocus.Provider value={value}>
      <ScrollView ref={scroll} {...props} />
    </RowFocus.Provider>
  );
}

/** The search's term, to compare a row's title with; null on a screen not opened for a row. */
export function useFocusTerm(): string | null {
  return useContext(RowFocus)?.term ?? null;
}

/** The row of a Group the search led to: scrolled to once and lit for a moment. */
export function FocusRow({ children }: { children: ReactNode }) {
  const c = useColors();
  const focus = useContext(RowFocus);
  const view = useRef<ViewInstance>(null);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!focus?.claim()) return;
    let off: ReturnType<typeof setTimeout>;
    const start = setTimeout(() => {
      const list = focus.scroll.current;
      const inner = list?.getInnerViewRef();
      if (inner) {
        view.current?.measureLayout(
          inner,
          (_x: number, y: number) => {
            // The header takes the top of the screen, the search field its bottom: only a row below the fold moves.
            const { height } = Dimensions.get("window");
            if (y > height * 0.55) list?.scrollTo({ y: y - height * 0.35, animated: true });
          },
          () => undefined,
        );
      }
      setLit(true);
      off = setTimeout(() => setLit(false), LIT_MS);
    }, SETTLE_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(off);
    };
  }, [focus]);
  return (
    <View ref={view}>
      {children}
      {lit ? <Animated.View pointerEvents="none" entering={FadeIn.duration(160)} exiting={FadeOut.duration(500)} style={[StyleSheet.absoluteFill, { backgroundColor: c.brandSoft }]} /> : null}
    </View>
  );
}
