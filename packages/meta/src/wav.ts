import { DockhandError } from "@dockhand/core";

export interface WavInfo {
  /** 1 = integer PCM (WAVE_FORMAT_EXTENSIBLE is resolved to its sub-format). */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  audioMs: number;
}

/** Limits from https://dev.meta.ai/docs/speech-to-text: body over 32 MB is 413, audio over 10 min is 400. */
export const MAX_TRANSCRIBE_BODY_BYTES = 32_000_000;
export const MAX_TRANSCRIBE_AUDIO_MS = 10 * 60 * 1000;
const MULTIPART_OVERHEAD_BYTES = 1024;

/** Reads the RIFF/WAVE header. Throws MEDIA_UNSUPPORTED for anything that is not a readable WAV file. */
export function parseWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE")
    throw unsupported("not a RIFF/WAVE file");

  let fmt: Omit<WavInfo, "dataBytes" | "audioMs"> | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) throw unsupported("truncated fmt chunk");
      let audioFormat = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format code is the first two bytes of the sub-format GUID.
      if (audioFormat === 0xfffe && size >= 40 && body + 26 <= bytes.length)
        audioFormat = view.getUint16(body + 24, true);
      fmt = {
        audioFormat,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      const available = bytes.length - body;
      // Streamed writers leave the size at 0 or 0xFFFFFFFF; a truncated file holds less than declared.
      dataBytes = size === 0 || size === 0xffffffff || size > available ? available : size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt) throw unsupported("no fmt chunk");
  if (dataBytes === undefined) throw unsupported("no data chunk");
  const bytesPerSecond = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
  if (!(bytesPerSecond > 0))
    throw unsupported("fmt chunk has a zero sample rate, channel count or bit depth");
  return { ...fmt, dataBytes, audioMs: Math.floor((dataBytes * 1000) / bytesPerSecond) };
}

/** Voice Transcribe accepts mono 16-bit integer PCM at 16 or 24 kHz, at most 10 minutes and 32 MB. */
export function assertTranscribable(info: WavInfo, fileBytes: number): void {
  const problems: string[] = [];
  if (info.audioFormat !== 1) problems.push(`format ${info.audioFormat} is not integer PCM`);
  if (info.channels !== 1) problems.push(`${info.channels} channels (mono required)`);
  if (info.bitsPerSample !== 16) problems.push(`${info.bitsPerSample}-bit samples (16-bit required)`);
  if (info.sampleRate !== 16000 && info.sampleRate !== 24000)
    problems.push(`${info.sampleRate} Hz (16 or 24 kHz required)`);
  if (info.audioMs > MAX_TRANSCRIBE_AUDIO_MS)
    problems.push(`${Math.round(info.audioMs / 1000)} s of audio (max 600 s)`);
  if (fileBytes + MULTIPART_OVERHEAD_BYTES > MAX_TRANSCRIBE_BODY_BYTES)
    problems.push(`${fileBytes} bytes (max 32 MB)`);
  if (problems.length > 0) {
    throw new DockhandError(
      "MEDIA_UNSUPPORTED",
      `WAV not accepted by Voice Transcribe: ${problems.join("; ")}. Convert with: ffmpeg -i in -ac 1 -ar 16000 -c:a pcm_s16le out.wav`,
      { ...info },
    );
  }
}

function unsupported(why: string): DockhandError {
  return new DockhandError("MEDIA_UNSUPPORTED", `not a usable WAV file: ${why}`);
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  if (b.length < offset + length) return "";
  return String.fromCharCode(...b.subarray(offset, offset + length));
}
