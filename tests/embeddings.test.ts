import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pipeline = vi.fn();
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline,
}));

const HUB_MODEL_ID = 'Xenova/bge-small-en-v1.5';

let cacheDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  originalXdg = process.env.XDG_CONFIG_DIR;
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-embed-'));
  process.env.XDG_CONFIG_DIR = cacheDir;
  pipeline.mockReset();
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_DIR;
  else process.env.XDG_CONFIG_DIR = originalXdg;
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function modelDir(): string {
  return path.join(cacheDir, 'agent-memory', ...HUB_MODEL_ID.split('/'));
}

function seedPartialModel(): string {
  const onnxDir = path.join(modelDir(), 'onnx');
  fs.mkdirSync(onnxDir, { recursive: true });
  const partial = path.join(onnxDir, 'model.onnx');
  fs.writeFileSync(partial, 'partial-bytes');
  return partial;
}

describe('TransformersEmbeddings corruption recovery', () => {
  it('purges the cached model and retries when a partial download fails to parse', async () => {
    const { TransformersEmbeddings } = await import('../src/domain/embeddings.js');
    const partial = seedPartialModel();
    const extractor = vi.fn();

    pipeline
      .mockRejectedValueOnce(new Error(`Load model from ${partial} failed:Protobuf parsing failed.`))
      .mockResolvedValueOnce(extractor);

    const embeddings = new TransformersEmbeddings();
    await embeddings.ready();

    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(partial)).toBe(false);
  });

  it('does not delete the cache for non-corruption errors (e.g. network)', async () => {
    const { TransformersEmbeddings } = await import('../src/domain/embeddings.js');
    const partial = seedPartialModel();

    pipeline.mockRejectedValue(new Error('getaddrinfo ENOTFOUND huggingface.co'));

    const embeddings = new TransformersEmbeddings();
    await expect(embeddings.ready()).rejects.toThrow(/ENOTFOUND/);

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(partial)).toBe(true);
  });

  it('retries loading on a later call after a failure rather than caching the rejection', async () => {
    const { TransformersEmbeddings } = await import('../src/domain/embeddings.js');
    const extractor = vi.fn();

    pipeline.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND huggingface.co')).mockResolvedValueOnce(extractor);

    const embeddings = new TransformersEmbeddings();
    await expect(embeddings.ready()).rejects.toThrow(/ENOTFOUND/);
    await expect(embeddings.ready()).resolves.toBeUndefined();
    expect(pipeline).toHaveBeenCalledTimes(2);
  });
});
