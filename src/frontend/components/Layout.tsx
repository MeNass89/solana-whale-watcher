import type { ComponentChildren } from "preact";

export function Layout({ children }: { children: ComponentChildren }) {
  return (
    <main class="shell">
      <header class="topbar">
        <h1>Solana Whale Watcher</h1>
        <span class="status">MVP Pipeline</span>
      </header>
      {children}
    </main>
  );
}
