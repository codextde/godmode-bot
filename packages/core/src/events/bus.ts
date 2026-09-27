import type { ServerEvent, EntityName } from "@godmode/shared";

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();

/** In-process pub/sub. The WebSocket hub subscribes and fans events out to UIs. */
export const bus = {
  emit(event: ServerEvent) {
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        /* listener errors must never break emitters */
      }
    }
  },
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  changed(entity: EntityName) {
    this.emit({ type: "entity.changed", entity });
  },
};
