import { CopyField } from "@/components/copy-button";
import { Callout } from "@/components/settings-kit";
import type { InviteLink } from "../actions";

/**
 * The links of invitations that were just created or resent. They can only be shown now (the cloud keeps a hash), and
 * when no e-mail went out they are the only way the person gets in.
 */
export function InviteLinks({ links }: { links: InviteLink[] }) {
  const notMailed = links.filter((l) => !l.emailed).length;
  return (
    <div className="flex flex-col gap-4">
      {notMailed > 0 && (
        <Callout tone="warning" title={notMailed === links.length ? "No e-mail was sent" : `${notMailed} of ${links.length} e-mails were not sent`}>
          Copy {links.length === 1 ? "the link" : "the links"} below and send {links.length === 1 ? "it" : "them"} yourself. E-mail delivery is not
          set up or failed; the link is also in the server log.
        </Callout>
      )}
      <ul className="flex flex-col gap-3">
        {links.map((link) => (
          <li key={link.email} className="space-y-1.5">
            <p className="flex flex-wrap items-center justify-between gap-x-3 text-sm">
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{link.email}</span>
              <span className="text-xs text-muted-foreground">{link.emailed ? "E-mail sent" : "Not e-mailed"}</span>
            </p>
            <CopyField value={link.url} label={`Copy invite link for ${link.email}`} />
          </li>
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Each link works once and is shown only now. Resend an invitation to get a new link.
      </p>
    </div>
  );
}
