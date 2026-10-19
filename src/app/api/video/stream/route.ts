import { NextRequest, NextResponse } from "next/server";
import { getVideoMimeType } from "@/lib/gemini";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const rawPath = req.nextUrl.searchParams.get("path");
    if (!rawPath) {
      return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });
    }

    const resolvedPath = path.resolve(rawPath);
    if (!fs.existsSync(resolvedPath)) {
      return NextResponse.json({ error: "Local video file not found" }, { status: 404 });
    }

    const stat = fs.statSync(resolvedPath);
    const fileSize = stat.size;
    const mimeType = getVideoMimeType(resolvedPath);
    const range = req.headers.get("range");

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const nodeStream = fs.createReadStream(resolvedPath, { start, end });
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;

      return new NextResponse(webStream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": mimeType,
        },
      });
    } else {
      const nodeStream = fs.createReadStream(resolvedPath);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;

      return new NextResponse(webStream, {
        status: 200,
        headers: {
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
          "Content-Type": mimeType,
        },
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to stream local video";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
