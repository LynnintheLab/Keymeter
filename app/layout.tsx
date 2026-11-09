import type { Metadata } from 'next';
import './globals.css';

const title = 'Keymeter · RunningHub allowance checker';
const description =
  'Check the limit, usage and remaining allowance of your individual RunningHub Enterprise-Shared key.';
const previewImage = { url: '/og.jpg', width: 1200, height: 630, type: 'image/jpeg', alt: 'Keymeter: check your RunningHub key balance' };

// Link previews need absolute image URLs, so resolve them against the configured site address.
// Static metadata keeps every tag in <head>, which some preview robots require.
function siteOrigin() {
  try { return new URL(typeof process === 'undefined' ? '' : process.env.APP_URL ?? ''); }
  catch { return undefined; }
}

export const metadata: Metadata = {
  metadataBase: siteOrigin(),
  title,
  description,
  robots: { index: false, follow: false },
  icons: {
    icon: '/mark.svg',
    shortcut: '/mark.svg',
  },
  openGraph: { type: 'website', siteName: 'Keymeter', url: '/', title, description, images: [previewImage] },
  twitter: { card: 'summary_large_image', title, description, images: [previewImage] },
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
