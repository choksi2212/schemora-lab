import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { load } from 'cheerio';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import {
  conversationBundleSchema,
  type ConversationBundle,
  type NormalizedConversation,
  type NormalizedMessage,
} from '@schemora/contracts';

export class ImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}
export const DEFAULT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxTextCharacters: 2_000_000,
  maxMessages: 5_000,
  maxConversations: 100,
  maxPages: 100,
  maxArchiveEntries: 100,
  maxArchiveExpandedBytes: 20 * 1024 * 1024,
  maxCompressionRatio: 100,
};
export type ParserLimits = typeof DEFAULT_LIMITS;
export type ParseInput = {
  filename: string;
  bytes: Uint8Array;
  selectionId?: string;
  limits?: Partial<ParserLimits>;
};
type Draft = {
  content: string;
  role?: string;
  timestamp?: unknown;
  path?: string;
  page?: number;
  attachments?: string[];
};
const supported = new Set(['.txt', '.md', '.html', '.json', '.pdf', '.zip']);
const extension = (filename: string) => {
  const ext = extname(filename).toLowerCase();
  return ext === '.htm' ? '.html' : ext === '.markdown' ? '.md' : ext;
};
const fail = (code: string, text: string): never => {
  throw new ImportError(code, text);
};
const hash = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex').slice(0, 24);
function role(raw: unknown): NormalizedMessage['role'] {
  return typeof raw === 'string' &&
    ['user', 'human', 'assistant', 'system'].includes(raw.toLowerCase())
    ? ((raw.toLowerCase() === 'human' ? 'user' : raw.toLowerCase()) as NormalizedMessage['role'])
    : 'unknown';
}
function timestamp(raw: unknown): string | null {
  const date =
    typeof raw === 'number'
      ? new Date(raw * 1000)
      : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
        ? new Date(raw)
        : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;
}
function codeBlocks(content: string) {
  return Array.from(
    content.matchAll(/(?:^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1(?=\n|$)/g),
    (m) => ({ language: m[2]!.trim() || null, content: m[3]! }),
  );
}
function conversation(
  filename: string,
  key: string,
  title: string,
  drafts: Draft[],
  warnings: string[],
  limits: ParserLimits,
): NormalizedConversation {
  const nonempty = drafts.filter((d) => d.content.trim());
  if (!nonempty.length)
    fail(
      'EMPTY_CONVERSATION',
      'No readable messages were found. Image-only documents require OCR and are not supported.',
    );
  if (nonempty.length > limits.maxMessages)
    fail('MESSAGE_LIMIT', 'This conversation has too many messages.');
  const id = `conversation_${hash(filename + ':' + key)}`;
  return {
    id,
    title,
    warnings,
    messages: nonempty.map((d, sequence) => ({
      id: `${id}_m${sequence}`,
      sequence,
      role: role(d.role),
      content: d.content,
      timestamp: timestamp(d.timestamp),
      codeBlocks: codeBlocks(d.content),
      attachments: d.attachments ?? [],
      source: {
        file: filename,
        ...(d.page ? { page: d.page } : {}),
        ...(d.path ? { path: d.path } : {}),
      },
    })),
  };
}
function decode(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) fail('BINARY_TEXT', 'Text imports cannot contain binary null bytes.');
    return text.replace(/^\uFEFF/, '');
  } catch (error) {
    if (error instanceof ImportError) throw error;
    return fail('ENCODING', 'Save this file as UTF-8 text before importing.');
  }
}
function textDrafts(text: string): Draft[] {
  const lines = text.split('\n');
  const drafts: Draft[] = [];
  let current: Draft = { content: '', path: 'line:1' };
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) fence = fence === marker[1] ? null : (fence ?? marker[1]!);
    const header =
      !fence && line.match(/^\s*(?:#{1,6}\s*)?(user|human|assistant|system)\s*:(?:\s*(.*))?$/i);
    if (header) {
      if (current.content.trim()) drafts.push(current);
      current = { role: header[1], content: header[2] ?? '', path: `line:${index + 1}` };
    } else current.content += (current.content ? '\n' : '') + line;
  }
  if (current.content.trim()) drafts.push(current);
  return drafts;
}
function parseJson(text: string, filename: string, limits: ParserLimits): NormalizedConversation[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('INVALID_JSON', 'The file contains malformed JSON.');
  }
  const records = Array.isArray(data) ? data : [data];
  if (records.length > limits.maxConversations)
    fail(
      'CONVERSATION_LIMIT',
      'The export contains too many conversations; export a smaller selection.',
    );
  return records.map((record, i) => {
    if (!record || typeof record !== 'object')
      return fail(
        'JSON_SHAPE',
        'Only recognized message-array and conversation-tree exports are supported.',
      );
    const item = record as Record<string, unknown>;
    const warnings: string[] = [];
    let drafts: Draft[] = [];
    if (item.mapping && typeof item.mapping === 'object' && !Array.isArray(item.mapping)) {
      const mapping = item.mapping as Record<
        string,
        {
          parent?: string | null;
          children?: string[];
          message?: {
            author?: { role?: string };
            content?: { parts?: unknown[] };
            create_time?: unknown;
          };
        }
      >;
      const keys = Object.keys(mapping);
      if (keys.length > limits.maxMessages * 2)
        fail('MESSAGE_LIMIT', 'The conversation tree exceeds the node limit.');
      let node = typeof item.current_node === 'string' ? item.current_node : undefined;
      if (!node) {
        const leaves = keys.filter((k) => !mapping[k]?.children?.length);
        if (leaves.length !== 1)
          fail(
            'AMBIGUOUS_BRANCH',
            'This export has multiple branches and no selected current_node.',
          );
        node = leaves[0];
      }
      const ordered: string[] = [];
      const visited = new Set<string>();
      while (node) {
        if (visited.has(node)) fail('CYCLIC_TREE', 'The conversation tree contains a cycle.');
        visited.add(node);
        const value: (typeof mapping)[string] | undefined = mapping[node];
        if (!value) fail('BROKEN_TREE', 'The selected conversation path refers to a missing node.');
        ordered.unshift(node);
        node = value.parent ?? undefined;
      }
      drafts = ordered.flatMap((key) => {
        const message = mapping[key]!.message;
        if (!message) return [];
        const parts = message.content?.parts ?? [];
        const content = parts.filter((p): p is string => typeof p === 'string').join('\n');
        if (parts.some((p) => typeof p !== 'string'))
          warnings.push(`Non-text content in node ${key} was not interpreted.`);
        return [
          {
            content,
            role: message.author?.role,
            timestamp: message.create_time,
            path: `[${i}].mapping.${key}`,
          },
        ];
      });
      if (ordered.length < keys.length)
        warnings.push(
          'Only the selected conversation branch was imported; alternate branches were retained in the private source file.',
        );
    } else {
      const rawMessages = item.messages ?? item.chat_messages;
      if (!Array.isArray(rawMessages))
        return fail(
          'JSON_SHAPE',
          'Expected messages, chat_messages, or a mapping/current_node conversation tree.',
        );
      const messages: unknown[] = rawMessages;
      if (messages.length > limits.maxMessages)
        fail('MESSAGE_LIMIT', 'Too many messages in this export.');
      drafts = messages.map((message, index) => {
        if (!message || typeof message !== 'object')
          return fail('JSON_MESSAGE', 'Every message must be an object.');
        const m = message as Record<string, unknown>;
        let content =
          typeof m.content === 'string' ? m.content : typeof m.text === 'string' ? m.text : '';
        if (Array.isArray(m.content)) {
          content = m.content
            .filter((p) => p && typeof p === 'object' && typeof p.text === 'string')
            .map((p) => p.text as string)
            .join('\n');
          if (m.content.some((p) => !p || typeof p !== 'object' || typeof p.text !== 'string'))
            warnings.push(`Message ${index + 1} contains unsupported non-text blocks.`);
        }
        if (!content) warnings.push(`Message ${index + 1} has no readable text.`);
        const attachments = Array.isArray(m.attachments)
          ? m.attachments.flatMap((a) =>
              typeof a === 'string'
                ? [a]
                : a && typeof a === 'object' && typeof a.file_name === 'string'
                  ? [a.file_name]
                  : [],
            )
          : [];
        return {
          content,
          role:
            typeof m.role === 'string'
              ? m.role
              : typeof m.sender === 'string'
                ? m.sender
                : undefined,
          timestamp: m.timestamp ?? m.created_at,
          attachments,
          path: `[${i}].messages[${index}]`,
        };
      });
    }
    return conversation(
      filename,
      `${i}:${hash(text)}`,
      String(item.title ?? item.name ?? `Conversation ${i + 1}`),
      drafts,
      [...new Set(warnings)],
      limits,
    );
  });
}

