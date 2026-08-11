import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "agentsession",
  title: { default: "agentsession", template: "%s · agentsession" },
  description: "View a local Codex session with a clean transcript interface. Processed entirely in your browser — nothing is uploaded.",
  openGraph: {
    title: "agentsession",
    description: "View a local Codex session with a clean transcript interface.",
    siteName: "agentsession",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "agentsession",
    description: "View a local Codex session with a clean transcript interface.",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
