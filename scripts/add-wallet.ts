import { PublicKey } from "@solana/web3.js";
import { openDatabase } from "../src/storage/database.js";
import { WalletModel } from "../src/storage/models/wallets.js";

const [address, label = "", source = "manual"] = process.argv.slice(2);
if (!address) {
  throw new Error("Usage: npm run add-wallet -- <address> [label] [source]");
}

new PublicKey(address);
const wallets = new WalletModel(openDatabase());
wallets.upsert({ address, label, source: source as "manual" });
console.log(`Added wallet ${address}`);
