# Advance-E.D.U

**Advance-E.D.U** is a local-first AI Video Study Hub built with **Next.js 15**, **TypeScript**, **Tailwind CSS v4**, and **Google Gemini 3.8 Flash / Vertex AI (`@google/genai`)**.

It enables students to load full-length local lecture videos (including 2–3+ hour, multi-hundred-megabyte recordings) on `localhost`, index every spoken word, sentence, and slide with **down-to-the-second `[MM:SS]` / `[HH:MM:SS]` timestamps**, and study interactively with ~2-second real-time streaming responses.

---

## Key Capabilities

- **3 Local Video Ingestion Modes:**
  1. **Browser File Picker / Drag & Drop:** Plays immediately in the HTML5 video player via local blob URL while streaming binary (`application/octet-stream`) to disk with instant file deduplication.
  2. **Zero-Copy Local Disk Path:** Paste any file path on your PC (e.g., `D:\Lectures\Polity_Lecture_1.mp4`). The local server streams the video directly from disk using HTTP `206 Partial Content` range requests without copying large files through browser memory.
  3. **Cached Sessions:** Instantaneously reconnect to previously indexed lectures stored in `.local-uploads/`.
- **Exact Word & Sentence Timestamp Grounding (`[MM:SS]` / `[HH:MM:SS]`):**
  - Automatically extracts the continuous lecture audio via `ffmpeg`, builds a second-accurate verbatim transcript & quote log across 30-minute audio segments using **Gemini 3.8 Flash**, and normalizes timestamps deterministically in TypeScript.
  - Clicking any `[MM:SS]` or `[HH:MM:SS]` badge in the chat, notes, quiz, or flashcards seeks the video player directly to that exact second.
- **~2-Second Real-Time Streaming Q&A:**
  - Streams answers token-by-token via `ai.models.generateContentStream` (`thinkingBudget: 0`) over the cached verbatim transcript (~16k tokens vs 180k+ raw audio tokens).
- **4 Interactive Study Modes:**
  - **Video Q&A Chat** (with an **"Ask about [Current Time]"** button synced to the video player)
  - **Timestamped Chapter & Study Notes**
  - **Interactive Practice Quiz** (5 auto-graded MCQs with explanations and timestamp jump links)
  - **Active-Recall Flashcards** (Interactive flip cards with category tags and timestamp jump links)

---

## Architecture

```text
Local Video (.mp4 / .mkv / .webm)
  ├──► HTML5 Video Player (Blob URL or /api/video/stream HTTP 206 Range Streaming)
  └──► /api/video/upload & src/lib/videoProcessor.ts
         ├──► Small Videos (<20MB): Direct inline multimodal analysis
         └──► Large / Long Lectures (2+ hours, 300MB–2GB+):
                ├──► ffmpeg lossless audio extraction (-vn -c:a copy)
                ├──► 30-min audio chunk transcription via Gemini 3.8 Flash
                ├──► Deterministic TypeScript timestamp normalization (.meta.json cache)
                └──► /api/video/analyze (Real-time ReadableStream -> ~2s First Token)
```

---

## Prerequisites

- **Node.js** v20+ and **npm**
- **FFmpeg** (`ffmpeg` and `ffprobe` available in system `PATH`)
- **Google Cloud CLI (`gcloud`)** & a **Vertex AI API Key** (or **Google AI Studio Gemini API Key**)

---

## Getting Started

### 1. Clone the repository & install dependencies

```bash
git clone https://github.com/beyondmarks-ai/Advance-E.D.U.git
cd Advance-E.D.U
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env.local` and fill in your Vertex AI or Gemini API credentials:

```bash
cp .env.example .env.local
```

```env
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
VERTEX_API_KEY=your_vertex_ai_api_key_here
GCS_STUDY_BUCKET=gs://your-gcs-bucket-name/study-videos
GEMINI_API_KEY=your_gemini_api_key_here
```

*(Alternatively, click **"Set API Key"** in the top-right bar of the web UI to save a key in `localStorage`.)*

### 3. Run the development server

```bash
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## Project Structure

```text
├── src/
│   ├── app/
│   │   ├── api/video/
│   │   │   ├── upload/route.ts    # Deduplicated binary stream upload & local path loader
│   │   │   ├── stream/route.ts    # HTTP 206 Partial Content range video streamer
│   │   │   ├── status/route.ts    # File processing status polling endpoint
│   │   │   └── analyze/route.ts   # Streaming Q&A, Notes, Quiz & Flashcards endpoint
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx               # Main split-screen video study hub interface
│   ├── components/
│   │   └── FormattedStudyText.tsx # Markdown renderer with clickable [MM:SS] seek badges
│   └── lib/
│       ├── gemini.ts              # GoogleGenAI client initialization (Vertex AI & Gemini API)
│       └── videoProcessor.ts      # FFmpeg audio slicing, GCS upload & timestamp normalization
├── .env.example
├── next.config.mjs
├── package.json
└── tsconfig.json
```

<!-- beyond-marks-credit:start -->
---
### Built by Beyond Marks AI Academy

Developed by **Rakesh Kumar** at [Beyond Marks AI Academy](https://beyondmarks.ai).
<!-- beyond-marks-credit:end -->
