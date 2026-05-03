# Solana Whale Watcher --- Plan d'implementation
## Stochastic Consensus (7 agents, avril 2026)

---

# PARTIE 1 : ANALYSE CONSENSUS / DIVERGENCES / OUTLIERS

---

## CONSENSUS (5+/7 agents concordent)

### 1. Helius Enhanced Webhooks comme pipeline primaire (7/7)
Tous les agents recommandent les webhooks Enhanced de Helius plutot que le polling.
- Push model = quasi-zero credits consommes (budget 1M credits/mois preserve)
- Transaction deja parsee (SWAP, source DEX, tokenTransfers, montants)
- Supporte jusqu'a 100K adresses par webhook
- Polling uniquement en fallback (catch-up apres downtime, backfill)

### 2. TypeScript + Node.js (7/7)
Stack unanime : TypeScript strict, Node.js runtime.
- Libraries cles : `helius-sdk`, `@solana/web3.js`, `better-sqlite3`, `pino`, `express`/`fastify`
- Build : `tsup` ou `tsc`
- Dev : `tsx` pour watch mode

### 3. SQLite comme base de donnees principale (6/7)
- `better-sqlite3` : synchrone, zero infra, crash-safe en WAL mode
- Suffisant pour 500 wallets x 50 trades/jour = 9M lignes/an
- Migration vers Postgres si necessaire (Phase 4+)
- Agent 4 suggere Redis en complement pour Phase 4 (hot cache), pas en remplacement

### 4. Cloudflare Tunnel pour exposer le webhook endpoint (6/7)
- Gratuit, chiffre, pas de port expose
- Alternative : ngrok (mais logs le trafic sur leurs serveurs)
- Le serveur Express bind sur 127.0.0.1, tunnel expose uniquement /api/webhooks

### 5. PM2 pour process management 24/7 (5/7)
- Auto-restart on crash, log rotation, startup hook via launchd
- `caffeinate -dimsu` ou Amphetamine pour empecher le sleep Mac
- Health check : heartbeat Discord toutes les 6h

### 6. Convergence basee sur fenetre temporelle glissante (7/7)
- Fenetre par defaut : 2 heures (configurable)
- Seuil dynamique : `threshold = max(2, floor(log2(total_wallets) + 1))`
- Score composite : nombre de wallets x qualite x taille x decroissance temporelle x liquidite

### 7. Filtres anti-faux-positifs obligatoires (6/7)
- Minimum trade size : $500 / 2 SOL
- Liquidite plancher : $50K
- Age du token : > 24h (configurable)
- Exclusion MEV/bots
- Detection wash trading (buy+sell < 5 min)
- Sybil filter (wallets fondes par meme source)

### 8. Securite : ne jamais exposer la liste de wallets (7/7)
- wallets.json gitignore
- Adresses tronquees dans logs et alertes Discord
- Labels au lieu d'adresses dans les alertes
- API auth token sur tous les endpoints dashboard
- Webhook HMAC verification obligatoire

### 9. Architecture multi-chain preparee des le debut (6/7)
- Interface `ITradeEvent` / `IChainMonitor` abstraite
- Implementation Solana d'abord, ETH/Base ensuite
- Token identifie par cle composite : `{chain}:{address}`
- Le moteur de convergence est chain-agnostic

### 10. Alertes Discord en 3 tiers (6/7)
- CRITICAL (score > 80) : 5+ wallets, gros volume, signal frais --> @everyone
- NOTABLE (score 50-80) : 3-4 wallets --> alerte standard
- WATCH (score 20-50) : 2 wallets --> dashboard only, pas de Discord

---

## DIVERGENCES (3-4/7 en desaccord)

### 1. Framework frontend : Preact vs Svelte vs HTML pur

| Agent | Choix | Argument |
|-------|-------|----------|
| Agent 6 (Frontend) | **Preact + Vite** | 3KB, meme API React, composants necessaires pour dashboard dynamique |
| Agent 3 (Architect) | **Vanilla JS ou Preact** | Minimal, pas de build obligatoire pour le frontend |
| Agent 5 (Security) | Indifferent | Local-only, la securite prime sur le framework |

**Verdict recommande :** Preact + Vite. Le dashboard a assez de complexite dynamique (real-time feed, filtres, CRUD wallets) pour justifier un framework leger. Vanilla JS deviendrait spaghetti.

