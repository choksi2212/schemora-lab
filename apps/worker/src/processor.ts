import { parseConversation, extractCandidates } from '@schemora/intelligence';
process.once(
  'message',
  async (input: { filename: string; bytes: Uint8Array; selectionId?: string }) => {
    try {
      const bundle = await parseConversation(input);
      const conversation = input.selectionId
        ? bundle.conversations.find((item) => item.id === input.selectionId)
        : bundle.conversations.length === 1
          ? bundle.conversations[0]
          : undefined;
      const output = { bundle, extraction: conversation ? extractCandidates(conversation) : null };
      if (Buffer.byteLength(JSON.stringify(output)) > 25 * 1024 * 1024)
        throw new Error('Normalized output exceeds storage limit');
      process.send?.({ ok: true, ...output }, undefined, undefined, () => process.exit(0));
    } catch {
      process.send?.(
        { ok: false, code: 'UNSUPPORTED_OR_INVALID_SOURCE' },
        undefined,
        undefined,
        () => process.exit(0),
      );
    }
  },
);
