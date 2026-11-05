import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Keymeter · RunningHub allowance checker',
  description:
    'Check the limit, usage and remaining allowance of your individual RunningHub Enterprise-Shared key.',
  robots: { index: false, follow: false },
  icons: {
    icon: '/mark.svg',
    shortcut: '/mark.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
