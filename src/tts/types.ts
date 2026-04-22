import type { Logger } from '../common/types.js';

export type FishAudioFormat = 'pcm' | 'mp3' | 'wav' | 'opus';
export type FishAudioModel = 's1' | 's2' | 's2-pro';
export type FishAudioLatency = 'balanced' | 'normal';

export interface TTSClientOptions {
  apiKey: string;
  referenceId?: string;
  model?: FishAudioModel;
  baseUrl?: string;
  format?: FishAudioFormat;
  sampleRate?: number;
  latency?: FishAudioLatency;
  chunkLength?: number;
  temperature?: number;
  topP?: number;
  normalize?: boolean;
  conditionOnPreviousChunks?: boolean;
  connectTimeoutMs?: number;
  logger?: Logger;
}

export interface StreamOptions {
  signal?: AbortSignal;
  referenceId?: string;
}

export interface AudioChunk {
  data: ArrayBuffer;
  sequence: number;
  sizeBytes: number;
  timestamp: number;
}
