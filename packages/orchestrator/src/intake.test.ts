import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "@dockhand/core";
import { afterAll, describe, expect, it } from "vitest";
import { classifyMedia, toWav, transcriptionKeywords } from "./intake.ts";

const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const tmpDir = mkdtempSync(join(tmpdir(), "dockhand-intake-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("classifyMedia", () => {
  it("routes by MIME type, documents included", () => {
    const m = (kind: "audio" | "image" | "document" | "video", mime: string) =>
      classifyMedia({ kind, media: { mediaId: "1", mime } });
    expect(m("audio", "audio/ogg; codecs=opus")).toBe("voice");
    expect(m("image", "image/jpeg")).toBe("photo");
    expect(m("document", "application/pdf")).toBe("pdf");
    expect(m("document", "video/mp4")).toBe("video");
    expect(m("video", "video/mp4")).toBe("video");
    expect(m("document", "application/zip")).toBe("unsupported");
    expect(classifyMedia({ kind: "text" })).toBe("unsupported");
  });
});

describe("toWav (ffmpeg)", () => {
  it("converts an OGG/Opus voice note to 16 kHz mono PCM16 WAV", async () => {
    const ogg = join(tmpDir, "note.ogg");
    execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "libopus",
      ogg,
    ]);
    const wav = await toWav(new Uint8Array(readFileSync(ogg)), "ogg", { ffmpegPath, tmpDir });
    expect(wav).not.toBeNull();
    const view = Buffer.from(wav as Uint8Array);
    expect(view.toString("ascii", 0, 4)).toBe("RIFF");
    expect(view.readUInt16LE(22)).toBe(1); // channels
    expect(view.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(view.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it("returns null for a silent screen recording", async () => {
    const mp4 = readFileSync(join(workspaceRoot(), "fixtures", "teach", "caravela-register-deal.mp4"));
    await expect(toWav(new Uint8Array(mp4), "mp4", { ffmpegPath, tmpDir })).resolves.toBeNull();
  });
});

describe("transcriptionKeywords", () => {
  it("dedupes and keeps names only", () => {
    const k = transcriptionKeywords({
      companies: ["Café Aurora", "Caravela", "42"],
      skillExamples: ["Rota Consultoria"],
    });
    expect(k).toContain("Café Aurora");
    expect(k).toContain("Rota Consultoria");
    expect(k.filter((x) => x === "Caravela")).toHaveLength(1);
    expect(k).not.toContain("42");
  });
});
