import {
  createPartFromBase64,
  createPartFromUri,
  createUserContent,
  Part,
} from "@google/genai";
import { getGeminiClient } from "@/lib/gemini";
import { execFile } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const GCS_BUCKET = (
  process.env.GCS_STUDY_BUCKET ||
  (process.env.GOOGLE_CLOUD_PROJECT
    ? `gs://${process.env.GOOGLE_CLOUD_PROJECT}_cloudbuild/study-videos`
    : "gs://your-gcs-bucket/study-videos")
).replace(/\/$/, "");

const AUDIO_CHUNK_SEC = 1800; // 30 minutes per audio chunk for exact second-level transcription
const INLINE_MAX_BYTES = 20 * 1024 * 1024; // 20MB max for inline base64

export interface VideoSegmentMeta {
  index: number;
  startSeconds: number;
  endSeconds: number;
  label: string;
  offsetMinutes: number;
  gcsUri: string;
  mimeType: string;
  summary?: string;
}

export interface VideoMetaSidecar {
  displayName: string;
  localPath: string;
  durationSeconds: number;
  audioGcsUri?: string;
  audioMimeType?: string;
  audioTranscript?: string;
  segments: VideoSegmentMeta[];
}

const backgroundIndexJobs = new Set<string>();

function formatHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

async function uploadFileToGcs(localPath: string, gcsUri: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", [
      "/d",
      "/s",
      "/c",
      "gcloud",
      "storage",
      "cp",
      localPath,
      gcsUri,
      "--quiet",
    ]);
  } else {
    await execFileAsync("gcloud", ["storage", "cp", localPath, gcsUri, "--quiet"]);
  }
}

