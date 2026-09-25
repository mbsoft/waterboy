import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { Attachment } from "./messagesDb.ts";
import type { VoiceConfig } from "../config.ts";
import { log } from "../config.ts";

const run = promisify(execFile);

export async function waitForFile(p: string, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.statSync(p).size > 0) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const HEIC = /\.(heic|heif)$/i;
const AUDIO = /\.(caf|m4a|amr|aac|mp3|wav|ogg|opus)$/i;

export function isAudio(a: Attachment): boolean {
  return (a.mimeType?.startsWith("audio/") ?? false) || AUDIO.test(a.path);
}

/**
 * Copy an attachment into the chat's inbox. HEIC photos are converted to JPEG
 * with macOS `sips` so the model can read them.
 */
export async function importAttachment(a: Attachment, inboxDir: string): Promise<string | null> {
  if (!(await waitForFile(a.path))) {
    log("[media] attachment never appeared on disk:", a.path);
    return null;
  }
  fs.mkdirSync(inboxDir, { recursive: true });
  const base = `${Date.now()}-${(a.name ?? path.basename(a.path)).replace(/[^\w.\-]+/g, "_")}`;
  let dest = path.join(inboxDir, base);
  if (HEIC.test(a.path)) {
    const jpg = dest.replace(HEIC, ".jpg");
    try {
      await run("sips", ["-s", "format", "jpeg", a.path, "--out", jpg], { timeout: 30_000 });
      return jpg;
    } catch (e) {
      log("[media] HEIC conversion failed, copying original:", (e as Error).message);
    }
  }
  fs.copyFileSync(a.path, dest);
  return dest;
}

/** Local speech-to-text via ffmpeg + whisper.cpp. Returns null if unavailable. */
export async function transcribe(audioPath: string, voice: VoiceConfig): Promise<string | null> {
  if (!voice.enabled) return null;
  if (!fs.existsSync(voice.modelPath)) {
    log("[voice] whisper model not found at", voice.modelPath);
    return null;
  }
  const wav = audioPath.replace(/\.[^.]+$/, "") + ".16k.wav";
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", wav], { timeout: 120_000 });
    const { stdout } = await run(voice.whisperBin, ["-m", voice.modelPath, "-f", wav, "-nt", "-np"], {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.replace(/\s+/g, " ").trim() || null;
  } catch (e) {
    log("[voice] transcription failed:", (e as Error).message);
    return null;
  } finally {
    fs.rm(wav, { force: true }, () => {});
  }
}
