import { describe, expect, it } from 'vitest';
import {
  parseConversation,
  extractCandidates,
  validateExternalExtraction,
  createModelExtractor,
} from '../src/index.js';
import { benchmarkCases } from './fixtures.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = async (text: string, filename = 'chat.txt') =>
  (await parseConversation({ filename, bytes: bytes(text) })).conversations[0]!;
function zip(name: string, text: string): Uint8Array {
  const data = Buffer.from(text);
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
function textPdf(content: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 80 Td (${content.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let doc = '%PDF-1.4\n';
  const offsets = [0];
  for (let n = 0; n < objects.length; n++) {
    offsets.push(Buffer.byteLength(doc));
    doc += `${n + 1} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(doc);
  doc += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return bytes(doc);
}

describe('28 synthetic hardware benchmark fixtures', () => {
  for (const fixture of benchmarkCases)
    it(fixture.name, async () => {
      const conversation = await parse(fixture.text);
      const result = extractCandidates(conversation);
      for (const expected of fixture.expected)
        expect(
          result.candidates.some(
            (c) =>
              c.kind === expected.kind &&
              c.value.includes(expected.includes) &&
              c.status === (expected.status ?? 'candidate'),
          ),
          `${expected.kind}: ${expected.includes}`,
        ).toBe(true);
      if (fixture.missing)
        expect(result.missingInformation.some((s) => s.includes(fixture.missing!))).toBe(true);
      if (fixture.conflicts !== undefined) expect(result.conflicts).toHaveLength(fixture.conflicts);
      for (const candidate of result.candidates)
        for (const evidence of candidate.evidence)
          expect(
            conversation.messages
              .find((m) => m.id === evidence.messageId)
              ?.content.slice(evidence.start, evidence.end),
          ).toBe(evidence.quote);
      if (fixture.name === 'negative instruction' || fixture.name === 'injection remains data')
        expect(result.candidates.some((c) => c.kind === 'connection')).toBe(false);
      if (fixture.name === 'missing resistor')
        expect(result.candidates.some((c) => /220|330/.test(c.value))).toBe(false);
    });
});

describe('structured candidate details', () => {
  it('keeps unspecified model, quantity and resistance null', async () => {
    const r = extractCandidates(await parse('User: ESP32 with LED and resistor.'));
    const board = r.candidates.find((c) => c.kind === 'board')!;
    if (board.kind === 'board')
      expect(board.details).toEqual({
        manufacturer: null,
        family: 'ESP32',
        exactModel: null,
        revision: null,
      });
    for (const c of r.candidates)
      if (c.kind === 'component') {
        expect(c.details.quantity).toBeNull();
        expect(c.details.resistanceOhms).toBeNull();
      }
  });
  it('normalizes only stated quantities and supported resistor units', async () => {
    const r = extractCandidates(await parse('User: 2 LEDs; 4.7 kΩ resistor; 12 µΩ resistor.'));
    const values = r.candidates.filter((c) => c.kind === 'component');
    expect(values[0]!.details.quantity).toBe(2);
    expect(values[1]!.details.resistanceOhms).toBe(4700);
    expect(values[2]!.details.resistanceOhms).toBeCloseTo(0.000012, 9);
  });
  it('preserves explicit endpoints, leaves unspecified terminal null', async () => {
    const r = extractCandidates(
      await parse('User: Connect GPIO 18 to LED.\nAssistant: Connect LED cathode to GND.'),
    );
    const connections = r.candidates.filter((c) => c.kind === 'connection');
    expect(connections[0]!.details).toEqual({
      from: { label: 'GPIO 18', componentRef: null },
      to: null,
    });
    expect(connections[1]!.details.to?.label).toBe('GND');
  });
  it('retains firmware language and literal code', async () => {
    const r = extractCandidates(await parse('Assistant:\n~~~cpp\nvoid setup() {}\n~~~'));
    const c = r.candidates[0]!;
    expect(c.kind).toBe('firmware');
    expect(c.details).toEqual({ language: 'cpp', content: 'void setup() {}' });
  });
  it('rejects fabricated structured manufacturer, quantity, resistance and endpoint', async () => {
    const conversation = await parse('User: ESP32 with resistor. Connect GPIO 18 to LED anode.');
    const r = extractCandidates(conversation);
    const board = r.candidates.find((c) => c.kind === 'board')!;
    if (board.kind === 'board') board.details.manufacturer = 'Invented';
    expect(() => validateExternalExtraction(conversation, r)).toThrow('absent');
    if (board.kind === 'board') board.details.manufacturer = null;
    const component = r.candidates.find((c) => c.kind === 'component')!;
    if (component.kind === 'component') component.details.resistanceOhms = 220;
    expect(() => validateExternalExtraction(conversation, r)).toThrow('Resistance');
  });
});

describe('normalization and source safety', () => {
  it('preserves role order and does not split code contents', async () => {
    const c = await parse('User: first\nAssistant:\n~~~txt\nUser: code\n~~~');
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(c.messages[1]!.codeBlocks[0]!.content).toBe('User: code');
  });
  it('preserves generic JSON roles and timestamps', async () => {
    const c = await parse(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'ESP32', timestamp: '2026-01-01T00:00:00Z' },
          { role: 'assistant', content: 'LED' },
        ],
      }),
      'chat.json',
    );
    expect(c.messages[0]!.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(c.messages[1]!.sequence).toBe(1);
  });
  it('supports Claude-like text blocks without merging chats', async () => {
    const b = await parseConversation({
      filename: 'claude.json',
      bytes: bytes(
        JSON.stringify([
          {
            name: 'first',
            chat_messages: [{ sender: 'human', content: [{ type: 'text', text: 'ESP32' }] }],
          },
          { name: 'second', chat_messages: [{ sender: 'assistant', text: 'LED' }] },
        ]),
      ),
    });
    expect(b.conversations).toHaveLength(2);
    expect(b.conversations[0]!.messages[0]!.role).toBe('user');
  });
  it('follows selected ChatGPT branch, never siblings', async () => {
    const c = await parse(
      JSON.stringify({
        current_node: 'b',
        mapping: {
          root: { parent: null, children: ['a', 'b'], message: null },
          a: {
            parent: 'root',
            children: [],
            message: { author: { role: 'assistant' }, content: { parts: ['GPIO 18'] } },
          },
          b: {
            parent: 'root',
            children: [],
            message: { author: { role: 'assistant' }, content: { parts: ['GPIO 19'] } },
          },
        },
      }),
      'chat.json',
    );
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.content).toBe('GPIO 19');
  });
  it('rejects ambiguous branch and cycles', async () => {
    await expect(
      parse(JSON.stringify({ mapping: { a: { children: [] }, b: { children: [] } } }), 'chat.json'),
    ).rejects.toThrow('multiple branches');
    await expect(
      parse(JSON.stringify({ current_node: 'a', mapping: { a: { parent: 'a' } } }), 'chat.json'),
    ).rejects.toThrow('cycle');
  });
  it('parses inert HTML, code and image references', async () => {
    const c = await parse(
      '<div data-message-author-role="user">ESP32<script>throw Error()</script><img src="https://invalid/image"></div><div data-message-author-role="assistant"><pre>void setup() {}</pre></div>',
      'chat.html',
    );
    expect(c.messages[0]!.content).toBe('ESP32');
    expect(c.messages[0]!.attachments).toEqual(['https://invalid/image']);
    expect(c.messages[1]!.codeBlocks[0]!.content).toBe('void setup() {}');
  });
  it('rejects oversized text and raised policy', async () => {
    await expect(
      parseConversation({
        filename: 'chat.txt',
        bytes: bytes('too long'),
        limits: { maxBytes: 2 },
      }),
    ).rejects.toThrow('upload limit');
    await expect(
      parseConversation({
        filename: 'chat.txt',
        bytes: bytes('x'),
        limits: { maxBytes: 1_000_000_000 },
      }),
    ).rejects.toThrow('only lower');
  });
  it('rejects malformed unknown and binary formats', async () => {
    await expect(parse('{bad', 'chat.json')).rejects.toThrow('malformed');
    await expect(parse('{}', 'chat.json')).rejects.toThrow('Expected');
    await expect(parse('a\0b')).rejects.toThrow('binary');
    await expect(parse('hello', 'chat.exe')).rejects.toThrow('Supported formats');
  });
  it('imports bounded ZIP in memory', async () => {
    const b = await parseConversation({
      filename: 'chat.zip',
      bytes: zip('chat.txt', 'User: ESP32'),
    });
    expect(b.conversations[0]!.messages[0]!.content).toBe('ESP32');
  });
  it('rejects archive traversal, nested ZIP, and disallowed types', async () => {
    await expect(
      parseConversation({ filename: 'chat.zip', bytes: zip('../evil.txt', 'x') }),
    ).rejects.toThrow();
    await expect(
      parseConversation({ filename: 'chat.zip', bytes: zip('other.zip', 'x') }),
    ).rejects.toThrow('Nested');
    await expect(
      parseConversation({ filename: 'chat.zip', bytes: zip('script.exe', 'x') }),
    ).rejects.toThrow('disallowed');
  });
  it('rejects archive symlinks, encryption and expanded byte limits', async () => {
    const data = Buffer.from(zip('chat.txt', 'User: ESP32'));
    const centralOffset = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const symlink = Buffer.from(data);
    symlink.writeUInt32LE((0xa000 << 16) >>> 0, centralOffset + 38);
    await expect(parseConversation({ filename: 'chat.zip', bytes: symlink })).rejects.toThrow(
      'symbolic links',
    );
    const encrypted = Buffer.from(data);
    encrypted.writeUInt16LE(1, centralOffset + 8);
    await expect(parseConversation({ filename: 'chat.zip', bytes: encrypted })).rejects.toThrow();
    await expect(
      parseConversation({
        filename: 'chat.zip',
        bytes: data,
        limits: { maxArchiveExpandedBytes: 3 },
      }),
    ).rejects.toThrow('decompression limits');
  });
  it('rejects invalid PDF signature', async () => {
    await expect(parse('not a PDF', 'chat.pdf')).rejects.toThrow('not a PDF');
  });
  it('extracts real text PDF and page provenance', async () => {
    const result = await parseConversation({
      filename: 'chat.pdf',
      bytes: textPdf('ESP32 LED circuit'),
    });
    expect(result.conversations[0]!.messages[0]!.content).toContain('ESP32 LED circuit');
    expect(result.conversations[0]!.messages[0]!.source.page).toBe(1);
    expect(result.conversations[0]!.warnings.join(' ')).toContain('whitespace');
  });
  it('rejects PDF with no readable text', async () => {
    await expect(parseConversation({ filename: 'image.pdf', bytes: textPdf('') })).rejects.toThrow(
      'No readable messages',
    );
  });
  it('accepts extension aliases consistently', async () => {
    expect((await parse('User: ESP32', 'chat.markdown')).messages[0]!.content).toBe('ESP32');
    expect((await parse('<p>ESP32</p>', 'chat.htm')).messages[0]!.content).toContain('ESP32');
  });
  it('rejects wrong selection IDs', async () => {
    await expect(
      parseConversation({
        filename: 'chat.txt',
        bytes: bytes('User: hello'),
        selectionId: 'wrong',
      }),
    ).rejects.toThrow('does not exist');
  });
});

describe('external extraction trust boundary', () => {
  it('rejects absent messages and incorrect quote offsets', async () => {
    const c = await parse('User: ESP32');
    const r = extractCandidates(c);
    r.candidates[0]!.evidence[0]!.messageId = 'forged';
    expect(() => validateExternalExtraction(c, r)).toThrow('source span');
  });
  it('rejects unsupported fields and fake confirmation status', async () => {
    const c = await parse('User: ESP32');
    const r = extractCandidates(c);
    expect(() => validateExternalExtraction(c, { ...r, verified: true })).toThrow();
    expect(() =>
      validateExternalExtraction(c, {
        ...r,
        candidates: [{ ...r.candidates[0], status: 'verified' }],
      }),
    ).toThrow();
  });
  it('rejects duplicate IDs and invalid supersession', async () => {
    const c = await parse('User: ESP32 LED');
    const r = extractCandidates(c);
    r.candidates[1]!.id = r.candidates[0]!.id;
    expect(() => validateExternalExtraction(c, r)).toThrow('Duplicate');
  });
  it('uses fixed configured endpoint and validates fake model output', async () => {
    const c = await parse('User: ESP32');
    const r = extractCandidates(c);
    let requestBody = '';
    const extractor = createModelExtractor({
      endpoint: 'https://provider.invalid/chat/completions',
      model: 'approved',
      apiKey: 'fake',
      fetch: async (_, init) => {
        requestBody = String(init?.body);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(r) } }],
          }),
          { status: 200 },
        );
      },
    });
    expect(await extractor(c)).toEqual(r);
    expect(requestBody).toContain('untrusted');
  });
  it('rejects insecure endpoints, provider failure and truncation', async () => {
    expect(() =>
      createModelExtractor({ endpoint: 'http://localhost/api', model: 'm', apiKey: 'x' }),
    ).toThrow('HTTPS');
    const c = await parse('User: ESP32');
    await expect(
      createModelExtractor({
        endpoint: 'https://provider.invalid/api',
        model: 'm',
        apiKey: 'x',
        fetch: async () => new Response('', { status: 429 }),
      })(c),
    ).rejects.toThrow('HTTP 429');
    await expect(
      createModelExtractor({
        endpoint: 'https://provider.invalid/api',
        model: 'm',
        apiKey: 'x',
        fetch: async () =>
          new Response(
            JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
          ),
      })(c),
    ).rejects.toThrow('incomplete');
  });
});
