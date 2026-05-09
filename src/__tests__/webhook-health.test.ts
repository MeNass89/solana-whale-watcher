import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkWebhookHealth } from "../jobs/webhook-health.js";

const mockGetWebhook = vi.fn();
const mockUpdateWebhook = vi.fn();
const mockDiscordSend = vi.fn();

const helius = { getWebhook: mockGetWebhook, updateWebhook: mockUpdateWebhook } as any;
const discord = { send: mockDiscordSend } as any;
const wallets = { listActive: () => [{ address: "addr1" }] } as any;

describe("checkWebhookHealth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when webhook is active", async () => {
    mockGetWebhook.mockResolvedValue({ webhookID: "wh1", webhookURL: "https://example.com/api/webhooks/helius", accountAddresses: ["addr1"], webhookType: "enhanced" });
    await checkWebhookHealth(helius, "wh1", "https://example.com/api/webhooks/helius", discord, wallets);
    expect(mockUpdateWebhook).not.toHaveBeenCalled();
    expect(mockDiscordSend).not.toHaveBeenCalled();
  });

  it("re-enables webhook when getWebhook returns null", async () => {
    mockGetWebhook.mockResolvedValue(null);
    await checkWebhookHealth(helius, "wh1", "https://example.com/api/webhooks/helius", discord, wallets);
    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", expect.any(Array), "https://example.com/api/webhooks/helius");
  });

  it("refuses to heal with empty wallet list and alerts CRITICAL", async () => {
    mockGetWebhook.mockResolvedValue(null);
    const emptyWallets = { listActive: () => [] } as any;
    await checkWebhookHealth(helius, "wh1", "https://example.com/api/webhooks/helius", discord, emptyWallets);
    expect(mockUpdateWebhook).not.toHaveBeenCalled();
    expect(mockDiscordSend).toHaveBeenCalled();
  });
});
