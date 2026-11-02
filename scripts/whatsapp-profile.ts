// `pnpm exec tsx scripts/whatsapp-profile.ts`: gives the Dockhand WhatsApp number its identity. Draws the avatar from
// the mark in @dockhand/design (assets/brand/dockhand-avatar.png), uploads it with the Resumable Upload API and sets
// the business profile, so the chat header shows the brand instead of a default picture.
//
//   --dry   draw the avatar and print the profile text, change nothing

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { loadConfig, workspaceRoot } from "../packages/core/src/index.ts";
import { COLOR, MARK } from "../packages/design/src/index.ts";

const ABOUT = "Sales work, done from WhatsApp. Every write waits for your approval.";
const DESCRIPTION =
  "Dockhand is a sales workflow agent. Forward a voice note, photo or PDF and it does the follow-up across your sales stack: an Approve tap before every write, a receipt after every run. Built on Meta's Muse models.";

const dry = process.argv.includes("--dry");
const out = join(workspaceRoot(), "assets", "brand", "dockhand-avatar.png");

async function drawAvatar(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
    await page.setContent(
      `<!doctype html><body style="margin:0;width:640px;height:640px;background:${COLOR.accent};display:grid;place-items:center"><svg viewBox="${MARK.viewBox}" style="height:300px;fill:${COLOR.onAccent}"><path d="${MARK.path}"/></svg></body>`,
    );
    mkdirSync(join(workspaceRoot(), "assets", "brand"), { recursive: true });
    writeFileSync(out, await page.screenshot({ type: "png" }));
  } finally {
    await browser.close();
  }
}

async function graph(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status} ${JSON.stringify(body.error ?? body)}`);
  return body;
}

async function main(): Promise<void> {
  await drawAvatar();
  console.log(`avatar: ${out}`);
  if (dry) {
    console.log(`about (${ABOUT.length}): ${ABOUT}\ndescription (${DESCRIPTION.length}): ${DESCRIPTION}`);
    return;
  }
  loadConfig(); // .env into this process's environment
  const { whatsapp } = loadConfig({ ...process.env, WHATSAPP_MODE: "cloud" });
  const appId = process.env.WHATSAPP_APP_ID;
  if (!appId) throw new Error("WHATSAPP_APP_ID is not set");
  const api = `https://graph.facebook.com/${whatsapp.graphVersion}`;
  const image = readFileSync(out);

  const session = await graph(
    `${api}/${appId}/uploads?${new URLSearchParams({
      file_name: "dockhand-avatar.png",
      file_length: String(image.length),
      file_type: "image/png",
    })}`,
    { method: "POST", headers: { authorization: `Bearer ${whatsapp.token}` } },
  );
  const upload = await graph(`${api}/${String(session.id)}`, {
    method: "POST",
    headers: { authorization: `OAuth ${whatsapp.token}`, file_offset: "0" },
    body: image,
  });
  await graph(`${api}/${whatsapp.phoneNumberId}/whatsapp_business_profile`, {
    method: "POST",
    headers: { authorization: `Bearer ${whatsapp.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      about: ABOUT,
      description: DESCRIPTION,
      vertical: "OTHER",
      profile_picture_handle: upload.h,
    }),
  });
  const now = await graph(
    `${api}/${whatsapp.phoneNumberId}/whatsapp_business_profile?fields=about,description,vertical,profile_picture_url`,
    { headers: { authorization: `Bearer ${whatsapp.token}` } },
  );
  const row = (now.data as Record<string, string>[])[0] ?? {};
  console.log(`profile set. about: ${row.about}\npicture: ${row.profile_picture_url ? "yes" : "no"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
