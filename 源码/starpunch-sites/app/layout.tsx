import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "星光打卡",
  description: "员工电脑打卡与云端管理",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