async function pdf(
  bytes: Uint8Array,
  filename: string,
  limits: ParserLimits,
): Promise<NormalizedConversation[]> {
  if (Buffer.from(bytes.subarray(0, 8)).toString('ascii').indexOf('%PDF-') !== 0)
    fail('PDF_SIGNATURE', 'The file is not a PDF.');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // PDF.js >=5.7 removed the legacy eval option and PostScript compiler.
  const task = getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > limits.maxPages) fail('PAGE_LIMIT', 'The PDF has too many pages.');
    const drafts: Draft[] = [];
    const warnings = [
      'PDF text order and whitespace may differ from the original; review code against the source before use.',
    ];
    let total = 0;
    for (let page = 1; page <= doc.numPages; page++) {
      const p = await doc.getPage(page);
      const text = await p.getTextContent();
      const content = text.items
        .map((x) => ('str' in x ? x.str + (x.hasEOL ? '\n' : ' ') : ''))
        .join('');
      total += content.length;
      if (total > limits.maxTextCharacters)
        fail('TEXT_LIMIT', 'The extracted text exceeds the limit.');
      if (!content.trim())
        warnings.push(`Page ${page} has no extractable text; images were not interpreted.`);
      drafts.push({ content, page, path: `page:${page}` });
      p.cleanup();
    }
    return [conversation(filename, hash(bytes), filename, drafts, warnings, limits)];
  } catch (error) {
    if (error instanceof ImportError) throw error;
    return fail(
      'PDF_READ',
      'The PDF could not be read. Encrypted and malformed PDFs are not supported.',
    );
  } finally {
    await task.destroy();
  }
}

