export function GlowBeam({ full = false }: { full?: boolean }) {
  return (
    <span aria-hidden className="gm-beam" data-full={full ? "" : undefined}>
      <i />
    </span>
  );
}