### 2. Real-time : SSE vs WebSocket vs simple polling frontend

| Agent | Choix | Argument |
|-------|-------|----------|
| Agent 6 | **SSE (Server-Sent Events)** | Unidirectionnel suffit, auto-reconnect natif, zero lib |
| Agent 1 | WebSocket via Helius LaserStream | Plus basse latence (200ms vs 1-2s) |
| Agent 3 | EventEmitter interne + SSE | Backend eventuel, frontend SSE |

**Verdict recommande :** SSE. Le frontend n'a pas besoin d'envoyer au serveur en temps reel. SSE est plus simple, natif, et suffisant.

### 3. Backfill profondeur : 7 jours vs 30 jours

| Agent | Choix | Argument |
|-------|-------|----------|
| Agent 4 (Pipeline) | 7 jours | Economise les credits, suffisant pour demarrer |
| Agent 7 (Practitioner) | 30 jours | Necessaire pour scoring wallet fiable |
| Agent 2 (Quant) | 30 jours minimum | Backtesting requiert historique profond |

**Verdict recommande :** 30 jours pour les wallets seeds, 7 jours pour les ajouts automatiques. Le scoring wallet NECESSITE un historique suffisant.

### 4. Express vs Fastify

| Agent | Choix | Argument |
|-------|-------|----------|
| Agents 3, 5, 6 | **Express** | Ecosysteme mature, plus de middleware |
| Agent 1 | Fastify | Plus performant, schema validation native |

**Verdict recommande :** Fastify. Performance superieure, validation JSON schema integree, meilleur pour une API qui recoit des webhooks a haute frequence.

---

## OUTLIERS (1-2 agents uniquement)

### 1. Behavioral fingerprinting pour detecter la rotation de wallet (Agent 7 seul)
- Idee : identifier un whale meme s'il change d'adresse, via pattern de trading (horaires, taille, DEX prefere)
- **Potentiellement brillant** mais complexe a implementer. Phase 3+.
- Implementation : clustering des patterns de trading, similarity scoring.

### 2. Cross-chain convergence comme "mega signal" (Agent 4 seul)
- Idee : si un whale achete le meme token sur Solana ET sur Base = signal ultra-fort
- **Pertinent** quand le multi-chain sera en place. Reqiert bridge token mapping.
- Phase 4+ minimum.

### 3. Estimation du slippage dans les alertes (Agent 2 seul)
- Idee : montrer le slippage estime a $100, $500, $1000 pour aider la decision
- **Utile** mais necessite integration Jupiter Quote API.
- Phase 2 : ajouter un lien Jupiter avec montant pre-rempli suffit d'abord.

### 4. macOS Keychain pour backup des cles API (Agent 5 seul)
- Idee : `security add-generic-password` pour stocker les cles hors .env
- **Overkill pour un projet local.** Le .env gitignore avec FileVault suffit.

### 5. "Degen mode" configurable pour tokens < 24h (Agent 2 seul)
- Idee : toggle qui desactive le filtre d'age token pour capturer les early plays
- **Dangereux mais realiste.** Les meilleures opportunites sont souvent < 24h.
- Implementer comme flag configurable, desactive par defaut.

---

# PARTIE 2 : PLAN D'IMPLEMENTATION FINAL

---

## Stack technique definitive

| Composant | Choix | Version |
|-----------|-------|---------|
| Runtime | Node.js | >= 20 LTS |
| Langage | TypeScript | 5.x strict |
| Blockchain | Helius SDK + @solana/web3.js | latest |
| Base de donnees | SQLite via better-sqlite3 | latest |
| Serveur HTTP | Fastify | 5.x |
| Frontend | Preact + Vite | Preact 10.x, Vite 6.x |
| Real-time | Server-Sent Events (natif) | - |
| Process manager | PM2 | latest |
| Logging | Pino | latest |
| Tunnel | Cloudflare Tunnel (cloudflared) | latest |
| Alertes | Discord Webhook (fetch natif) | - |
| Config validation | Zod | 3.x |
| Scheduler interne | node-cron | latest |

---

## Architecture (diagramme texte)

