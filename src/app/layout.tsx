import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jb = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb" });

export const metadata: Metadata = {
  title: "J+ROCK — Agentic Trading Console",
  description:
    "Full agentic assistant with function calling, soul persona, self-review and a Bitunix futures trading engine.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${jb.variable} antialiased`}>{children}</body>
    </html>
  );
}