export function normalizeSegmentTimestamps(
  text: string,
  startSec: number,
  endSec: number
): string {
  const segDur = endSec - startSec;
  return text.replace(
    /\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]/g,
    (match, p1, p2, p3) => {
      const a = parseInt(p1, 10);
      const b = parseInt(p2, 10);
      const c = p3 !== undefined ? parseInt(p3, 10) : null;

      let sec = 0;
      if (c !== null) {
        if (a > 2 && c === 0) {
          sec = a * 60 + b;
        } else {
          sec = a * 3600 + b * 60 + c;
        }
      } else {
        sec = a * 60 + b;
      }

      if (startSec > 0 && sec <= segDur + 60) {
        sec = startSec + sec;
      }

      if (sec < startSec || sec > endSec + 60) {
        return match;
      }

      const clamped = Math.min(endSec, Math.max(startSec, sec));
      const h = Math.floor(clamped / 3600);
      const m = Math.floor((clamped % 3600) / 60);
      const s = clamped % 60;

      if (h > 0) {
        return `[${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
      }
      return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
    }
  );
}

export function formatOutputTimestamps(
  text: string,
  maxDurationSeconds = 10800
): string {
  return text.replace(
    /(\[?)(\b\d{1,3}):(\d{2})(?::(\d{2}))?(\]?)/g,
    (match, openBr, p1, p2, p3, closeBr) => {
      const a = parseInt(p1, 10);
      const b = parseInt(p2, 10);
      const c = p3 !== undefined ? parseInt(p3, 10) : null;

      let totalSec = 0;
      if (c !== null) {
        if (a > 3 && c === 0 && a * 60 + b <= maxDurationSeconds) {
          totalSec = a * 60 + b;
        } else {
          totalSec = a * 3600 + b * 60 + c;
        }
      } else {
        totalSec = a * 60 + b;
      }

      if (totalSec <= 0 || totalSec > maxDurationSeconds + 120) {
        return match;
      }

      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const formatted =
        h > 0
          ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
          : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

      if (openBr === "[" && closeBr === "]") {
        return `[${formatted}]`;
      }
      if (c === null && a >= 60) {
        return `[${formatted}]`;
      }
      return `${openBr}${formatted}${closeBr}`;
    }
  );
}

async function getVideoDurationSeconds(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const parsed = parseFloat(stdout.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 1800;
  } catch {
    return 1800;
  }
}

async function findExistingMetaForSameFile(
  diskPath: string
): Promise<VideoMetaSidecar | null> {
  const directMetaPath = `${diskPath}.meta.json`;
  if (fs.existsSync(directMetaPath)) {
    const raw = await fsp.readFile(directMetaPath, "utf8");
    return JSON.parse(raw) as VideoMetaSidecar;
  }

  try {
    const stat = await fsp.stat(diskPath);
    const baseOriginalName = path.basename(diskPath).replace(/^\d+-/, "");
    const uploadDir = path.dirname(diskPath);
    const files = await fsp.readdir(uploadDir);

    for (const f of files) {
      if (f.endsWith(".meta.json")) {
        const metaFull = path.join(uploadDir, f);
        const candidateVideoPath = metaFull.replace(/\.meta\.json$/, "");
        if (fs.existsSync(candidateVideoPath)) {
          const candStat = await fsp.stat(candidateVideoPath);
          const candBase = path.basename(candidateVideoPath).replace(/^\d+-/, "");
          if (candStat.size === stat.size && candBase === baseOriginalName) {
            const raw = await fsp.readFile(metaFull, "utf8");
            const meta = JSON.parse(raw) as VideoMetaSidecar;
            await fsp.writeFile(directMetaPath, JSON.stringify(meta, null, 2), "utf8");
            return meta;
          }
        }
      }
    }
  } catch {
    // Ignore lookup errors
  }

  return null;
}

async function buildAudioTranscriptInBackground(
  diskPath: string,
  meta: VideoMetaSidecar,
  customApiKey?: string | null
): Promise<void> {
  if (backgroundIndexJobs.has(diskPath)) return;
  backgroundIndexJobs.add(diskPath);

  try {
    const durationSeconds = meta.durationSeconds;
    const numChunks = Math.max(1, Math.ceil(durationSeconds / AUDIO_CHUNK_SEC));
    const baseSafeName = path
      .basename(diskPath, path.extname(diskPath))
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const uploadDir = path.dirname(diskPath);
    const ai = getGeminiClient(customApiKey);

    const transcriptParts: string[] = [];

    for (let i = 0; i < numChunks; i++) {
      const startSec = i * AUDIO_CHUNK_SEC;
      const endSec = Math.min(durationSeconds, (i + 1) * AUDIO_CHUNK_SEC);
      const durMin = Math.max(1, Math.round((endSec - startSec) / 60));
      const localAudPath = path.join(uploadDir, `${baseSafeName}_tmp_aud${i + 1}.m4a`);
      const gcsAudUri = `${GCS_BUCKET}/${baseSafeName}_aud${i + 1}.m4a`;

      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-ss",
          String(startSec),
          "-t",
          String(AUDIO_CHUNK_SEC),
          "-i",
          diskPath,
          "-vn",
          "-c:a",
          "copy",
          "-loglevel",
          "error",
          localAudPath,
        ]);
      } catch {
        await execFileAsync("ffmpeg", [
          "-y",
          "-ss",
          String(startSec),
          "-t",
          String(AUDIO_CHUNK_SEC),
          "-i",
          diskPath,
          "-vn",
          "-c:a",
          "aac",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-b:a",
          "32k",
          "-loglevel",
          "error",
          localAudPath,
        ]);
      }

      await uploadFileToGcs(localAudPath, gcsAudUri);
      if (fs.existsSync(localAudPath)) {
        await fsp.unlink(localAudPath).catch(() => {});
      }

      const part = createPartFromUri(gcsAudUri, "audio/mp4");
      const prompt = `Listen carefully to this ${durMin}-minute lecture audio clip from [00:00] to [${durMin}:00]. Create a detailed, second-accurate chronological transcript and quote log with a [MM:SS] timestamp every 20-30 seconds from [00:00] all the way to [${durMin}:00]. Format all timestamps strictly as [MM:SS] relative to this ${durMin}-minute clip (do NOT add any offset yourself). Include verbatim Hindi/English quotes of famous statements, definitions, mnemonics, dates, names, committees, constitutional provisions, exam questions, and student doubt clarifications.`;

      const resp = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: [createUserContent([part, prompt])],
      });

      const shifted = normalizeSegmentTimestamps(resp.text || "", startSec, endSec);
      transcriptParts.push(
        `=== VERBATIM AUDIO TRANSCRIPT & QUOTE LOG PART ${i + 1} (${formatHms(
          startSec
        )} to ${formatHms(endSec)}) ===
${shifted}`
      );

      meta.audioTranscript = transcriptParts.join(`

`);
      await fsp.writeFile(`${diskPath}.meta.json`, JSON.stringify(meta, null, 2), "utf8");
    }
  } catch {
    // Ignore background errors; full audioGcsUri remains available
  } finally {
    backgroundIndexJobs.delete(diskPath);
  }
}

export async function ensureVideoPreparedForVertex(
  diskPath: string,
  mimeType: string,
  customApiKey?: string | null
): Promise<VideoMetaSidecar | null> {
  const existing = await findExistingMetaForSameFile(diskPath);
  if (
    existing &&
    (existing.audioTranscript || existing.audioGcsUri || existing.segments?.length > 0)
  ) {
    return existing;
  }

  const stat = await fsp.stat(diskPath);
  const durationSeconds = await getVideoDurationSeconds(diskPath);

  if (stat.size <= INLINE_MAX_BYTES && durationSeconds <= AUDIO_CHUNK_SEC) {
    return null;
  }

  const baseSafeName = path
    .basename(diskPath, path.extname(diskPath))
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const uploadDir = path.dirname(diskPath);

  let audioGcsUri: string | undefined;
  const tempAudioPath = path.join(uploadDir, `${baseSafeName}_tmp_audio.m4a`);
  try {
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        diskPath,
        "-vn",
        "-c:a",
        "copy",
        "-loglevel",
        "error",
        tempAudioPath,
      ]);
    } catch {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        diskPath,
        "-vn",
        "-c:a",
        "aac",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "32k",
        "-loglevel",
        "error",
        tempAudioPath,
      ]);
    }

    const targetAudioUri = `${GCS_BUCKET}/${baseSafeName}_audio.m4a`;
    await uploadFileToGcs(tempAudioPath, targetAudioUri);
    audioGcsUri = targetAudioUri;
  } finally {
    if (fs.existsSync(tempAudioPath)) {
      await fsp.unlink(tempAudioPath).catch(() => {});
    }
  }

  const meta: VideoMetaSidecar = {
    displayName: path.basename(diskPath).replace(/^\d+-/, ""),
    localPath: diskPath,
    durationSeconds,
    audioGcsUri,
    audioMimeType: "audio/mp4",
    segments: [],
  };

  await fsp.writeFile(`${diskPath}.meta.json`, JSON.stringify(meta, null, 2), "utf8");

  // Kick off background verbatim audio transcript indexing so subsequent queries take ~1.5-2 seconds!
  void buildAudioTranscriptInBackground(diskPath, meta, customApiKey);

  return meta;
}

export async function resolveVideoPartsForPrompt(
  fileUri: string,
  mimeType: string
): Promise<{ parts: Array<Part | string>; durationSeconds: number }> {
  if (!fileUri.startsWith("local://")) {
    return {
      parts: [createPartFromUri(fileUri, mimeType)],
      durationSeconds: 7200,
    };
  }

  const diskPath = fileUri.slice("local://".length);
  const meta = await ensureVideoPreparedForVertex(diskPath, mimeType);

  if (!meta) {
    const fileBuffer = await fsp.readFile(diskPath);
    const dur = await getVideoDurationSeconds(diskPath);
    return {
      parts: [createPartFromBase64(fileBuffer.toString("base64"), mimeType)],
      durationSeconds: dur,
    };
  }

  const parts: Array<Part | string> = [];

  // FAST PATH (~1.5-2.5 sec response): If the second-accurate verbatim audio transcript is cached, pass it as text (~16k tokens vs 181k audio tokens!)
  if (meta.audioTranscript && meta.audioTranscript.length > 500) {
    parts.push(
      `Complete Second-Accurate Verbatim Audio Transcript & Quote Log for "${meta.displayName}" (Total Video Duration: ${formatHms(
        meta.durationSeconds
      )} — all timestamps below are exact spoken audio timestamps from [00:00] to [${formatHms(
        meta.durationSeconds
      )}]):

${meta.audioTranscript}`
    );

    return { parts, durationSeconds: meta.durationSeconds };
  }

  // Fallback while background transcript is still building: use continuous full-lecture audio stream
  if (meta.audioGcsUri) {
    parts.push(
      `Continuous Full-Lecture Audio Stream ("${meta.displayName}", duration 00:00:00 to ${formatHms(
        meta.durationSeconds
      )}):`,
      createPartFromUri(meta.audioGcsUri, meta.audioMimeType || "audio/mp4")
    );
  }

  return { parts, durationSeconds: meta.durationSeconds };
}
