import type { Metadata } from "next";
import { DM_Sans, Sora } from "next/font/google";

import TopNav from "@/app/components/top-nav";

import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "FriedVision",
  description: "Real-time fast-food queue analytics and production recommendations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${dmSans.variable} ${sora.variable}`}>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
