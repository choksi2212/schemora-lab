import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '@/components/shell';

export const metadata: Metadata = {
  title: { default: 'Schemora — Your hardware, understood', template: '%s · Schemora' },
  description:
    'Turn your hardware conversations into a clear, source-backed design you can review.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
