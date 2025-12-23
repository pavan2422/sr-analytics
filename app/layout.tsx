import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SR Analytics Dashboard',
  description: 'Production-grade Success Rate Analytics Dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}


