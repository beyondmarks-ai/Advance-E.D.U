import { GoogleGenAI } from "@google/genai";
import path from "path";

export function isUsingVertex(customApiKey?: string | null): boolean {
  if (process.env.VERTEX_API_KEY?.trim()) {
    return true;
  }
  const custom = customApiKey?.trim();
  if (custom) {
    return custom.startsWith("AQ.") || !custom.startsWith("AIza");
  }
  return false;
}

export function getGeminiClient(customApiKey?: string | null): GoogleGenAI {
  const vertexKey = process.env.VERTEX_API_KEY?.trim();
  const custom = customApiKey?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();

  // Prefer the working server-side Vertex AI key from .env.local
  if (vertexKey) {
    return new GoogleGenAI({
      vertexai: true,
      apiKey: vertexKey,
    });
  }

  if (custom) {
    const useVertex = isUsingVertex(custom);
    return new GoogleGenAI(
      useVertex ? { vertexai: true, apiKey: custom } : { apiKey: custom }
    );
  }

  if (geminiKey) {
    return new GoogleGenAI({
      apiKey: geminiKey,
    });
  }

  throw new Error(
    "Missing API Key. Please set VERTEX_API_KEY or GEMINI_API_KEY in .env.local or in the top settings bar."
  );
}

export function getVideoMimeType(filePathOrName: string, fallback?: string): string {
  if (fallback && fallback.startsWith("video/")) {
    return fallback;
  }
  const ext = path.extname(filePathOrName).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".3gp": "video/3gpp",
  };
  return mimeMap[ext] || "video/mp4";
}
