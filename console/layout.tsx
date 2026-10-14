import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "חדר-הישיבות הריבוני — R344",
  description: "קונסולת חדר-הישיבות הריבוני למסחר — קבינט סוכנים, דיון, שער-סיכון ופנקס חתום. נייר בלבד, אפס מפתחות, כל נתוני-השוק סימולציה מתויגת.",
  keywords: ["Z.ai", "Next.js", "TypeScript", "Tailwind CSS", "shadcn/ui", "AI development", "React"],
  authors: [{ name: "Z.ai Team" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "פנקס הוודאות — ריבונות מאומתת",
    description: "אימות עצמאי דו-שלבי של כל טענה מרכזית מול GitHub API חי",
    url: "https://chat.z.ai",
    siteName: "Z.ai",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "פנקס הוודאות — ריבונות מאומתת",
    description: "אימות עצמאי דו-שלבי של כל טענה מרכזית מול GitHub API חי",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
