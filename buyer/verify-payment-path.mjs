#!/usr/bin/env node
/**
 * Verify the payment path end to end WITHOUT spending anything.
 *
 * Signs a real EIP-3009 transferWithAuthorization with a brand-new unfunded
 * wallet and asks the facilitator to verify it. Because the facilitator
 * simulates the transfer against the live USDC contract, the rejection reason
 * tells you exactly how far the path got:
 *
 *   invalid_exact_evm_insufficient_balance -> the plumbing is correct; the
 *       wallet simply has no USDC. The first funded payment will succeed.
 *   anything about format, scheme, network, or signature -> a real defect.
 *
 * Usage:
 *   node verify-payment-path.mjs [endpoint] [facilitator]
 *
 * Last run: 2026-09-21 against the live mainnet deployment ->
 *   isValid:false, invalidReason:"invalid_exact_evm_insufficient_balance",
 *   simulated against USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402HTTPClient } from "@x402/core/http";

const ENDPOINT = process.argv[2] ?? "https://agent-evidence-api.taher-h-alhaddad.workers.dev/v1/evidence";
const FACILITATOR = process.argv[3] ?? "https://facilitator.payai.network";

const key = "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: base, transport: http() });
console.log("  wallet (unfunded):", account.address);

const challenge = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ question: "payment path probe", urls: ["https://example.com"] }),
});
console.log("  challenge status :", challenge.status);
const hdr = challenge.headers.get("payment-required");
if (!hdr) {
  console.error("  FAIL: endpoint returned", challenge.status, "without PAYMENT-REQUIRED");
  process.exit(1);
}
const paymentRequired = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
const requirements = paymentRequired.accepts[0];
console.log(
  `  requirements     : ${requirements.scheme} ${requirements.network} ${requirements.amount} -> ${requirements.payTo}`,
);

const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client().register(requirements.network, new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(client);
const payload = await httpClient.createPaymentPayload(paymentRequired);
console.log("  payload signed   : yes");

const fc = new HTTPFacilitatorClient({ url: FACILITATOR });
let verdict;
try {
  verdict = await fc.verify(payload, requirements);
} catch (e) {
  console.error("  FACILITATOR THREW:", String(e.message).slice(0, 400));
  process.exit(1);
}

console.log("  facilitator      :", JSON.stringify(verdict).slice(0, 400));

const reason = verdict?.invalidReason ?? "";
if (reason.includes("insufficient_balance")) {
  console.log("\n  ✓ PATH VERIFIED. The facilitator simulated the transfer against the real");
  console.log("    USDC contract and rejected it only for an empty wallet. A funded");
  console.log("    payment will settle.\n");
  process.exit(0);
}
if (verdict?.isValid) {
  console.log("\n  ✓ valid\n");
  process.exit(0);
}
console.error(`\n  ✗ PATH PROBLEM: rejected for "${reason}", which is not a balance issue.\n`);
process.exit(1);
