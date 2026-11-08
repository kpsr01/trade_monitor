import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'C2 Fractal · Setup monitor',
  description: 'A free, delayed index monitor for C2 liquidity sweeps and CISD across three timeframes. Historical reference levels and manual NSE options-chain access. Observation only.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
