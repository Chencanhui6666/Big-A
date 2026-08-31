import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Big A Radar · 个人A股热点量化看板',
  description: '结合实时事件、历史数据和盘面确认的A股热点发现工作台。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
