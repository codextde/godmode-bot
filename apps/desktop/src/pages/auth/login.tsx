export function LoginPage({ hasPassword }: { hasPassword: boolean }) {
  return <div className="p-8">Login {hasPassword ? "(password)" : "(token)"}</div>;
}
