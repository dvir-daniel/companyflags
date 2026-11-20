/** The mark (three stepped bars: the layers, from the defaults down to one entity) and the name. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5${className ? ` ${className}` : ''}`}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 0h16v4H0zM0 6h11v4H0zM0 12h6v4H0z" fill="currentColor" /></svg>
      <span className="text-[15px] font-semibold tracking-[-0.01em] uppercase">CompanyFlags.</span>
    </span>
  );
}
