import type { SimpleFractalResult } from './simple-strategy';
import type { ClosedCandle } from './indicator';
export interface ChartSeries {
  higherMinutes: number;
  lowerMinutes: number;
  higher: ClosedCandle[];
  lower: ClosedCandle[];
}
export interface DashboardData {
  connected: boolean;
  configured: boolean;
  instrument: { name: string; symbol: string; exchange: string };
  setups: SimpleFractalResult[];
  charts: ChartSeries[];
  quote: { price: number; sessionOpen: number | null } | null;
  fetchedAt: number | null;
  lastCandleAt: number | null;
  marketOpen: boolean;
  provider: 'yahoo';
  delayed: true;
  dataAsOf: number | null;
  dataAgeSeconds: number | null;
  error?: { code: string; message: string };
  stale: boolean;
}
