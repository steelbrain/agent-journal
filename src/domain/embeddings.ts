import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { modelCacheDir } from './paths.js';

export interface Embeddings {
  warmup(): void;
  ready(): Promise<void>;
  embedQuery(text: string): Promise<Float32Array>;
  embedDocument(text: string): Promise<Float32Array>;
  modelId(): string;
  dim(): number;
  contentHash(documentText: string): string;
}

const HUB_MODEL_ID = 'Xenova/bge-small-en-v1.5';
const STORED_MODEL_ID = 'bge-small-en-v1.5';
const DIM = 384;
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

type FeatureExtractor = (text: string, options: { pooling: 'cls'; normalize: true }) => Promise<{ data: Float32Array }>;

// Signatures of a truncated/corrupt model file, distinct from network or
// other load failures (which we must not "recover" from by deleting files).
const CORRUPT_MODEL_PATTERNS = [
  /protobuf parsing failed/i,
  /load model from .* failed/i,
  /failed to load model/i,
  /deserialize tensor/i,
  /invalid model/i,
  /unexpected end/i,
];

function isCorruptModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return CORRUPT_MODEL_PATTERNS.some((pattern) => pattern.test(message));
}

export class TransformersEmbeddings implements Embeddings {
  private loadPromise: Promise<FeatureExtractor> | null = null;
  private readonly cacheDir: string;

  constructor() {
    this.cacheDir = modelCacheDir();
    fs.mkdirSync(this.cacheDir, { recursive: true });
    env.cacheDir = this.cacheDir;
    env.allowLocalModels = false;
  }

  warmup(): void {
    // Run a real embed, not just a model load, so the one-time graph
    // initialization happens here in the background instead of on the first
    // insert in the request path.
    void this.embedDocument('warmup').catch((err) => {
      console.error('agent-journal embedding warmup failed:', err);
    });
  }

  async ready(): Promise<void> {
    await this.load();
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embed(`${QUERY_PREFIX}${text}`);
  }

  async embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  modelId(): string {
    return STORED_MODEL_ID;
  }

  dim(): number {
    return DIM;
  }

  contentHash(documentText: string): string {
    return crypto.createHash('sha256').update(`${STORED_MODEL_ID}\n${documentText}`).digest('hex');
  }

  private load(): Promise<FeatureExtractor> {
    if (!this.loadPromise) {
      const attempt = this.loadWithRecovery();
      // Reset on failure so a later call can retry instead of caching a
      // permanently-rejected promise.
      attempt.catch(() => {
        if (this.loadPromise === attempt) this.loadPromise = null;
      });
      this.loadPromise = attempt;
    }
    return this.loadPromise;
  }

  private async loadWithRecovery(): Promise<FeatureExtractor> {
    try {
      return await this.loadPipeline();
    } catch (err) {
      if (!isCorruptModelError(err)) throw err;
      // transformers.js streams downloads straight to their final cache path
      // and only cleans up on a caught error — a process killed mid-download
      // (e.g. Ctrl-C) leaves an unverified, partial model file behind that
      // fails to parse on the next boot. Wipe the cached model and re-download.
      console.error('agent-journal: cached model appears corrupt; re-downloading.', err);
      this.purgeModelCache();
      return await this.loadPipeline();
    }
  }

  private loadPipeline(): Promise<FeatureExtractor> {
    const loadPipeline = pipeline as unknown as (
      task: 'feature-extraction',
      model: string,
      options: { dtype: 'q8' },
    ) => Promise<FeatureExtractor>;
    // q8 quantization loads ~4x faster than the default fp32 and halves
    // long-text embedding time, with negligible quality loss for this model.
    return loadPipeline('feature-extraction', HUB_MODEL_ID, { dtype: 'q8' });
  }

  private purgeModelCache(): void {
    const modelDir = path.join(this.cacheDir, ...HUB_MODEL_ID.split('/'));
    fs.rmSync(modelDir, { recursive: true, force: true });
  }

  private async embed(text: string): Promise<Float32Array> {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: 'cls', normalize: true });
    if (output.data.length !== DIM) {
      throw new Error(`Embedding model returned ${output.data.length} dimensions, expected ${DIM}`);
    }
    return output.data;
  }
}

export class HashEmbeddings implements Embeddings {
  warmup(): void {}

  async ready(): Promise<void> {}

  async embedQuery(text: string): Promise<Float32Array> {
    return this.makeVector(`${QUERY_PREFIX}${text}`);
  }

  async embedDocument(text: string): Promise<Float32Array> {
    return this.makeVector(text);
  }

  modelId(): string {
    return STORED_MODEL_ID;
  }

  dim(): number {
    return DIM;
  }

  contentHash(documentText: string): string {
    return crypto.createHash('sha256').update(`${STORED_MODEL_ID}\n${documentText}`).digest('hex');
  }

  private makeVector(text: string): Float32Array {
    const vec = new Float32Array(DIM);
    let offset = 0;
    while (offset < DIM) {
      const hash = crypto.createHash('sha256').update(`${text}\n${offset}`).digest();
      for (const byte of hash) {
        if (offset >= DIM) break;
        vec[offset] = byte / 255 - 0.5;
        offset += 1;
      }
    }

    let norm = 0;
    for (const value of vec) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
    return vec;
  }
}