async function archive(
  bytes: Uint8Array,
  filename: string,
  limits: ParserLimits,
): Promise<ConversationBundle> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, file) =>
        error || !file
          ? reject(new ImportError('ZIP_READ', 'The ZIP archive could not be read.'))
          : resolve(file),
    ),
  );
  const entries: { filename: string; bytes: Uint8Array }[] = [];
  let expanded = 0;
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          count++;
          if (count > limits.maxArchiveEntries)
            fail('ARCHIVE_ENTRIES', 'The archive contains too many entries.');
          const name = entry.fileName;
          const segments = name.replace(/\\/g, '/').split('/');
          if (
            name.includes('\0') ||
            name.includes('\\') ||
            name.startsWith('/') ||
            /^[A-Za-z]:/.test(name) ||
            segments.includes('..') ||
            segments.length > 6
          )
            fail('ARCHIVE_PATH', 'The archive contains an unsafe or excessively nested path.');
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
            fail('ARCHIVE_LINK', 'Archive symbolic links are not supported.');
          if (entry.generalPurposeBitFlag & 1)
            fail('ARCHIVE_ENCRYPTED', 'Encrypted archives are not supported.');
          expanded += entry.uncompressedSize;
          if (
            entry.uncompressedSize > limits.maxBytes ||
            expanded > limits.maxArchiveExpandedBytes ||
            entry.uncompressedSize / Math.max(entry.compressedSize, 1) > limits.maxCompressionRatio
          )
            fail('ARCHIVE_SIZE', 'The archive exceeds decompression limits.');
          if (name.endsWith('/')) {
            zip.readEntry();
            return;
          }
          const ext = extension(name);
          if (ext === '.zip') fail('ARCHIVE_NESTED', 'Nested archives are not supported.');
          if (!supported.has(ext)) {
            if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext))
              fail('ARCHIVE_TYPE', 'The archive contains a disallowed file type.');
            zip.readEntry();
            return;
          }
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s))),
          );
          const chunks: Buffer[] = [];
          let actual = 0;
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            actual += chunk.length;
            if (actual > entry.uncompressedSize || actual > limits.maxBytes)
              fail('ARCHIVE_SIZE', 'An archive entry exceeds its declared size.');
            chunks.push(chunk);
          }
          entries.push({ filename: `${filename}/${name}`, bytes: Buffer.concat(chunks) });
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    // Prefer structured export files over duplicate HTML renderings of the same chats.
    const structured = entries.filter((e) =>
      /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(e.filename),
    );
    const selected = structured.length ? structured : entries;
    if (!selected.length) fail('ARCHIVE_EMPTY', 'The archive has no supported conversation files.');
    const conversations: NormalizedConversation[] = [];
    const warnings = ['Images in archives are attachment references only and are not interpreted.'];
    for (const item of selected) {
      const bundle = await parseConversation({ ...item, limits });
      conversations.push(...bundle.conversations);
      warnings.push(...bundle.warnings);
    }
    if (
      conversations.length > limits.maxConversations ||
      conversations.reduce(
        (n, c) => n + c.messages.reduce((sum, m) => sum + m.content.length, 0),
        0,
      ) > limits.maxTextCharacters
    )
      fail('ARCHIVE_OUTPUT_LIMIT', 'The archive produces too much conversation content.');
    return { schemaVersion: 1, conversations, warnings };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    return fail('ZIP_READ', 'The ZIP archive is malformed or has an unsafe entry.');
  } finally {
    zip.close();
  }
}

