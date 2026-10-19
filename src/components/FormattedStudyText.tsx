"use client";

import React from "react";
import { Play } from "lucide-react";

interface FormattedStudyTextProps {
  text: string;
  onSeek: (seconds: number) => void;
}

export function parseTimestampToSeconds(ts: string): number {
  const cleaned = ts.replace(/[\[\]]/g, "").trim();
  const parts = cleaned.split(":").map((n) => parseInt(n, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

export function formatSeconds(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function FormattedStudyText({ text, onSeek }: FormattedStudyTextProps) {
  const renderInlineWithTimestamps = (line: string, lineKey: string) => {
    // Match [MM:SS], [MMM:SS], [HH:MM:SS], or standalone timestamps
    const regex = /(\[\d{1,3}:\d{2}(?::\d{2})?\]|\b\d{1,3}:\d{2}(?::\d{2})?\b)/g;
    const segments = line.split(regex);

    return segments.map((segment, idx) => {
      if (/^(\[\d{1,3}:\d{2}(?::\d{2})?\]|\d{1,3}:\d{2}(?::\d{2})?)$/.test(segment)) {
        const seconds = parseTimestampToSeconds(segment);
        const label = formatSeconds(seconds);
        return (
          <button
            key={`${lineKey}-ts-${idx}`}
            type="button"
            onClick={() => onSeek(seconds)}
            title={`Jump video to ${label}`}
            className="inline-flex items-center gap-1 mx-1 px-2 py-0.5 rounded-md text-xs font-mono font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/35 hover:text-white transition cursor-pointer align-baseline"
          >
            <Play className="w-2.5 h-2.5 fill-current" />
            {label}
          </button>
        );
      }

      // Render bold **text**
      const boldSegments = segment.split(/(\*\*.*?\*\*)/g);
      return boldSegments.map((bSeg, bIdx) => {
        if (bSeg.startsWith("**") && bSeg.endsWith("**")) {
          return (
            <strong key={`${lineKey}-b-${idx}-${bIdx}`} className="font-semibold text-white">
              {bSeg.slice(2, -2)}
            </strong>
          );
        }
        return <React.Fragment key={`${lineKey}-t-${idx}-${bIdx}`}>{bSeg}</React.Fragment>;
        });
        });
        };

        const lines = text.split(String.fromCharCode(10));

        return (
        <div className="space-y-2 text-sm leading-relaxed text-slate-200">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={i} className="h-1.5" />;
        }
        if (trimmed.startsWith("### ")) {
          return (
            <h4 key={i} className="text-base font-bold text-indigo-300 pt-2">
              {renderInlineWithTimestamps(trimmed.slice(4), `h4-${i}`)}
            </h4>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={i} className="text-lg font-bold text-white pt-3 border-b border-slate-800 pb-1">
              {renderInlineWithTimestamps(trimmed.slice(3), `h3-${i}`)}
            </h3>
          );
        }
        if (trimmed.startsWith("# ")) {
          return (
            <h2 key={i} className="text-xl font-bold text-white pt-3">
              {renderInlineWithTimestamps(trimmed.slice(2), `h2-${i}`)}
            </h2>
          );
        }
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div key={i} className="flex items-start gap-2 pl-2">
              <span className="text-indigo-400 mt-1.5 text-xs">•</span>
              <div className="flex-1">{renderInlineWithTimestamps(trimmed.slice(2), `li-${i}`)}</div>
            </div>
          );
        }
        return <p key={i}>{renderInlineWithTimestamps(line, `p-${i}`)}</p>;
      })}
    </div>
  );
}
