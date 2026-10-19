"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Video,
  Upload,
  FolderOpen,
  Send,
  Sparkles,
  BookOpen,
  HelpCircle,
  Layers,
  MessageSquare,
  CheckCircle2,
  Loader2,
  AlertCircle,
  KeyRound,
  Clock,
  Play,
  RotateCcw,
  History,
  Cpu,
} from "lucide-react";
import FormattedStudyText, {
  formatSeconds,
  parseTimestampToSeconds,
} from "@/components/FormattedStudyText";

interface UploadedVideoInfo {
  name: string;
  displayName: string;
  uri: string;
  mimeType: string;
  state: string;
  sizeBytes?: string;
  localPath?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface QuizItem {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  timestamp: string;
}

interface FlashcardItem {
  front: string;
  back: string;
  category: string;
  timestamp: string;
}

const PRESET_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (1M Agentic Video - Default)" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Fast)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Deep Reasoning)" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

export default function VideoStudyHubPage() {
  // Settings state
  const [apiKey, setApiKey] = useState<string>("");
  const [serverConnected, setServerConnected] = useState<boolean>(true);
  const [gcpProject, setGcpProject] = useState<string>("Connected");
  const [showKeyInput, setShowKeyInput] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>("gemini-3.8-flash");

  // Video & Upload state
  const [uploadTab, setUploadTab] = useState<"file" | "path" | "recent">("file");
  const [localPathInput, setLocalPathInput] = useState<string>("");
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<UploadedVideoInfo | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recentVideos, setRecentVideos] = useState<UploadedVideoInfo[]>([]);
  const [loadingRecent, setLoadingRecent] = useState<boolean>(false);

  // Player state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(0);