export async function parseConversation(input: ParseInput): Promise<ConversationBundle> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const { filename, bytes } = input;
  const ext = extension(filename);
  for (const [name, limit] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > DEFAULT_LIMITS[name as keyof ParserLimits]
    )
      fail('LIMIT_POLICY', 'Parser overrides may only lower positive resource limits.');
  }
  if (!supported.has(ext))
    fail(
      'FILE_TYPE',
      'Supported formats are TXT, Markdown, static HTML, recognized JSON, text PDF, and restricted ZIP.',
    );
  if (!bytes.length || bytes.length > limits.maxBytes)
    fail('FILE_SIZE', 'The file is empty or exceeds the upload limit.');
  let bundle: ConversationBundle;
  if (ext === '.zip') bundle = await archive(bytes, filename, limits);
  else if (ext === '.pdf')
    bundle = { schemaVersion: 1, conversations: await pdf(bytes, filename, limits), warnings: [] };
  else {
    const text = decode(bytes);
    if (text.length > limits.maxTextCharacters)
      fail('TEXT_LIMIT', 'The conversation text exceeds the limit.');
    let conversations: NormalizedConversation[];
    if (ext === '.json') conversations = parseJson(text, filename, limits);
    else if (ext === '.html') {
      const $ = load(text);
      $('script,style,noscript,iframe,object,embed').remove();
      const nodes = $('[data-message-author-role], .message');
      const drafts: Draft[] = [];
      nodes.each((index, el) => {
        if ($(el).parents('[data-message-author-role], .message').length) return;
        const block = $(el).clone();
        block.find('pre').each((_, pre) => {
          $(pre).replaceWith('\n~~~\n' + $(pre).text() + '\n~~~\n');
        });
        block.find('br').replaceWith('\n');
        block.find('p,div,li').append('\n');
        drafts.push({
          content: block.text().trim(),
          role:
            $(el).attr('data-message-author-role') ?? $(el).find('[data-role]').attr('data-role'),
          timestamp: $(el).attr('data-timestamp'),
          attachments: $(el)
            .find('img')
            .map((_, img) => $(img).attr('src') ?? '')
            .get(),
          path: `element:${index}`,
        });
      });
      if (!drafts.length) {
        $('br').replaceWith('\n');
        $('p,div,li,h1,h2,h3,pre').append('\n');
        drafts.push(...textDrafts($('body').text()));
      }
      conversations = [
        conversation(
          filename,
          hash(bytes),
          filename,
          drafts,
          [
            'Static HTML text only; scripts, remote resources, and images are not executed or interpreted.',
          ],
          limits,
        ),
      ];
    } else {
      const drafts = textDrafts(text);
      conversations = [
        conversation(
          filename,
          hash(bytes),
          filename,
          drafts,
          drafts.some((d) => !d.role)
            ? ['Some messages have unknown roles because no supported role markers were found.']
            : [],
          limits,
        ),
      ];
    }
    bundle = { schemaVersion: 1, conversations, warnings: [] };
  }
  if (input.selectionId) {
    bundle.conversations = bundle.conversations.filter((c) => c.id === input.selectionId);
    if (!bundle.conversations.length)
      fail('SELECTION_NOT_FOUND', 'The selected conversation does not exist in this import.');
  }
  return conversationBundleSchema.parse(bundle);
}
