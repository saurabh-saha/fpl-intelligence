import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "FPL Intelligence",
  description: "Data-driven Fantasy Premier League squad builder: expected points, optimised squads, explainable picks.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto w-full max-w-7xl px-3 pb-16 pt-4 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