  // Study Workspace Tabs: chat | notes | quiz | flashcards
  const [activeTab, setActiveTab] = useState<"chat" | "notes" | "quiz" | "flashcards">("chat");

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [questionInput, setQuestionInput] = useState<string>("");
  const [isAsking, setIsAsking] = useState<boolean>(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Study Notes state
  const [studyNotes, setStudyNotes] = useState<string>("");
  const [isGeneratingNotes, setIsGeneratingNotes] = useState<boolean>(false);

  // Quiz state
  const [quizItems, setQuizItems] = useState<QuizItem[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({});
  const [isGeneratingQuiz, setIsGeneratingQuiz] = useState<boolean>(false);

  // Flashcards state
  const [flashcards, setFlashcards] = useState<FlashcardItem[]>([]);
  const [flippedCards, setFlippedCards] = useState<Record<number, boolean>>({});
  const [isGeneratingCards, setIsGeneratingCards] = useState<boolean>(false);

  // Load saved API key and check server Vertex AI configuration on mount
  useEffect(() => {
    const savedKey = localStorage.getItem("gemini_study_api_key");
    if (savedKey) setApiKey(savedKey);

    fetch("/api/video/upload")
      .then((r) => r.json())
      .then((data) => {
        if (data.hasServerKey) setServerConnected(true);
        if (data.project) setGcpProject(data.project);
        if (Array.isArray(data.videos) && data.videos.length > 0) {
          setRecentVideos(data.videos);
          const latest = data.videos[data.videos.length - 1];
          setVideoInfo(latest);
          if (latest.localPath) {
            setVideoPreviewUrl(`/api/video/stream?path=${encodeURIComponent(latest.localPath)}`);
          }
          setMessages([
            {
              role: "assistant",
              content: `Ready! Loaded **${latest.displayName}** (Cloud Storage multi-segment Vertex AI pipeline active). Ask any question across the entire lecture, or generate study notes, quizzes, and flashcards!`,
            },
          ]);
        }
      })
      .catch(() => {});
  }, []);

  const saveApiKey = (val: string) => {
    setApiKey(val);
    localStorage.setItem("gemini_study_api_key", val);
  };

  const getHeaders = (extra?: Record<string, string>): HeadersInit => {
    const headers: Record<string, string> = { ...extra };
    if (apiKey.trim()) {
      headers["x-gemini-api-key"] = apiKey.trim();
    }
    return headers;
  };

  // Poll Gemini File API while video state === "PROCESSING"
  useEffect(() => {
    if (!videoInfo || videoInfo.state !== "PROCESSING") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/video/status?name=${encodeURIComponent(videoInfo.name)}`,
          { headers: getHeaders() }
        );
        const data = await res.json();
        if (data.file) {
          setVideoInfo((prev) =>
            prev ? { ...prev, state: data.file.state, uri: data.file.uri || prev.uri } : null
          );
          if (data.file.state === "FAILED") {
            setUploadError("Gemini failed to process this video file.");
          }
        }
      } catch {
        // Ignore transient network poll errors
      }
    }, 3500);

    return () => clearInterval(interval);
  }, [videoInfo, apiKey]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isAsking]);

  const seekToSeconds = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play().catch(() => {});
    }
  };

  // Handle Browser File Selection / Drag & Drop
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    setIsUploading(true);

    // Immediately create a local blob URL so the user can watch the video right away
    const localBlobUrl = URL.createObjectURL(file);
    setVideoPreviewUrl(localBlobUrl);

    try {
      // 1. Fast check if this exact file is already in .local-uploads (0 bytes transferred!)
      const checkRes = await fetch("/api/video/upload", {
        method: "POST",
        headers: getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          checkExistingFile: true,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
        }),
      });
      const checkData = await checkRes.json();

      let uploadedFileObj = checkData.found ? checkData.file : null;

      // 2. If not already on disk, stream binary directly to avoid FormData memory limit on >300MB videos
      if (!uploadedFileObj) {
        const res = await fetch("/api/video/upload", {
          method: "POST",
          headers: getHeaders({
            "Content-Type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
            "x-file-size": String(file.size),
            "x-file-type": file.type || "video/mp4",
          }),
          body: file,
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Upload failed");
        }
        uploadedFileObj = data.file;
      }

      setVideoInfo(uploadedFileObj);
      setMessages([
        {
          role: "assistant",
          content: `Loaded **${uploadedFileObj.displayName}**. ${
            uploadedFileObj.state === "ACTIVE"
              ? "The full video is ready! Ask me anything about the lecture, or generate study notes, quizzes, and flashcards."
              : "Gemini is currently indexing the audio and video frames (usually takes 10–30 seconds). As soon as status turns **ACTIVE**, you can ask questions about the entire video!"
          }`,
        },
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to upload video";
      setUploadError(msg);
    } finally {
      setIsUploading(false);
    }
  };

  // Handle Direct Localhost Disk Path Upload (Zero-copy for large local files)
  const handleLocalPathSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localPathInput.trim()) return;

    setUploadError(null);
    setIsUploading(true);

    const cleanedPath = localPathInput.trim().replace(/^["']|["']$/g, "");
    setVideoPreviewUrl(`/api/video/stream?path=${encodeURIComponent(cleanedPath)}`);

    try {
      const res = await fetch("/api/video/upload", {
        method: "POST",
        headers: getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ localFilePath: cleanedPath }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load local path");
      }

      setVideoInfo(data.file);
      setMessages([
        {
          role: "assistant",
          content: `Linked local disk video **${data.file.displayName}**. ${
            data.file.state === "ACTIVE"
              ? "Ready to answer questions over the entire video!"
              : "Gemini is indexing the full video stream now..."
          }`,
        },
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to upload from local path";
      setUploadError(msg);
    } finally {
      setIsUploading(false);
    }
  };

  // Fetch recently uploaded videos from Gemini File API (cached 48h on Google servers)
  const fetchRecentVideos = async () => {
    setLoadingRecent(true);
    setUploadError(null);
    try {
      const res = await fetch("/api/video/upload", {
        headers: getHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not fetch recent videos");
      setRecentVideos(data.videos || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to list recent videos";
      setUploadError(msg);
    } finally {
      setLoadingRecent(false);
    }
  };

  // Ask a question about the full video (Real-time streaming response!)
  const handleSendQuestion = async (customPrompt?: string) => {
    const promptToSend = (customPrompt ?? questionInput).trim();
    if (!promptToSend || !videoInfo || videoInfo.state !== "ACTIVE" || isAsking) return;

    if (!customPrompt) setQuestionInput("");
    const updatedMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: promptToSend },
      { role: "assistant", content: "" },
    ];
    setMessages(updatedMessages);
    setIsAsking(true);
    setActiveTab("chat");

    try {
      const res = await fetch("/api/video/analyze", {
        method: "POST",
        headers: getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          fileUri: videoInfo.uri,
          mimeType: videoInfo.mimeType,
          model: selectedModel,
          mode: "chat",
          question: promptToSend,
          history: messages,
          stream: true,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to get answer");
      }

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          const currentText = accumulated;
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: "assistant", content: currentText };
            return copy;
          });
        }
      } else {
        const data = await res.json();
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: data.answer };
          return copy;
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error analyzing video";
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "assistant", content: `**Error:** ${msg}` };
        return copy;
      });
    } finally {
      setIsAsking(false);
    }
  };

  // Generate Full Video Study Notes
  const handleGenerateNotes = async () => {
    if (!videoInfo || videoInfo.state !== "ACTIVE" || isGeneratingNotes) return;
    setIsGeneratingNotes(true);
    setActiveTab("notes");
    try {
      const res = await fetch("/api/video/analyze", {
        method: "POST",
        headers: getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          fileUri: videoInfo.uri,
          mimeType: videoInfo.mimeType,
          model: selectedModel,
          mode: "notes",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate study notes");
      setStudyNotes(data.result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error generating notes";
      setStudyNotes(`**Error:** ${msg}`);
    } finally {
      setIsGeneratingNotes(false);
    }
  };

  // Generate Interactive Quiz
  const handleGenerateQuiz = async () => {
    if (!videoInfo || videoInfo.state !== "ACTIVE" || isGeneratingQuiz) return;
    setIsGeneratingQuiz(true);
    setSelectedAnswers({});
    setActiveTab("quiz");
    try {
      const res = await fetch("/api/video/analyze", {
        method: "POST",
        headers: getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          fileUri: videoInfo.uri,
          mimeType: videoInfo.mimeType,
          model: selectedModel,
          mode: "quiz",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate quiz");
      setQuizItems(Array.isArray(data.quiz) ? data.quiz : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error generating quiz";
      setUploadError(msg);
    } finally {
      setIsGeneratingQuiz(false);
    }
  };

  // Generate Flashcards
  const handleGenerateFlashcards = async () => {
    if (!videoInfo || videoInfo.state !== "ACTIVE" || isGeneratingCards) return;
    setIsGeneratingCards(true);
    setFlippedCards({});
    setActiveTab("flashcards");
    try {
      const res = await fetch("/api/video/analyze", {
        method: "POST",
        headers: getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          fileUri: videoInfo.uri,
          mimeType: videoInfo.mimeType,
          model: selectedModel,
          mode: "flashcards",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate flashcards");
      setFlashcards(Array.isArray(data.flashcards) ? data.flashcards : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error generating flashcards";
      setUploadError(msg);
    } finally {
      setIsGeneratingCards(false);
    }
  };

  const isVideoReady = videoInfo?.state === "ACTIVE";

  return (
    <div className="min-h-screen flex flex-col bg-[#090d16] text-slate-100">
      {/* Top Navigation & Configuration Header */}
      <header className="border-b border-slate-800/80 bg-slate-950/70 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Video className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base sm:text-lg tracking-tight text-white">
                  Gemini Video Study Hub
                </h1>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Localhost Full-Video Context
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Load local lecture videos &bull; Ask questions with clickable timestamps &bull; Notes, Quiz &amp; Flashcards
              </p>
            </div>
          </div>

          {/* Model Selector & API Key Bar */}
          <div className="flex items-center gap-2.5">
            <div className="hidden md:flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5">
              <Cpu className="w-4 h-4 text-indigo-400" />
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-transparent text-xs text-slate-200 font-medium focus:outline-none cursor-pointer"
              >
                {PRESET_MODELS.map((m) => (
                  <option key={m.id} value={m.id} className="bg-slate-900 text-slate-100">
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => setShowKeyInput((prev) => !prev)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer ${
                apiKey || serverConnected
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                  : "bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800"
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              {apiKey
                ? "Custom Key Active"
                : serverConnected
                ? `Vertex AI (${gcpProject})`
                : "Set API Key"}
            </button>
          </div>
        </div>

        {/* Collapsible API Key Banner */}
        {showKeyInput && (
          <div className="border-t border-slate-800/80 bg-slate-900/90 px-4 sm:px-6 py-3">
            <div className="max-w-[1600px] mx-auto flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="text-xs text-slate-300">
                Enter your{" "}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 underline hover:text-indigo-300"
                >
                  Google AI Studio API Key
                </a>{" "}
                (stored locally in your browser or read automatically from <code className="text-indigo-300">.env.local</code>):
              </div>
              <div className="flex items-center gap-2 flex-1 max-w-md">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => saveApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKeyInput(false)}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium cursor-pointer"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Main Split Workspace */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: Video Loader, Player & Quick Actions (5 cols on lg) */}
        <section className="lg:col-span-5 flex flex-col gap-4">
          {/* Local Video Source Selector Card */}
          <div className="bg-slate-900/70 border border-slate-800/90 rounded-2xl p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                1. Select Local Study Video
              </span>
              <div className="flex rounded-lg bg-slate-950 p-0.5 border border-slate-800 text-xs">
                <button
                  type="button"
                  onClick={() => setUploadTab("file")}
                  className={`px-2.5 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 ${
                    uploadTab === "file"
                      ? "bg-indigo-600 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Upload className="w-3 h-3" />
                  Pick File
                </button>
                <button
                  type="button"
                  onClick={() => setUploadTab("path")}
                  className={`px-2.5 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 ${
                    uploadTab === "path"
                      ? "bg-indigo-600 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <FolderOpen className="w-3 h-3" />
                  Local Disk Path
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUploadTab("recent");
                    fetchRecentVideos();
                  }}
                  className={`px-2.5 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 ${
                    uploadTab === "recent"
                      ? "bg-indigo-600 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <History className="w-3 h-3" />
                  Cached (48h)
                </button>
              </div>
            </div>

            {/* Tab 1: Browser File Picker */}
            {uploadTab === "file" && (
              <label className="group flex flex-col items-center justify-center border-2 border-dashed border-slate-700 hover:border-indigo-500/70 rounded-xl p-5 bg-slate-950/50 hover:bg-indigo-950/10 transition cursor-pointer text-center">
                <Upload className="w-7 h-7 text-indigo-400 group-hover:scale-110 transition mb-2" />
                <span className="text-sm font-medium text-slate-200">
                  Click to choose a local video file (.mp4, .mkv, .webm, .mov)
                </span>
                <span className="text-xs text-slate-400 mt-1">
                  Plays immediately in browser while syncing full video to Gemini File API
                </span>
                <input
                  type="file"
                  accept="video/*"
                  onChange={handleFileChange}
                  disabled={isUploading}
                  className="hidden"
                />
              </label>
            )}

            {/* Tab 2: Direct Localhost File Path (Zero-Copy) */}
            {uploadTab === "path" && (
              <form onSubmit={handleLocalPathSubmit} className="space-y-2.5">
                <p className="text-xs text-slate-400">
                  Since this app runs on <code className="text-indigo-300">localhost</code>, you can paste the full path to any video on your PC (ideal for large 500MB–5GB lecture recordings):
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={localPathInput}
                    onChange={(e) => setLocalPathInput(e.target.value)}
                    placeholder="e.g. D:\Lectures\Module1_Algorithms.mp4"
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="submit"
                    disabled={isUploading || !localPathInput.trim()}
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold transition cursor-pointer shrink-0"
                  >
                    Load Video
                  </button>
                </div>
              </form>
            )}

            {/* Tab 3: Previously Uploaded Videos (Cached 48h in Gemini File API) */}
            {uploadTab === "recent" && (
              <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                {loadingRecent ? (
                  <div className="flex items-center justify-center py-6 text-xs text-slate-400 gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                    Checking your Gemini File API cache...
                  </div>
                ) : recentVideos.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4 text-center">
                    No cached videos found in your Gemini account yet. Upload one first!
                  </p>
                ) : (
                  recentVideos.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      onClick={() => {
                        setVideoInfo(v);
                        if (v.localPath) {
                          setVideoPreviewUrl(
                            `/api/video/stream?path=${encodeURIComponent(v.localPath)}`
                          );
                        }
                        setMessages([
                          {
                            role: "assistant",
                            content: `Re-connected cached video **${v.displayName}** (${v.state}). You can immediately ask questions or generate study materials without re-uploading!`,
                          },
                        ]);
                      }}
                      className={`w-full text-left p-2.5 rounded-xl border text-xs flex items-center justify-between transition cursor-pointer ${
                        videoInfo?.name === v.name
                          ? "bg-indigo-600/20 border-indigo-500 text-white"
                          : "bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700"
                      }`}
                    >
                      <div className="truncate pr-2">
                        <div className="font-medium truncate">{v.displayName}</div>
                        <div className="text-[11px] text-slate-400">{v.name}</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shrink-0">
                        {v.state}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Upload / Processing Status Banner */}
            {(isUploading || videoInfo || uploadError) && (
              <div className="mt-3 pt-3 border-t border-slate-800/80">
                {uploadError && (
                  <div className="flex items-start gap-2 p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span>{uploadError}</span>
                  </div>
                )}

                {isUploading && (
                  <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-200 text-xs">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400 shrink-0" />
                    <span>Uploading local video to Gemini File API...</span>
                  </div>
                )}

                {!isUploading && videoInfo && (
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      {videoInfo.state === "ACTIVE" ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                      )}
                      <div className="truncate">
                        <span className="font-medium text-white truncate">
                          {videoInfo.displayName}
                        </span>
                        <span className="text-slate-400 ml-2">
                          {videoInfo.state === "ACTIVE"
                            ? "Ready for full-video Q&A"
                            : "Indexing video frames & audio..."}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-md font-mono text-[10px] font-semibold uppercase shrink-0 ${
                        videoInfo.state === "ACTIVE"
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                      }`}
                    >
                      {videoInfo.state}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Video Player Card */}
          <div className="bg-slate-900/70 border border-slate-800/90 rounded-2xl overflow-hidden shadow-xl flex flex-col">
            <div className="aspect-video bg-black relative flex items-center justify-center">
              {videoPreviewUrl ? (
                <video
                  ref={videoRef}
                  src={videoPreviewUrl}
                  controls
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="text-center p-6 text-slate-500">
                  <Video className="w-12 h-12 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">
                    Your local video will play here. Clicking any <code className="text-indigo-400">[MM:SS]</code> timestamp in Gemini&apos;s answers will jump this player directly to that moment.
                  </p>
                </div>
              )}
            </div>

            {/* Player Footer: Current Time & Quick Study Prompts */}
            <div className="p-3.5 bg-slate-950/80 border-t border-slate-800/80 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-slate-300 font-mono">
                  <Clock className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Current Playback: {formatSeconds(currentTime)}</span>
                </div>
                <button
                  type="button"
                  disabled={!isVideoReady || isAsking}
                  onClick={() =>
                    handleSendQuestion(
                      `Explain in detail what is being taught and shown on screen around [${formatSeconds(
                        currentTime
                      )}].`
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-600/25 hover:bg-indigo-600/40 disabled:opacity-40 text-indigo-200 border border-indigo-500/40 font-medium transition cursor-pointer"
                >
                  <Sparkles className="w-3 h-3 text-indigo-400" />
                  Ask about [{formatSeconds(currentTime)}]
                </button>
              </div>

              {/* 1-Click Study Action Generators */}
              <div className="grid grid-cols-3 gap-2 pt-1">
                <button
                  type="button"
                  disabled={!isVideoReady || isGeneratingNotes}
                  onClick={handleGenerateNotes}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-40 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                >
                  <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                  Study Notes
                </button>
                <button
                  type="button"
                  disabled={!isVideoReady || isGeneratingQuiz}
                  onClick={handleGenerateQuiz}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-40 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
                  Take Quiz
                </button>
                <button
                  type="button"
                  disabled={!isVideoReady || isGeneratingCards}
                  onClick={handleGenerateFlashcards}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-40 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5 text-violet-400" />
                  Flashcards
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Study Assistant Tabs (Chat, Notes, Quiz, Flashcards) (7 cols on lg) */}
        <section className="lg:col-span-7 bg-slate-900/70 border border-slate-800/90 rounded-2xl shadow-xl flex flex-col h-[calc(100vh-7.5rem)] min-h-[580px] overflow-hidden">
          {/* Mode Switcher Header */}
          <div className="flex items-center justify-between px-4 pt-3 border-b border-slate-800 bg-slate-950/60">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setActiveTab("chat")}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
                  activeTab === "chat"
                    ? "border-indigo-500 text-white bg-indigo-500/10 rounded-t-lg"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
                Video Q&amp;A Chat
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("notes")}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
                  activeTab === "notes"
                    ? "border-emerald-500 text-white bg-emerald-500/10 rounded-t-lg"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                Timestamped Notes
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("quiz")}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
                  activeTab === "quiz"
                    ? "border-amber-500 text-white bg-amber-500/10 rounded-t-lg"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
                Practice Quiz
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("flashcards")}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
                  activeTab === "flashcards"
                    ? "border-violet-500 text-white bg-violet-500/10 rounded-t-lg"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                <Layers className="w-3.5 h-3.5 text-violet-400" />
                Flashcards
              </button>
            </div>
          </div>

          {/* TAB 1: VIDEO Q&A CHAT */}
          {activeTab === "chat" && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto py-12">
                    <div className="w-12 h-12 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center mb-3">
                      <Sparkles className="w-6 h-6 text-indigo-400" />
                    </div>
                    <h3 className="text-base font-bold text-white mb-1">
                      Full-Video Study Tutor
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed mb-5">
                      Upload a lecture video or provide its local file path on the left. Gemini will inspect both the visual frames (slides, whiteboard, code) and spoken audio across the entire video.
                    </p>
                    <div className="w-full space-y-2 text-left">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                        Example study prompts once loaded:
                      </div>
                      {[
                        "Break down this lecture into chapters with [MM:SS] timestamps.",
                        "Transcribe and explain all formulas or code shown on the screen.",
                        "What are the 5 most likely exam questions from this video?",
                      ].map((sample, i) => (
                        <button
                          key={i}
                          type="button"
                          disabled={!isVideoReady}
                          onClick={() => handleSendQuestion(sample)}
                          className="w-full text-left px-3 py-2 rounded-xl bg-slate-950/70 hover:bg-slate-800/80 disabled:opacity-50 border border-slate-800 text-xs text-slate-300 transition cursor-pointer"
                        >
                          &ldquo;{sample}&rdquo;
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`flex ${
                        msg.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      <div
                        className={`max-w-[88%] rounded-2xl px-4 py-3 ${
                          msg.role === "user"
                            ? "bg-indigo-600 text-white text-sm"
                            : "bg-slate-950/90 border border-slate-800 text-slate-200"
                        }`}
                      >
                        {msg.role === "user" ? (
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        ) : (
                          <FormattedStudyText
                            text={msg.content}
                            onSeek={seekToSeconds}
                          />
                        )}
                      </div>
                    </div>
                  ))
                )}

                {isAsking && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl px-4 py-3 bg-slate-950/90 border border-slate-800 flex items-center gap-2.5 text-xs text-slate-300">
                      <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                      Analyzing video frames &amp; audio to answer your question...
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Chat Input Bar */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendQuestion();
                }}
                className="p-3.5 bg-slate-950/80 border-t border-slate-800 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={questionInput}
                  onChange={(e) => setQuestionInput(e.target.value)}
                  disabled={!isVideoReady || isAsking}
                  placeholder={
                    isVideoReady
                      ? "Ask any question about the video (e.g., 'Explain the diagram at 04:10' or 'Summarize key points')..."
                      : "Upload and wait for video status ACTIVE to ask questions..."
                  }
                  className="flex-1 bg-slate-900 border border-slate-700/80 rounded-xl px-4 py-2.5 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!isVideoReady || isAsking || !questionInput.trim()}
                  className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  Ask
                </button>
              </form>
            </div>
          )}

          {/* TAB 2: TIMESTAMPED STUDY NOTES */}
          {activeTab === "notes" && (
            <div className="flex-1 overflow-y-auto p-5">
              {isGeneratingNotes ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-16">
                  <Loader2 className="w-8 h-8 animate-spin text-emerald-400 mb-3" />
                  <p className="text-sm font-medium text-white">
                    Generating Comprehensive Study Notes...
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    Extracting chapters, definitions, formulas, and [MM:SS] timestamps across the full video.
                  </p>
                </div>
              ) : studyNotes ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <h3 className="text-sm font-bold text-emerald-300 flex items-center gap-2">
                      <BookOpen className="w-4 h-4" />
                      Structured Lecture Notes (Click any timestamp to jump)
                    </h3>
                    <button
                      type="button"
                      onClick={handleGenerateNotes}
                      className="text-xs text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Regenerate
                    </button>
                  </div>
                  <FormattedStudyText text={studyNotes} onSeek={seekToSeconds} />
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center py-16">
                  <BookOpen className="w-10 h-10 text-emerald-400/50 mb-3" />
                  <h3 className="text-sm font-bold text-white mb-1">
                    No Study Notes Generated Yet
                  </h3>
                  <p className="text-xs text-slate-400 max-w-sm mb-4">
                    Generate a complete chapter outline, key definitions, and revision checklist from your video with clickable timestamps.
                  </p>
                  <button
                    type="button"
                    disabled={!isVideoReady}
                    onClick={handleGenerateNotes}
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold transition cursor-pointer"
                  >
                    Generate Full-Video Study Notes
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: INTERACTIVE QUIZ */}
          {activeTab === "quiz" && (
            <div className="flex-1 overflow-y-auto p-5">
              {isGeneratingQuiz ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-16">
                  <Loader2 className="w-8 h-8 animate-spin text-amber-400 mb-3" />
                  <p className="text-sm font-medium text-white">
                    Creating Practice Quiz from Video...
                  </p>
                </div>
              ) : quizItems.length > 0 ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div>
                      <h3 className="text-sm font-bold text-amber-300">
                        Interactive Video Comprehension Quiz
                      </h3>
                      <p className="text-xs text-slate-400">
                        Score:{" "}
                        {
                          quizItems.filter(
                            (q, idx) => selectedAnswers[idx] === q.correctIndex
                          ).length
                        }{" "}
                        / {quizItems.length} answered correctly
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleGenerateQuiz}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      New Quiz
                    </button>
                  </div>

                  {quizItems.map((item, qIdx) => {
                    const userChoice = selectedAnswers[qIdx];
                    const hasAnswered = userChoice !== undefined;

                    return (
                      <div
                        key={qIdx}
                        className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <h4 className="text-sm font-semibold text-white">
                            {qIdx + 1}. {item.question}
                          </h4>
                          {item.timestamp && (
                            <button
                              type="button"
                              onClick={() =>
                                seekToSeconds(parseTimestampToSeconds(item.timestamp))
                              }
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/35 shrink-0 cursor-pointer"
                            >
                              <Play className="w-2.5 h-2.5 fill-current" />
                              {item.timestamp.replace(/[\[\]]/g, "")}
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-1 gap-2">
                          {item.options.map((opt, oIdx) => {
                            const isSelected = userChoice === oIdx;
                            const isCorrect = item.correctIndex === oIdx;

                            let btnStyle =
                              "bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700";
                            if (hasAnswered) {
                              if (isCorrect) {
                                btnStyle =
                                  "bg-emerald-500/20 border-emerald-500/50 text-emerald-200";
                              } else if (isSelected) {
                                btnStyle =
                                  "bg-rose-500/20 border-rose-500/50 text-rose-200";
                              }
                            }

                            return (
                              <button
                                key={oIdx}
                                type="button"
                                disabled={hasAnswered}
                                onClick={() =>
                                  setSelectedAnswers((prev) => ({
                                    ...prev,
                                    [qIdx]: oIdx,
                                  }))
                                }
                                className={`text-left px-3.5 py-2.5 rounded-xl border text-xs font-medium transition cursor-pointer ${btnStyle}`}
                              >
                                {opt}
                              </button>
                            );
                          })}
                        </div>

                        {hasAnswered && (
                          <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 text-xs text-slate-300">
                            <span className="font-semibold text-white">Explanation: </span>
                            {item.explanation}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center py-16">
                  <HelpCircle className="w-10 h-10 text-amber-400/50 mb-3" />
                  <h3 className="text-sm font-bold text-white mb-1">
                    Test Your Understanding
                  </h3>
                  <p className="text-xs text-slate-400 max-w-sm mb-4">
                    Generate a 5-question multiple-choice quiz directly from the video lecture, complete with explanations and timestamp links.
                  </p>
                  <button
                    type="button"
                    disabled={!isVideoReady}
                    onClick={handleGenerateQuiz}
                    className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs font-semibold transition cursor-pointer"
                  >
                    Generate Practice Quiz
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: FLASHCARDS */}
          {activeTab === "flashcards" && (
            <div className="flex-1 overflow-y-auto p-5">
              {isGeneratingCards ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-16">
                  <Loader2 className="w-8 h-8 animate-spin text-violet-400 mb-3" />
                  <p className="text-sm font-medium text-white">
                    Generating Active-Recall Flashcards...
                  </p>
                </div>
              ) : flashcards.length > 0 ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div>
                      <h3 className="text-sm font-bold text-violet-300">
                        Active-Recall Flashcards (Click any card to flip)
                      </h3>
                      <p className="text-xs text-slate-400">
                        {flashcards.length} key concepts extracted from the video
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleGenerateFlashcards}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Regenerate
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    {flashcards.map((card, idx) => {
                      const isFlipped = !!flippedCards[idx];
                      return (
                        <div
                          key={idx}
                          onClick={() =>
                            setFlippedCards((prev) => ({
                              ...prev,
                              [idx]: !prev[idx],
                            }))
                          }
                          className={`p-4 rounded-2xl border transition cursor-pointer min-h-[160px] flex flex-col justify-between ${
                            isFlipped
                              ? "bg-violet-950/30 border-violet-500/50"
                              : "bg-slate-950/80 border-slate-800 hover:border-slate-700"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="px-2 py-0.5 rounded-md bg-slate-900 text-slate-400 border border-slate-800 truncate">
                              {card.category || "Concept"}
                            </span>
                            {card.timestamp && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  seekToSeconds(parseTimestampToSeconds(card.timestamp));
                                }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/35 cursor-pointer"
                              >
                                <Play className="w-2.5 h-2.5 fill-current" />
                                {card.timestamp.replace(/[\[\]]/g, "")}
                              </button>
                            )}
                          </div>

                          <div className="my-3">
                            <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
                              {isFlipped ? "Answer / Definition" : "Question / Term"}
                            </div>
                            <p className="text-xs sm:text-sm font-medium text-white leading-relaxed">
                              {isFlipped ? card.back : card.front}
                            </p>
                          </div>

                          <div className="text-[11px] text-violet-400 font-medium">
                            {isFlipped ? "Click to see question" : "Click to reveal answer"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center py-16">
                  <Layers className="w-10 h-10 text-violet-400/50 mb-3" />
                  <h3 className="text-sm font-bold text-white mb-1">
                    Study with Active-Recall Flashcards
                  </h3>
                  <p className="text-xs text-slate-400 max-w-sm mb-4">
                    Extract key definitions, formulas, and concepts from the video into interactive flip-cards linked to video timestamps.
                  </p>
                  <button
                    type="button"
                    disabled={!isVideoReady}
                    onClick={handleGenerateFlashcards}
                    className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-semibold transition cursor-pointer"
                  >
                    Generate Flashcards
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
