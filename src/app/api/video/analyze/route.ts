import { NextRequest, NextResponse } from "next/server";
import { getGeminiClient } from "@/lib/gemini";
import {
  formatOutputTimestamps,
  resolveVideoPartsForPrompt,
} from "@/lib/videoProcessor";
import { createUserContent, Part } from "@google/genai";

export const runtime = "nodejs";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STUDY_SYSTEM_PROMPT = `You are an expert AI Study Tutor analyzing a complete lecture video and its second-accurate verbatim audio transcript and slide log.

Follow these formatting rules strictly:
1. ALWAYS include exact timestamps in bracketed [MM:SS] or [HH:MM:SS] format (e.g., [26:00], [50:25], [01:21:45], [01:55:45]) whenever referencing a spoken sentence, quote, moment, slide, explanation, formula, or visual event.
2. When the student asks where a specific word, sentence, quote, or concept was spoken, provide the EXACT [MM:SS] or [HH:MM:SS] timestamp and quote the exact sentence spoken by the instructor.
3. For timestamps at or above 60 minutes, format them as [HH:MM:SS] (for example, 81 minutes 45 seconds MUST be written as [01:21:45]).
4. Organize explanations clearly with headings, bullet points, and bold key terms.`;

async function generateWithFallback(
  apiKey: string | null,
  preferredModel: string,
  parts: Array<Part | string>,
  promptText: string,
  jsonMode = false
): Promise<string> {
  const ai = getGeminiClient(apiKey);
  const candidateModels = Array.from(
    new Set([preferredModel, "gemini-3.8-flash", "gemini-2.5-flash"])
  );

  let lastError: unknown = null;

  for (const modelName of candidateModels) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [createUserContent([...parts, promptText])],
          config: {
            systemInstruction: STUDY_SYSTEM_PROMPT,
            thinkingConfig: { thinkingBudget: 0 },
            ...(jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        });
        if (response.text) {
          return response.text;
        }
      } catch (err: unknown) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to generate response from Vertex AI");
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-gemini-api-key");
    const body = await req.json();

    const {
      fileUri,
      mimeType = "video/mp4",
      model = "gemini-3.8-flash",
      mode = "chat",
      question = "",
      history = [] as ChatMessage[],
      stream = false,
    } = body;

    if (!fileUri) {
      return NextResponse.json(
        { error: "Missing video fileUri. Please upload or select a local video first." },
        { status: 400 }
      );
    }

    const { parts: videoParts, durationSeconds } =
      await resolveVideoPartsForPrompt(fileUri, mimeType);

    if (mode === "notes") {
      const prompt = `Generate comprehensive, structured Study Notes for this entire video lecture.
Include:
1. **Executive Overview**: What this video teaches and main learning objectives.
2. **Timestamped Chapter Breakdown**: Chronological breakdown of every section across the entire video with exact [MM:SS] or [HH:MM:SS] timestamps.
3. **Core Concepts, Dates, & Definitions**: Detailed breakdown of key terms, historical timelines, articles/schedules, formulas, or diagrams shown on screen (with [MM:SS] / [HH:MM:SS] citations).
4. **Key Takeaways & Exam Revision Checklist**: High-yield bullet points of the most important facts to remember for exams.`;

      const text = await generateWithFallback(apiKey, model, videoParts, prompt, false);
      return NextResponse.json({
        result: formatOutputTimestamps(
          text || "No study notes generated.",
          durationSeconds
        ),
      });
    }

    if (mode === "quiz") {
      const prompt = `Create a 5-question multiple-choice study quiz testing the most important exam concepts across this entire video.
Return ONLY a valid JSON array (no markdown fences) where each item has:
{
  "question": "Question text",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctIndex": 0,
  "explanation": "Clear explanation of why this answer is correct and why others are not",
  "timestamp": "MM:SS or HH:MM:SS"
}`;

      const rawText = await generateWithFallback(apiKey, model, videoParts, prompt, true);
      const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
      const parsed = JSON.parse(cleaned || "[]");
      return NextResponse.json({ quiz: parsed });
    }

    if (mode === "flashcards") {
      const prompt = `Create 8 high-yield study flashcards from across this entire video for active recall practice.
Return ONLY a valid JSON array (no markdown fences) where each item has:
{
  "front": "Concise question, concept, date, or constitutional term",
  "back": "Clear, accurate answer or definition",
  "category": "Topic / Section name",
  "timestamp": "MM:SS or HH:MM:SS"
}`;

      const rawText = await generateWithFallback(apiKey, model, videoParts, prompt, true);
      const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
      const parsed = JSON.parse(cleaned || "[]");
      return NextResponse.json({ flashcards: parsed });
    }

    // Default: "chat" mode
    const formattedHistory = history
      .slice(-8)
      .map((m: ChatMessage) => `${m.role === "user" ? "Student" : "Tutor"}: ${m.content}`)
      .join(`

`);
    const conversationContext =
      history.length > 0
        ? `Previous conversation context:
${formattedHistory}

New Student Question:
`
        : "";

    const fullQuestionPrompt = `${conversationContext}${question}`;

    // Real-time streaming mode (first word in ~1.5-2 seconds!)
    if (stream) {
      const ai = getGeminiClient(apiKey);
      const encoder = new TextEncoder();

      const readable = new ReadableStream({
        async start(controller) {
          try {
            const responseStream = await ai.models.generateContentStream({
              model,
              contents: [createUserContent([...videoParts, fullQuestionPrompt])],
              config: {
                systemInstruction: STUDY_SYSTEM_PROMPT,
                thinkingConfig: { thinkingBudget: 0 },
              },
            });

            for await (const chunk of responseStream) {
              const textChunk = chunk.text || "";
              if (textChunk) {
                controller.enqueue(
                  encoder.encode(formatOutputTimestamps(textChunk, durationSeconds))
                );
              }
            }
          } catch {
            // Fallback to non-streaming model if stream is interrupted
            try {
              const fallbackText = await generateWithFallback(
                apiKey,
                "gemini-2.5-flash",
                videoParts,
                fullQuestionPrompt,
                false
              );
              controller.enqueue(
                encoder.encode(formatOutputTimestamps(fallbackText, durationSeconds))
              );
            } catch (innerErr: unknown) {
              const errMsg =
                innerErr instanceof Error ? innerErr.message : "Stream error";
              controller.enqueue(encoder.encode(`**Error:** ${errMsg}`));
            }
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readable, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    const answerText = await generateWithFallback(
      apiKey,
      model,
      videoParts,
      fullQuestionPrompt,
      false
    );

    return NextResponse.json({
      answer: formatOutputTimestamps(
        answerText || "I couldn't generate a response for that question.",
        durationSeconds
      ),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to analyze video with Gemini";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