```
                    INTERNET
                       |
            [Cloudflare Tunnel]
                       |
                       v
    [Helius Enhanced Webhooks] ----push----> [Fastify Server :3000]
                                                    |
                                    +---------------+---------------+
                                    |               |               |
                              [Webhook Route]  [API Routes]   [SSE /events]
                                    |               |               |
                                    v               v               |
                            [Transaction Parser]  [CRUD]            |
                                    |               |               |
                                    v               v               |
                            [Convergence Engine] <-- query ----+    |
                                    |                               |
                              +-----+------+                        |
                              |            |                        |
                        [Alert Manager] [EventEmitter] ----push---->+
                              |                                     |
                              v                                     v
                     [Discord Webhook]                    [Preact Dashboard]
                                                               |
                              +--------------------------------+
                              |
                              v
                         [SQLite DB]
                     (trades, wallets,
                   convergences, tokens)
```

---

## Structure de fichiers

```
solana-whale-watcher/
|-- package.json
|-- tsconfig.json
|-- .env.example
|-- .env                            # gitignored
|-- .gitignore
|-- ecosystem.config.cjs            # PM2
|-- vite.config.ts                  # Frontend build
|
|-- src/
|   |-- index.ts                    # Bootstrap, start server + jobs
|   |
|   |-- config/
|   |   |-- index.ts                # Zod-validated env config
|   |   |-- thresholds.ts           # Convergence thresholds dynamiques
|   |   +-- wallets.seed.json       # Wallets initiaux (gitignored)
|   |
|   |-- blockchain/
|   |   |-- helius-client.ts        # Helius SDK wrapper
|   |   |-- transaction-parser.ts   # Enhanced TX -> TradeEvent
|   |   |-- token-resolver.ts       # DAS API + LRU cache
|   |   |-- wallet-monitor.ts       # Webhook subscription lifecycle
|   |   +-- types.ts                # ITradeEvent, IChainMonitor
|   |
|   |-- engine/
|   |   |-- convergence.ts          # Detection fenetre glissante + scoring
|   |   |-- scorer.ts               # Wallet scoring (PnL, win rate)
|   |   |-- filters.ts             # Anti-faux-positifs (taille, liquidite, age, sybil)
|   |   +-- alert-manager.ts        # Tiers, throttle, dispatch
|   |
|   |-- storage/
|   |   |-- database.ts             # better-sqlite3 init + WAL
|   |   |-- migrations/
|   |   |   +-- 001_init.sql        # Schema complet
|   |   |-- models/
|   |   |   |-- trades.ts
|   |   |   |-- wallets.ts
|   |   |   |-- convergences.ts
|   |   |   +-- tokens.ts
|   |   +-- cache.ts                # LRU in-memory (token metadata)
|   |
|   |-- alerts/
|   |   |-- discord.ts              # fetch() vers webhook, rate limited
|   |   +-- formatter.ts            # Embed builder, adresses tronquees
|   |
|   |-- api/
|   |   |-- server.ts               # Fastify init, plugins, static serve
|   |   |-- routes/
|   |   |   |-- webhooks.ts         # POST /api/webhooks/helius (HMAC)
|   |   |   |-- wallets.ts          # CRUD wallets
|   |   |   |-- convergences.ts     # Query convergences
|   |   |   |-- events.ts           # GET /api/events (SSE)
|   |   |   +-- health.ts           # GET /api/health
|   |   +-- middleware/
|   |       |-- auth.ts             # API_AUTH_TOKEN check
|   |       +-- hmac.ts             # Webhook signature verification
|   |
|   |-- frontend/                   # Preact SPA
|   |   |-- index.html
|   |   |-- main.tsx
|   |   |-- app.tsx
|   |   |-- pages/
|   |   |   |-- Dashboard.tsx       # Live convergences + trade feed
|   |   |   |-- History.tsx         # Convergence history + outcomes
|   |   |   |-- Wallets.tsx         # Wallet CRUD + scores
|   |   |   +-- Settings.tsx        # Config, blacklist, health
|   |   |-- components/
|   |   |   |-- ConvergenceCard.tsx
|   |   |   |-- TradeFeed.tsx
|   |   |   |-- WalletTable.tsx
|   |   |   |-- StatusBadge.tsx
|   |   |   +-- Layout.tsx
|   |   |-- hooks/
|   |   |   +-- useSSE.ts           # EventSource hook
|   |   +-- styles/
|   |       +-- global.css          # Dark theme, Tailwind play CDN
|   |
|   |-- jobs/
|   |   |-- wallet-scorer.ts        # Cron : scoring hebdomadaire
|   |   |-- price-tracker.ts        # Cron : prix post-signal (1h, 24h)
|   |   |-- catchup.ts             # Au redemarrage : rattraper les trades manques
|   |   +-- cleanup.ts             # Cron : archivage, pruning
|   |
|   +-- utils/
|       |-- logger.ts               # Pino, sanitized
|       |-- retry.ts                # Exponential backoff
|       +-- helpers.ts              # Truncate address, format USD, etc.
|
|-- scripts/
|   |-- add-wallet.ts               # CLI tool
|   |-- backfill.ts                 # Backfill historique
|   +-- setup-webhooks.ts           # Init Helius webhooks
|
+-- tests/
    |-- engine/
    |   +-- convergence.test.ts
    +-- blockchain/
        +-- parser.test.ts
```

