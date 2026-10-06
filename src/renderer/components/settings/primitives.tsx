/** Shared Settings panel heading. */
export function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm text-[--text-muted]">{subtitle}</div>
    </div>
  );
}

/** Shared Settings label + hint + control stack. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {hint && <div className="text-xs text-[--text-muted]">{hint}</div>}
      {children}
    </div>
  );
}
