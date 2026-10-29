// `pnpm tunnel`: exposes the running gateway through a Cloudflare quick tunnel and points the Meta app's
// WhatsApp webhook at it. Quick-tunnel URLs change on every start, so the webhook is re-registered each time.
// Needs the gateway running (Meta calls the verification handshake during registration), WHATSAPP_APP_ID and
// WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN in .env, and cloudflared at var/bin/cloudflared.exe or on PATH.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, workspaceRoot } from "../packages/core/src/index.ts";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

async function main(): Promise<void> {
  const config = loadConfig();
  const { appSecret, verifyToken, graphVersion } = config.whatsapp;
  const appId = process.env.WHATSAPP_APP_ID;
  if (!appId || !appSecret || !verifyToken) {
    throw new Error("Set WHATSAPP_APP_ID, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN in .env");
  }
  const local = `http://127.0.0.1:${config.ports.gateway}`;
  const health = await fetch(`${local}/__health`).catch(() => null);
  if (!health?.ok)
    throw new Error(`No gateway at ${local}. Start it first (pnpm dev with WHATSAPP_MODE=cloud).`);
  // Only a cloud-mode gateway may be published: an emulator-mode one verifies webhooks with a public default
  // secret and serves the dev chat.
  const modes = ((await health.json()) as { modes?: { whatsapp?: string } }).modes;
  if (modes?.whatsapp !== "cloud") {
    throw new Error(
      `The gateway at ${local} runs WhatsApp in ${modes?.whatsapp ?? "an unknown"} mode; tunnel only WHATSAPP_MODE=cloud.`,
    );
  }
  if (appSecret === "emulator-app-secret")
    throw new Error("WHATSAPP_APP_SECRET is the emulator default; set the real one.");

  const bundled = join(workspaceRoot(), "var", "bin", "cloudflared.exe");
  const bin = existsSync(bundled) ? bundled : "cloudflared";
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", local], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = () => {
    child.kill();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, stop);
  child.on("exit", (code) => {
    process.stderr.write(`cloudflared exited (${code ?? "signal"})\n`);
    process.exit(1);
  });
  try {
    await register(child, appId, appSecret, verifyToken, graphVersion);
  } catch (err) {
    child.kill(); // never leave a public tunnel running after a failed registration
    throw err;
  }
}

async function register(
  child: ReturnType<typeof spawn>,
  appId: string,
  appSecret: string,
  verifyToken: string,
  graphVersion: string,
): Promise<void> {
  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("cloudflared printed no tunnel URL within 60 s")),
      60_000,
    );
    const scan = (chunk: Buffer) => {
      const match = URL_PATTERN.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
  });

  // A new quick-tunnel hostname takes a few seconds to resolve; Meta's handshake fails until it does.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await fetch(`${publicUrl}/__health`).catch(() => null);
    if (res?.ok) break;
    if (Date.now() > deadline) throw new Error(`${publicUrl} did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 2_000));
  }

  const callbackUrl = `${publicUrl}/webhook/whatsapp`;
  const body = new URLSearchParams({
    object: "whatsapp_business_account",
    callback_url: callbackUrl,
    verify_token: verifyToken,
    fields: "messages",
    access_token: `${appId}|${appSecret}`,
  });
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${appId}/subscriptions`, {
    method: "POST",
    body,
  });
  const reply = (await res.json()) as { success?: boolean; error?: { message?: string } };
  if (!res.ok || !reply.success)
    throw new Error(`Webhook registration failed: ${reply.error?.message ?? res.status}`);

  process.stdout.write(`Webhook  ${callbackUrl}\nRegistered with app ${appId}. Ctrl+C stops the tunnel.\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
