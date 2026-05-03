import { TradeFeed } from "../components/TradeFeed.js";

export function Dashboard() {
  return (
    <section class="grid">
      <div class="panel">
        <h2>Convergences</h2>
        <p>Phase 1 Discord alerts are active when two tracked wallets buy the same token within two hours.</p>
      </div>
      <TradeFeed />
    </section>
  );
}
