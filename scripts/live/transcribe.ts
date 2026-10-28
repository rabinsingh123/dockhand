// Live Voice Transcribe check: a short synthetic voice note (Windows System.Speech, English voice; no
// Portuguese voice ships with Windows) -> ffmpeg 16 kHz mono PCM16 WAV -> muse-voice-transcribe-1.0.
// Verifies the request and response shape, not recognition quality.
//
// Usage: META_MODE=live tsx scripts/live/transcribe.ts [path/to/audio]   (default: synthesize one)

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { openLive } from "./lib.ts";

const run = promisify(execFile);
const TEXT =
  "Hi Ana, it's Julia from Cafe Aurora. Can you send pricing for twenty five people in Sao Paulo, starting January? We are thinking about the Business plan. Thanks!";

const live = openLive("transcribe");
try {
  const dir = join(process.env.DOCKHAND_VAR_DIR as string, "tmp");
  mkdirSync(dir, { recursive: true });
  let source = process.argv[2];
  if (!source) {
    source = join(dir, "tts-source.wav");
    const ps = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$s.SelectVoice('Microsoft Zira Desktop')",
      `$s.SetOutputToWaveFile('${source.replaceAll("'", "''")}')`,
      `$s.Speak('${TEXT.replaceAll("'", "''")}')`,
      "$s.Dispose()",
    ].join("; ");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  const wavPath = join(dir, "voice-16k.wav");
  await run(live.config.ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    wavPath,
  ]);
  const wav = await live.artifacts.put(new Uint8Array(readFileSync(wavPath)), "audio/wav", {
    kind: "audio_wav",
    jobId: "live-transcribe",
  });
  const t0 = Date.now();
  const transcript = await live.models.transcribe(
    wav,
    { languageBias: ["Portuguese", "English"], keywords: ["Tidewater Cloud", "Café Aurora", "Caravela"] },
    { purpose: "transcribe", jobId: "live-transcribe", timeoutMs: 60_000 },
  );
  console.log(`ok in ${Date.now() - t0} ms (${wav.bytes} bytes)`);
  console.log(JSON.stringify(transcript, null, 1));
} catch (err) {
  console.log(`transcribe FAILED: ${(err as Error).message}`);
} finally {
  console.log(`\n${live.report()}`);
  live.close();
}
