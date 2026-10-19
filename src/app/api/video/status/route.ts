import { NextRequest, NextResponse } from "next/server";
import { getGeminiClient } from "@/lib/gemini";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const fileName = req.nextUrl.searchParams.get("name");
    if (!fileName) {
      return NextResponse.json({ error: "Missing file 'name' parameter" }, { status: 400 });
    }

    const apiKey = req.headers.get("x-gemini-api-key");
    const ai = getGeminiClient(apiKey);
    const file = await ai.files.get({ name: fileName });

    return NextResponse.json({
      file: {
        name: file.name,
        displayName: file.displayName,
        uri: file.uri,
        mimeType: file.mimeType,
        state: String(file.state || "PROCESSING"),
        sizeBytes: file.sizeBytes ? String(file.sizeBytes) : undefined,
        error: file.error,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to check file status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