---

## Schema SQLite complet (001_init.sql)

```sql
-- Trades individuels detectes
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  tx_signature TEXT UNIQUE NOT NULL,
  amount_token REAL,
  amount_sol REAL,
  amount_usd REAL,
  dex_source TEXT,
  trade_type TEXT CHECK(trade_type IN ('BUY','SELL')) NOT NULL,
  block_time INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_trades_token_time ON trades(token_mint, block_time);
CREATE INDEX idx_trades_wallet_time ON trades(wallet_address, block_time);
CREATE INDEX idx_trades_type_time ON trades(trade_type, block_time);

-- Wallets suivis
CREATE TABLE wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  source TEXT CHECK(source IN ('manual','axiom','nansen','dune','discovered','co-buyer')),
  score REAL DEFAULT 50.0,
  state TEXT CHECK(state IN ('NEW','PROBATION','ACTIVE','DORMANT','DEMOTED','PRUNED','ARCHIVED')) DEFAULT 'NEW',
  win_rate REAL,
  avg_roi REAL,
  total_trades INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  added_at INTEGER DEFAULT (unixepoch()),
  last_trade_at INTEGER,
  last_scored_at INTEGER
);

-- Evenements de convergence
CREATE TABLE convergences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint TEXT NOT NULL,
  token_symbol TEXT,
  score REAL NOT NULL,
  tier TEXT CHECK(tier IN ('CRITICAL','NOTABLE','WATCH')) NOT NULL,
  wallet_count INTEGER NOT NULL,
  total_usd REAL,
  first_trade_at INTEGER NOT NULL,
  last_trade_at INTEGER NOT NULL,
  window_minutes INTEGER,
  alerted_at INTEGER,
  price_at_detection REAL,
  price_1h REAL,
  price_24h REAL,
  price_7d REAL,
  outcome TEXT, -- 'WIN', 'LOSS', 'PENDING'
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_conv_token ON convergences(token_mint);
CREATE INDEX idx_conv_tier ON convergences(tier, created_at);

-- Junction convergence <-> trades
CREATE TABLE convergence_trades (
  convergence_id INTEGER REFERENCES convergences(id),
  trade_id INTEGER REFERENCES trades(id),
  PRIMARY KEY (convergence_id, trade_id)
);

-- Cache metadata token
CREATE TABLE tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  decimals INTEGER,
  image_url TEXT,
  liquidity_usd REAL,
  is_verified INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Snapshots de prix pour backtesting
CREATE TABLE price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint TEXT NOT NULL,
  price_usd REAL NOT NULL,
  liquidity_usd REAL,
  source TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX idx_price_token_time ON price_snapshots(token_mint, timestamp);

-- Blacklist tokens (stablecoins, wrapped SOL, etc.)
CREATE TABLE token_blacklist (
  mint TEXT PRIMARY KEY,
  reason TEXT,
  added_at INTEGER DEFAULT (unixepoch())
);

-- Blacklist wallets (MEV bots, exchanges)
CREATE TABLE wallet_blacklist (
  address TEXT PRIMARY KEY,
  reason TEXT,
  added_at INTEGER DEFAULT (unixepoch())
);
```

