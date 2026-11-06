"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

function inline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`"))
      return (
        <code key={i} className="rounded bg-[#0a1420] px-1 py-0.5 text-[11px] text-[#7fd8ff]">
          {p.slice(1, -1)}
        </code>
      );
    if (p.startsWith("**") && p.endsWith("**"))
      return (
        <strong key={i} className="text-[#eafcff]">
          {p.slice(2, -2)}
        </strong>
      );
    return <span key={i}>{p}</span>;
  });
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-[#4a6376]">
        <span>{lang || "code"}</span>
        <button
          className="flex items-center gap-1 hover:text-[#7fd8ff]"
          onClick={() => {
            navigator.clipboard.writeText(code).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />} copy
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words">{code}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const segments = text.split(/```/);
  return (
    <div className="leading-relaxed">
      {segments.map((seg, i) => {
        if (i % 2 === 1) {
          const nl = seg.indexOf("\n");
          const lang = nl > 0 && nl < 16 ? seg.slice(0, nl).trim() : "";
          const code = nl > 0 && nl < 16 ? seg.slice(nl + 1) : seg;
          return <CodeBlock key={i} code={code.replace(/\n$/, "")} lang={lang} />;
        }
        return (
          <span key={i}>
            {seg.split("\n").map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(line)}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}
