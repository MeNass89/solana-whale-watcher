export function ConvergenceCard({ convergence }: { convergence: Record<string, unknown> }) {
  return (
    <article class="card">
      <div class="card-title">{String(convergence.token_symbol ?? convergence.token_mint ?? "Unknown token")}</div>
      <div class="metric">{String(convergence.tier ?? "WATCH")}</div>
    </article>
  );
}