---

## Algorithme de convergence (pseudo-code)

```typescript
// Declenche a chaque nouveau trade ingere
function checkConvergence(newTrade: TradeEvent): Convergence | null {
  const WINDOW_MS = config.convergenceWindowMinutes * 60 * 1000;
  const threshold = getThreshold(countActiveWallets());
  
  // 1. Chercher tous les BUY du meme token dans la fenetre
  const recentBuys = db.trades.findByTokenInWindow(
    newTrade.tokenMint,
    Date.now() - WINDOW_MS,
    'BUY'
  );
  
  // 2. Compter les wallets distincts
  const uniqueWallets = new Set(recentBuys.map(t => t.walletAddress));
  if (uniqueWallets.size < threshold) return null;
  
  // 3. Appliquer les filtres anti-faux-positifs
  if (!passesFilters(newTrade.tokenMint, recentBuys)) return null;
  
  // 4. Calculer le score
  const score = computeConvergenceScore({
    walletCount: uniqueWallets.size,
    walletScores: getWalletScores([...uniqueWallets]),
    totalUsd: sum(recentBuys.map(t => t.amountUsd)),
    hoursSinceFirst: (Date.now() - min(recentBuys.map(t => t.blockTime))) / 3600000,
    tokenLiquidity: getTokenLiquidity(newTrade.tokenMint)
  });
  
  // 5. Determiner le tier
  const tier = score > 80 ? 'CRITICAL' : score > 50 ? 'NOTABLE' : 'WATCH';
  
  // 6. Dedup : ne pas re-alerter si meme token + meme tier dans les 30 min
  if (wasRecentlyAlerted(newTrade.tokenMint, tier, 30)) return null;
  
  // 7. Creer et persister la convergence
  return db.convergences.create({ ... });
}

function getThreshold(totalWallets: number): number {
  return Math.max(2, Math.floor(Math.log2(totalWallets) + 1));
}

function passesFilters(tokenMint: string, buys: Trade[]): boolean {
  // Taille minimum
  if (buys.every(b => b.amountUsd < 500)) return false;
  // Liquidite
  const liquidity = getTokenLiquidity(tokenMint);
  if (liquidity < 50000) return false;
  // Age du token
  if (getTokenAge(tokenMint) < 24 * 3600 && !config.degenMode) return false;
  // Blacklist
  if (isBlacklisted(tokenMint)) return false;
  // Wash trading
  if (hasWashTrading(tokenMint, buys)) return false;
  return true;
}
```

---

## Seuil dynamique (formule)

```
total_wallets  |  threshold  |  ratio
-------------- | ----------- | ------
3              |  2          |  66%
5              |  3          |  60%
10             |  4          |  40%
20             |  5          |  25%
50             |  6          |  12%
100            |  7          |  7%
200            |  8          |  4%
500            |  10         |  2%
```

---

## Phases d'implementation

### PHASE 0 -- Setup (1 jour)
- [ ] `npm init`, tsconfig, .env, .gitignore
- [ ] Installer : helius-sdk, better-sqlite3, fastify, pino, zod, tsx
- [ ] Creer le schema SQLite (001_init.sql)
- [ ] Config Zod-validated depuis .env
- [ ] Logger Pino configure (sanitized)
- [ ] Health check endpoint
- [ ] PM2 ecosystem.config.cjs
- [ ] `brew install cloudflared` + tunnel create

### PHASE 1 -- MVP Pipeline (3-4 jours)
**Objectif : 3 wallets, detection basique, alerte Discord**
- [ ] Helius client : register enhanced webhook pour 3 wallets
- [ ] Webhook receiver : POST /api/webhooks/helius avec HMAC verification
- [ ] Transaction parser : Enhanced TX -> TradeEvent (BUY/SELL, token, amount)
- [ ] Token resolver : DAS API + LRU cache (10K entries)
- [ ] Storage : INSERT trades dans SQLite
- [ ] Convergence engine V1 : fenetre 2h, threshold = 2, pas de scoring
- [ ] Discord alerter : embed simple avec token, wallets, lien Birdeye/Jupiter
- [ ] Test end-to-end : ajouter 3 wallets de Torin, verifier les alertes

**Critere de succes :** Quand 2 des 3 wallets achetent le meme token dans les 2h, une alerte Discord arrive.

