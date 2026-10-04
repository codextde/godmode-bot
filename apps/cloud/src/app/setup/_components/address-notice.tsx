import { Callout } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";

export interface AddressCheck {
  ok: boolean;
  requestOrigin: string;
  publicUrl: string;
  configured: boolean;
  https: boolean;
  /** The configured address is this machine (localhost): fine for trying things out, so no https warning. */
  local: boolean;
}

/**
 * What is wrong with the address this cloud runs at, if anything. A mismatch blocks (sign-in cookies and links only
 * work at the configured address); a guessed or unencrypted address warns.
 */
export function AddressNotice({ check }: { check: AddressCheck }) {
  if (!check.ok) {
    return (
      <Callout
        tone="danger"
        title="This is not the configured address"
        action={
          <Button variant="outline" size="sm" asChild>
            <a href={`${check.publicUrl}/setup`}>Open the configured address</a>
          </Button>
        }
      >
        You opened this site at <span className="font-mono break-all text-foreground">{check.requestOrigin}</span>, but it is configured as{" "}
        <span className="font-mono break-all text-foreground">{check.publicUrl}</span>. Sign-in and links only work at the configured
        address. Open it there, or set <span className="font-mono text-foreground">DOMAIN</span> to the address you want and restart the
        server.
      </Callout>
    );
  }
  if (!check.configured) {
    return (
      <Callout tone="warning" role="note" title="No address is configured">
        This cloud assumes <span className="font-mono break-all text-foreground">{check.publicUrl}</span>, which only works on this machine.
        Set <span className="font-mono text-foreground">DOMAIN</span> (in .env, or the domain field in Coolify) and restart before you
        invite anyone or link a computer.
      </Callout>
    );
  }
  if (!check.https && !check.local) {
    return (
      <Callout tone="warning" role="note" title="This address is not encrypted">
        <span className="font-mono break-all text-foreground">{check.publicUrl}</span> uses http, so sign-in cookies and everything relayed
        travel unencrypted. Put the cloud behind https before real use.
      </Callout>
    );
  }
  return null;
}
