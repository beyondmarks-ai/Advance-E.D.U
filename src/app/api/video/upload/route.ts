import { NextRequest, NextResponse } from "next/server";
import { getGeminiClient, getVideoMimeType, isUsingVertex } from "@/lib/gemini";
import { ensureVideoPreparedForVertex } from "@/lib/videoProcessor";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { ReadableStream as NodeReadableStream } from "stream/web";

export const runtime = "nodejs";

const UPLOAD_DIR = path.join(process.cwd(), ".local-uploads");

async function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  }
}

async function findMatchingLocalUpload(
  fileName: string,
  fileSize?: number
): Promise<string | null> {
  await ensureUploadDir();
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const entries = await fsp.readdir(UPLOAD_DIR);

  for (const entry of entries) {
    if (entry.endsWith(".json") || entry.includes("_tmp_part")) continue;
    const stripped = entry.replace(/^\d+-/, "");
    if (stripped.toLowerCase() === sanitized.toLowerCase()) {
      const fullCandidate = path.join(UPLOAD_DIR, entry);
      const st = await fsp.stat(fullCandidate);
      if (!fileSize || st.size === fileSize) {
        return fullCandidate;
      }
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-gemini-api-key");
    const vertexMode = isUsingVertex(apiKey);
    const project = process.env.GOOGLE_CLOUD_PROJECT || "Vertex-AI";

    if (vertexMode) {
      await ensureUploadDir();
      const entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true });
      const videos = [];

      for (const entry of entries) {
        if (
          entry.isFile() &&
          !entry.name.endsWith(".json") &&
          !entry.name.includes("_tmp_part")
        ) {
          const fullPath = path.join(UPLOAD_DIR, entry.name);
          const stat = await fsp.stat(fullPath);
          videos.push({
            name: entry.name,
            displayName: entry.name.replace(/^\d+-/, ""),
            uri: `local://${fullPath}`,
            mimeType: getVideoMimeType(entry.name),
            state: "ACTIVE",
            sizeBytes: String(stat.size),
            localPath: fullPath,
          });
        }
      }

      return NextResponse.json({
        provider: "vertex",
        project,
        hasServerKey: Boolean(process.env.VERTEX_API_KEY || process.env.GEMINI_API_KEY),
        videos,
      });
    }

    const ai = getGeminiClient(apiKey);
    const pager = await ai.files.list({ config: { pageSize: 20 } });
    const videos: Array<{
      name: string;
      displayName: string;
      uri: string;
      mimeType: string;
      state: string;
      sizeBytes?: string;
      createTime?: string;
    }> = [];

    for await (const file of pager) {
      if (file.mimeType?.startsWith("video/") && file.name && file.uri) {
        videos.push({
          name: file.name,
          displayName: file.displayName || file.name,
          uri: file.uri,
          mimeType: file.mimeType,
          state: String(file.state || "ACTIVE"),
          sizeBytes: file.sizeBytes ? String(file.sizeBytes) : undefined,
          createTime: file.createTime,
        });
      }
    }

    return NextResponse.json({
      provider: "gemini",
      project,
      hasServerKey: Boolean(process.env.VERTEX_API_KEY || process.env.GEMINI_API_KEY),
      videos,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to list uploaded videos";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-gemini-api-key");
    const vertexMode = isUsingVertex(apiKey);
    const contentType = req.headers.get("content-type") || "";

    let targetFilePath = "";
    let displayName = "";
    let mimeType = "video/mp4";
    let fileSize = 0;

    if (contentType.includes("application/json")) {
      const body = await req.json();

      // Fast pre-upload deduplication check so already-saved files don't re-transfer 400MB
      if (body.checkExistingFile) {
        const existingPath = await findMatchingLocalUpload(
          body.fileName || "",
          Number(body.fileSize || 0)
        );
        if (!existingPath) {
          return NextResponse.json({ found: false });
        }
        const st = await fsp.stat(existingPath);
        const mType = getVideoMimeType(existingPath, body.mimeType);
        if (vertexMode) {
          await ensureVideoPreparedForVertex(existingPath, mType, apiKey);
        }
        return NextResponse.json({
          found: true,
          file: {
            name: path.basename(existingPath),
            displayName: body.fileName || path.basename(existingPath).replace(/^\d+-/, ""),
            uri: `local://${existingPath}`,
            mimeType: mType,
            state: "ACTIVE",
            sizeBytes: String(st.size),
            localPath: existingPath,
          },
        });
      }

      const rawPath = (body.localFilePath || "").trim().replace(/^["']|["']$/g, "");
      if (!rawPath) {
        return NextResponse.json(
          { error: "Please provide a valid local file path." },
          { status: 400 }
        );
      }

      const resolvedPath = path.resolve(rawPath);
      if (!fs.existsSync(resolvedPath)) {
        return NextResponse.json(
          { error: `File not found on disk: ${resolvedPath}` },
          { status: 404 }
        );
      }

      const stat = await fsp.stat(resolvedPath);
      if (!stat.isFile()) {
        return NextResponse.json(
          { error: `Path is not a file: ${resolvedPath}` },
          { status: 400 }
        );
      }

      targetFilePath = resolvedPath;
      displayName = path.basename(resolvedPath);
      mimeType = getVideoMimeType(resolvedPath);
      fileSize = stat.size;
    } else if (contentType.includes("application/octet-stream")) {
      // Zero-memory-buffering binary stream upload (avoids undici req.formData() 'fetch failed' on large >200MB files)
      await ensureUploadDir();
      const rawName = decodeURIComponent(req.headers.get("x-file-name") || "video.mp4");
      const rawSize = Number(req.headers.get("x-file-size") || 0);
      const rawType = req.headers.get("x-file-type") || undefined;

      displayName = rawName;
      mimeType = getVideoMimeType(rawName, rawType);

      const existingPath = await findMatchingLocalUpload(rawName, rawSize);
      if (existingPath) {
        targetFilePath = existingPath;
        const st = await fsp.stat(existingPath);
        fileSize = st.size;
      } else {
        const safeName = `${Date.now()}-${rawName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        targetFilePath = path.join(UPLOAD_DIR, safeName);

        if (!req.body) {
          return NextResponse.json({ error: "Empty request body" }, { status: 400 });
        }

        const nodeReadable = Readable.fromWeb(req.body as unknown as NodeReadableStream);
        const writeStream = fs.createWriteStream(targetFilePath);
        await pipeline(nodeReadable, writeStream);

        const st = await fsp.stat(targetFilePath);
        fileSize = st.size;
      }
    } else if (contentType.includes("multipart/form-data")) {
      await ensureUploadDir();
      const formData = await req.formData();
      const file = formData.get("file");

      if (!file || !(file instanceof File)) {
        return NextResponse.json(
          { error: "No video file found in upload request." },
          { status: 400 }
        );
      }

      displayName = file.name;
      mimeType = getVideoMimeType(file.name, file.type);

      const existingPath = await findMatchingLocalUpload(file.name, file.size);
      if (existingPath) {
        targetFilePath = existingPath;
        fileSize = file.size;
      } else {
        const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        targetFilePath = path.join(UPLOAD_DIR, safeName);
        const arrayBuffer = await file.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);
        fileSize = buf.byteLength;
        await fsp.writeFile(targetFilePath, buf);
      }
    } else {
      return NextResponse.json(
        { error: "Unsupported Content-Type." },
        { status: 400 }
      );
    }

    if (vertexMode) {
      await ensureVideoPreparedForVertex(targetFilePath, mimeType, apiKey);

      return NextResponse.json({
        file: {
          name: path.basename(targetFilePath),
          displayName,
          uri: `local://${targetFilePath}`,
          mimeType,
          state: "ACTIVE",
          sizeBytes: String(fileSize),
          localPath: targetFilePath,
        },
      });
    }

    const ai = getGeminiClient(apiKey);
    const uploadedFile = await ai.files.upload({
      file: targetFilePath,
      config: {
        displayName,
        mimeType,
      },
    });

    return NextResponse.json({
      file: {
        name: uploadedFile.name,
        displayName: uploadedFile.displayName || displayName,
        uri: uploadedFile.uri,
        mimeType: uploadedFile.mimeType || mimeType,
        state: String(uploadedFile.state || "PROCESSING"),
        sizeBytes: uploadedFile.sizeBytes ? String(uploadedFile.sizeBytes) : undefined,
        localPath: targetFilePath,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to upload video";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
