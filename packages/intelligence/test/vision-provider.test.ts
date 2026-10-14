import { describe, expect, it, vi } from 'vitest';
import { createVultrHardwareRecognizer } from '../src/vision-provider.js';

const config = (fetch: typeof globalThis.fetch) => ({
  endpoint: 'https://api.vultrinference.com/v1/chat/completions',
  apiKey: 'test-only-secret',
  model: 'qwen3.8-27b',
  fetch,
});
const image = {
  bytes: Buffer.from('normalized-image'),
  format: 'png' as const,
  role: 'board-top' as const,
};
const catalog = [
  {
    id: 'board.example.rev-a',
    manufacturer: 'Example',
    model: 'Board Rev A',
    category: 'development-board',
    description: 'A fixture catalog entry.',
  },
];
const proposal = {
  schemaVersion: 1,
  outcome: 'exact-candidate',
  candidates: [
    {
      catalogPartId: 'board.example.rev-a',
      rank: 1,
      basis: 'The visible marking matches.',
      visibleMarkings: [{ text: 'REV A', region: null }],
    },
  ],
  observations: [],
  limitations: ['A human must confirm this proposal.'],
};
const response = (value: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );

describe('Vultr hardware-recognition adapter', () => {
  it('sends one normalized image and a bounded catalog vocabulary, then validates the proposal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(proposal));
    const recognize = createVultrHardwareRecognizer(config(fetch));

    await expect(recognize(image, catalog)).resolves.toEqual(proposal);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.vultrinference.com/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only-secret' });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('qwen3.8-27b');
    expect(body.messages[1].content[1].image_url.url).toBe(
      `data:image/png;base64,${image.bytes.toString('base64')}`,
    );
    expect(body.messages[1].content[0].text).toContain('board.example.rev-a');
  });

  it('rejects candidates outside the catalog vocabulary', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        ...proposal,
        candidates: [{ ...proposal.candidates[0], catalogPartId: 'invented.board' }],
      }),
    );
    const recognize = createVultrHardwareRecognizer(config(fetch));
    await expect(recognize(image, catalog)).rejects.toThrow(
      'referenced a part outside the supplied catalog',
    );
  });

  it('rejects malformed, oversized, incomplete, and unsuccessful provider responses', async () => {
    const malformed = createVultrHardwareRecognizer(
      config(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{'))),
    );
    await expect(malformed(image, catalog)).rejects.toThrow('invalid JSON');

    const oversized = createVultrHardwareRecognizer({
      ...config(
        vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(new Response('x'.repeat(1_100), { status: 200 })),
      ),
      maxResponseBytes: 1_024,
    });
    await expect(oversized(image, catalog)).rejects.toThrow('exceeds its limit');

    const incomplete = createVultrHardwareRecognizer(
      config(
        vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ choices: [{ finish_reason: 'length' }] })),
          ),
      ),
    );
    await expect(incomplete(image, catalog)).rejects.toThrow('incomplete');

    const unavailable = createVultrHardwareRecognizer(
      config(
        vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 429 })),
      ),
    );
    await expect(unavailable(image, catalog)).rejects.toThrow('HTTP 429');
  });

  it('rejects unsafe endpoints, unsupported models, and invalid input bounds before sending', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(proposal));
    expect(() =>
      createVultrHardwareRecognizer({
        ...config(fetch),
        endpoint: 'https://example.com/v1/chat/completions',
      }),
    ).toThrow('fixed Vultr HTTPS');
    expect(() =>
      createVultrHardwareRecognizer({ ...config(fetch), model: 'unreviewed-model' }),
    ).toThrow('reviewed model');

    const recognize = createVultrHardwareRecognizer(config(fetch));
    await expect(recognize({ ...image, bytes: Buffer.alloc(0) }, catalog)).rejects.toThrow(
      'supported size limit',
    );
    await expect(recognize(image, [])).rejects.toThrow('catalog vocabulary');
    await expect(
      recognize(image, [...catalog, { ...catalog[0]!, id: catalog[0]!.id }]),
    ).rejects.toThrow('duplicate part IDs');
    expect(fetch).not.toHaveBeenCalled();
  });
});
