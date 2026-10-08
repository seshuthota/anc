import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Self-hosted from node_modules at build time: no font CDN at runtime.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "DemoCo Parcel Network",
  description: "A morning briefing on the parcel network, put together by specialist agents from the company's own records.",
};

export const viewport: Viewport = { colorScheme: "dark", themeColor: "#09090b" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
