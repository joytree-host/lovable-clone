import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lovable Clone - AI-Powered Code Generation",
  description: "Build applications faster with AI-powered code generation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