### PHASE 2 -- Scoring + Dashboard (4-5 jours)
**Objectif : scoring, filtres, dashboard basique**
- [ ] Filtres anti-faux-positifs (taille, liquidite, age, MEV, wash trading)
- [ ] Convergence scoring composite (formule du quant)
- [ ] Alert tiers (CRITICAL/NOTABLE/WATCH) avec formatage different
- [ ] Wallet scoring initial (backfill 30 jours pour les 3 wallets seed)
- [ ] Price tracker job : capturer prix a 1h, 24h post-signal
- [ ] Frontend Preact + Vite : dashboard live, trade feed, SSE
- [ ] Pages : Dashboard, History, Wallets (CRUD), Settings
- [ ] Dark theme crypto (bg #0f0f14, accent #00ff88)

**Critere de succes :** Dashboard affiche les convergences en temps reel. Alertes Discord montrent le tier et le score.

### PHASE 3 -- Scale (3-4 jours)
**Objectif : 20-100 wallets, wallet discovery, robustesse**
- [ ] Wallet discovery V1 : import depuis Axiom/Nansen (manuel, CSV)
- [ ] Wallet lifecycle : NEW -> PROBATION -> ACTIVE -> DORMANT -> PRUNED
- [ ] Scoring hebdomadaire automatise (node-cron dimanche minuit)
- [ ] Co-buyer detection : quand un wallet inconnu achete en meme temps qu'un whale connu, le flaguer
- [ ] Backfill optimise : 7 jours pour ajouts auto, 30 jours pour ajouts manuels
- [ ] Catchup job au redemarrage (rattraper les trades manques pendant downtime)
- [ ] Seuil dynamique (log2 formula)
- [ ] Data retention : archivage trades > 90 jours
- [ ] Monitoring pipeline : alerte si 0 webhooks recus en 15 min

**Critere de succes :** 50+ wallets actifs, scoring fonctionnel, decouverte automatique de co-buyers.

### PHASE 4 -- Polish + Multi-chain prep (2-3 jours)
**Objectif : robustesse production, preparation multi-chain**
- [ ] Interface IChainMonitor / ITradeEvent abstraite
- [ ] Abstraction du token identifier : `{chain}:{address}`
- [ ] Mobile-responsive dashboard
- [ ] Export CSV des convergences
- [ ] Backtesting view : win rate des alertes CRITICAL
- [ ] Signal-to-noise dashboard metric
- [ ] Considerer upgrade Helius Developer ($49/mois) si 200+ wallets

### PHASE 5 -- Multi-chain (futur)
- [ ] ETH : Alchemy webhooks, meme pattern
- [ ] Base : idem
- [ ] Cross-chain convergence detection
- [ ] Behavioral fingerprinting pour rotation de wallet

---

## Estimation temporelle

| Phase | Duree | Cumulatif |
|-------|-------|-----------|
| Phase 0 : Setup | 1 jour | 1 jour |
| Phase 1 : MVP | 3-4 jours | 4-5 jours |
| Phase 2 : Scoring + Dashboard | 4-5 jours | 8-10 jours |
| Phase 3 : Scale | 3-4 jours | 11-14 jours |
| Phase 4 : Polish | 2-3 jours | 13-17 jours |
| Phase 5 : Multi-chain | TBD | - |

**MVP fonctionnel (Phase 0+1) : ~5 jours de travail.**
**Produit complet Solana (Phase 0-3) : ~14 jours de travail.**

---

## Variables .env requises

```bash
# Helius
HELIUS_API_KEY=your_helius_api_key
HELIUS_WEBHOOK_SECRET=your_webhook_hmac_secret

# Discord
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/xxx
DISCORD_WEBHOOK_URL_CRITICAL=https://discord.com/api/webhooks/xxx/xxx  # optionnel, channel separe

# Server
PORT=3000
HOST=127.0.0.1
API_AUTH_TOKEN=random_64_char_string

# Convergence
CONVERGENCE_WINDOW_MINUTES=120
MIN_TRADE_USD=500
MIN_LIQUIDITY_USD=50000
MIN_TOKEN_AGE_HOURS=24
DEGEN_MODE=false

# Tunnel
TUNNEL_HOSTNAME=whale-watcher.yourdomain.com
```

---

## Commandes de demarrage

```bash
# Installation
npm install

# Dev
npx tsx watch src/index.ts

# Setup webhooks (une seule fois)
npx tsx scripts/setup-webhooks.ts

# Backfill wallets initiaux
npx tsx scripts/backfill.ts

# Production
npm run build
pm2 start ecosystem.config.cjs

# Tunnel (terminal separe ou PM2)
cloudflared tunnel run whale-watcher
```

---

## API Endpoints

| Methode | Route | Auth | Description |
|---------|-------|------|-------------|
| POST | /api/webhooks/helius | HMAC | Reception webhooks Helius |
| GET | /api/events | Token | SSE stream temps reel |
| GET | /api/convergences | Token | Liste convergences (filtres) |
| GET | /api/convergences/:id | Token | Detail convergence + trades |
| GET | /api/trades | Token | Trades recents |
| GET | /api/wallets | Token | Liste wallets + scores |
| POST | /api/wallets | Token | Ajouter wallet |
| PUT | /api/wallets/:address | Token | Modifier wallet |
| DELETE | /api/wallets/:address | Token | Supprimer wallet |
| GET | /api/stats | Token | Statistiques globales |
| GET | /api/health | - | Health check public |
| GET | /api/config | Token | Config actuelle |
| PUT | /api/config | Token | Modifier config |

---

## Strategie de decouverte de wallets (par phase)

### Phase 1 : 3-5 wallets seed
- 3 wallets de la video Torin
- 2 du top Axiom Pro (PnL > $100K, win rate > 60%, actif 7 derniers jours)
- Verification manuelle : 30 jours de trades sur Solscan

### Phase 2 : 10-20 wallets curates
- 2 heures sur Axiom, Nansen, Dune Analytics
- Chaque wallet verifie individuellement
- Label avec source de decouverte

### Phase 3 : 50-100 wallets (mix manuel + auto)
- Early buyer analysis : pour chaque token qui a fait 5x+ en 30 jours, trouver les wallets qui ont achete dans les 2 premieres heures
- Co-buyer detection : wallets inconnus qui achetent en meme temps que nos whales connus (3+ co-occurrences)
- Tous les nouveaux wallets demarrent en PROBATION (7 jours)

### Phase 4 : 100-500 wallets (auto-discovery)
- Funding trail : surveiller les transferts SOL depuis les top wallets vers de nouvelles adresses
- Rafraichissement mensuel depuis leaderboards
- Pruning automatique : score < 20 pendant 30 jours = PRUNED
- Objectif : 100-200 wallets ACTIVE a tout moment

---

## Alertes Discord -- Format

### CRITICAL
```
@everyone
------------------------------------
CONVERGENCE CRITICAL
Token: $EXAMPLE (exam1...xyz9)
Score: 87/100
Wallets: 5 tracked wallets buying
Volume: $15K-$25K total
Fenetre: 35 minutes
Liquidite: $180K

Links:
- Birdeye: https://birdeye.so/token/...
- Jupiter: https://jup.ag/swap/SOL-...
- DEXScreener: https://dexscreener.com/solana/...

Signal age: 12 minutes
------------------------------------
```

### NOTABLE
```
CONVERGENCE NOTABLE
Token: $EXAMPLE (exam1...xyz9)
Score: 62/100
Wallets: 3 tracked wallets
Volume: $5K-$10K
Fenetre: 1h15

[Birdeye] [Jupiter] [DEXScreener]
```

### WATCH (dashboard only, pas de Discord)

---

## Risques identifies

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Helius free tier insuffisant a 200+ wallets | Credits epuises mi-mois | Monitoring credits, upgrade $49/mois si besoin |
| Webhooks non livres pendant downtime | Trades manques, faux negatifs | Catchup job au redemarrage |
| Mac entre en veille | Service arrete | caffeinate + parametres energie |
| Wallet list leak | Alpha perdu | Gitignore, auth, truncation |
| Faux positifs excessifs | Alert fatigue | Filtres stricts, backtesting, pruning |
| Helius change son API | Service casse | Pin SDK version, tester apres updates |
| SQLite performance a 10M+ rows | Ralentissement | Index optimises, archivage 90j, migration Postgres si necessaire |
