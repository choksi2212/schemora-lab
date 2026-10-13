import {
  candidateSchema,
  extractionResultSchema,
  type Candidate,
  type Evidence,
  type ExtractionResult,
  type NormalizedConversation,
} from '@schemora/contracts';

function sourceDetails(
  kind: Candidate['kind'],
  value: string,
  quote: string,
): Candidate['details'] {
  if (kind === 'board') {
    const family =
      value.match(/ESP32(?:[- ](?:S2|S3|C3|C6))?|Arduino|Raspberry Pi Pico/i)?.[0] ?? null;
    const exactModel = /DevKit|Arduino\s+(Uno|Nano|Mega)|Raspberry Pi Pico/i.test(value)
      ? value
      : null;
    const revision = value.match(/\b(?:R\d+|V\d+)\b/i)?.[0] ?? null;
    const manufacturer =
      quote.match(
        /\b(?:manufacturer|manufactured by)\s*[:=]?\s*(Espressif|Arduino|Raspberry Pi)\b/i,
      )?.[1] ?? null;
    return { manufacturer, family, exactModel, revision };
  }
  if (kind === 'component') {
    const type =
      value
        .match(
          /resistors?|LEDs?|breadboards?|jumper\s+wires?|DHT(?:11|22)|BME280|HC-SR04|push\s*buttons?|capacitors?|sensors?/i,
        )?.[0]
        ?.toLowerCase()
        .replace(/s$/, '') ?? value;
    const rawQuantity = value.match(
      /^(\d+)\s*(?:[x×]\s*)?(?!\d|[.])(?:LEDs?|resistors?|breadboards?|jumper\s+wires?|DHT\d+|BME280|HC-SR04|push\s*buttons?|capacitors?|sensors?)\b/i,
    )?.[1];
    const resistance = /resistor/i.test(value)
      ? value.match(/(\d+(?:\.\d+)?)\s*([µμmkM]|kilo|mega|micro|milli)?\s*(?:ohms?|Ω)/i)
      : null;
    const unit = resistance?.[2] ?? '';
    const multiplier =
      unit === 'M' || unit.toLowerCase() === 'mega'
        ? 1e6
        : /^(k|kilo)$/i.test(unit)
          ? 1e3
          : /^(µ|μ|micro)$/i.test(unit)
            ? 1e-6
            : /^(m|milli)$/.test(unit)
              ? 1e-3
              : 1;
    const quantity = rawQuantity ? Number(rawQuantity) : null;
    const resistanceOhms = resistance ? Number(resistance[1]) * multiplier : null;
    return {
      type,
      quantity: quantity && quantity <= 10_000 ? quantity : null,
      resistanceOhms: resistanceOhms && resistanceOhms <= 1e15 ? resistanceOhms : null,
    };
  }
  if (kind === 'connection') {
    const pair = value.match(/\b(?:connect|wire|attach)\s+(.+?)\s+to\s+(.+?)(?:[.!]\s*$|$)/i);
    const terminal = (label: string | undefined) =>
      label &&
      /(?:GPIO\s*\d+|GND|ground|\d(?:\.\d)?\s*V|anode|cathode|terminal\s*[ab12]|SDA|SCL|data|VCC)/i.test(
        label,
      )
        ? { label: label.trim(), componentRef: null }
        : null;
    return { from: terminal(pair?.[1]), to: terminal(pair?.[2]) };
  }
  if (kind === 'firmware') return { language: null, content: value };
  return { text: value };
}

/** Local rules expose source mentions, not electrically verified circuit facts. */
export function extractCandidates(conversation: NormalizedConversation): ExtractionResult {
  const candidates: Candidate[] = [];
  const conflicts: ExtractionResult['conflicts'] = [];
  const missingInformation: string[] = [];
  const add = (
    kind: Candidate['kind'],
    value: string,
    evidence: Evidence,
    uncertainty: string | null,
  ): Candidate => {
    const existing = candidates.find(
      (c) =>
        c.kind === kind &&
        c.value.toLowerCase() === value.toLowerCase() &&
        c.status === 'candidate',
    );
    if (existing) {
      existing.evidence.push(evidence);
      return existing;
    }
    const candidate = candidateSchema.parse({
      id: `candidate_${candidates.length + 1}`,
      kind,
      value,
      details: sourceDetails(kind, value, evidence.quote),
      evidence: [evidence],
      status: 'candidate',
      supersedes: [],
      uncertainty,
    });
    candidates.push(candidate);
    return candidate;
  };
  const wiring = new Map<string, Candidate>();
  for (const message of conversation.messages) {
    if (message.role === 'system') continue;
    const fenceSpans = [
      ...message.content.matchAll(/(?:^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g),
    ].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
    for (const match of message.content.matchAll(/[^\n]+/g)) {
      const raw = match[0];
      const start = match.index!;
      if (fenceSpans.some((s) => start >= s.start && start < s.end)) continue;
      const value = raw.trim();
      if (!value) continue;
      const evidence = {
        messageId: message.id,
        quote: value,
        start: start + raw.indexOf(value),
        end: start + raw.indexOf(value) + value.length,
      };
      const negative = /\b(?:don't|do not|never|avoid|not using|remove)\b/i.test(value);
      if (negative) {
        add(
          'requirement',
          value,
          evidence,
          'Negative instruction retained for review; no connection inferred.',
        );
        continue;
      }
      const board = value.match(
        /\b(?:ESP32(?:[- ](?:S2|S3|C3|C6|WROOM[- ]?32|DevKitC(?:[- ]V?\d+)?|DevKit[- ]?V?\d+))?|Arduino\s+(?:Uno|Nano|Mega)(?:\s+R\d+)?|Raspberry\s+Pi\s+Pico(?:\s+W)?)\b/i,
      );
      if (board)
        add(
          'board',
          board[0],
          evidence,
          'Board identity is a source mention. Exact manufacturer, model, and revision require review and catalog mapping.',
        );
      const components = value.matchAll(
        /\b(?:(?:\d+\s*[x×]?\s+)?(?:\d+(?:\.\d+)?\s*(?:[µμmkM]|kilo|mega|micro|milli)?\s*(?:ohms?|Ω)\s+)?)?(?:resistors?|LEDs?|breadboards?|jumper\s+wires?|DHT(?:11|22)|BME280|HC-SR04|push\s*buttons?|capacitors?|sensors?)\b/gi,
      );
      for (const component of components)
        add(
          'component',
          component[0],
          evidence,
          'Source mention only. Quantity and exact part specifications remain unconfirmed.',
        );
      if (
        /\b(?:connect|wire|attach|change|move|use)\b/i.test(value) &&
        /\b(?:GPIO\s*\d+|GND|ground|3\.3\s*V|5\s*V|anode|cathode|terminal|SDA|SCL)\b/i.test(value)
      ) {
        const connection = add(
          'connection',
          value,
          evidence,
          'Wiring instruction requires endpoint, exact hardware, polarity, and electrical review.',
        );
        const target = value
          .match(
            /\b(?:LED\s*(?:anode|cathode)|resistor\s*(?:terminal\s*)?[ab12]|(?:DHT\d+|BME280|sensor)\s*(?:SDA|SCL|data|VCC|GND))\b/i,
          )?.[0]
          ?.toLowerCase()
          .replace(/\s+/g, ' ');
        if (target) {
          const previous = wiring.get(target);
          if (previous && previous.id !== connection.id) {
            const previousPin = previous.value.match(/\bGPIO\s*(\d+)\b/i)?.[1];
            const currentPin = value.match(/\bGPIO\s*(\d+)\b/i)?.[1];
            if (previousPin && currentPin && previousPin !== currentPin) {
              if (/\b(?:instead|change|replace|move|correction|actually|rather)\b/i.test(value)) {
                previous.status = 'superseded';
                connection.supersedes.push(previous.id);
              } else
                conflicts.push({
                  id: `conflict_${conflicts.length + 1}`,
                  candidateIds: [previous.id, connection.id],
                  description: `Different GPIO assignments for ${target}; the user must choose the intended instruction.`,
                });
            }
          }
          wiring.set(target, connection);
        }
      }
    }
    for (const fence of message.content.matchAll(
      /(?:^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1(?=\n|$)/g,
    )) {
      const body = fence[3]!;
      if (!body.trim()) continue;
      const start = fence.index! + fence[0].indexOf(body);
      const candidate = add(
        'firmware',
        body,
        { messageId: message.id, quote: body, start, end: start + body.length },
        'Imported code is untrusted and has not been compiled or checked against hardware.',
      );
      if (candidate.kind === 'firmware') candidate.details.language = fence[2]!.trim() || null;
    }
  }
  const boards = candidates.filter((c) => c.kind === 'board' && c.status === 'candidate');
  if (
    !boards.length ||
    boards.some((c) => /^ESP32(?:[- ](?:S2|S3|C3|C6|WROOM[- ]?32))?$/i.test(c.value))
  )
    missingInformation.push(
      'Confirm the exact board manufacturer, model, and revision. Board family alone is insufficient.',
    );
  if (boards.length > 1)
    conflicts.push({
      id: `conflict_${conflicts.length + 1}`,
      candidateIds: boards.map((c) => c.id),
      description: 'Multiple board identities were mentioned. Confirm the intended final board.',
    });
  if (
    candidates.some(
      (c) =>
        c.kind === 'component' && /resistor/i.test(c.value) && c.details.resistanceOhms === null,
    )
  )
    missingInformation.push('Specify the resistor resistance and rating; no value is assumed.');
  if (
    candidates.some((c) => c.kind === 'component' && /LED/i.test(c.value)) &&
    !candidates.some((c) => c.kind === 'connection' && /anode|cathode/i.test(c.value))
  )
    missingInformation.push('Specify LED polarity and pin-to-terminal connections.');
  if (!candidates.some((c) => c.kind === 'connection'))
    missingInformation.push(
      'No explicit wiring instructions were detected. Provide the source and destination terminals.',
    );
  missingInformation.push(
    'Review every candidate before using it. This phase does not verify catalog compatibility or electrical safety.',
  );
  return validateExternalExtraction(conversation, {
    schemaVersion: 1,
    summary:
      'Local rule extraction: source mentions and explicit wiring instructions for human review.',
    candidates,
    missingInformation,
    conflicts,
  });
}

/** Schemas and literal span checks cannot establish semantic/electrical correctness. */
export function validateExternalExtraction(
  conversation: NormalizedConversation,
  payload: unknown,
): ExtractionResult {
  const result = extractionResultSchema.parse(payload);
  const ids = new Set<string>();
  const messages = new Map(conversation.messages.map((m) => [m.id, m]));
  for (const candidate of result.candidates) {
    if (ids.has(candidate.id)) throw new Error('Duplicate candidate ID.');
    ids.add(candidate.id);
    for (const evidence of candidate.evidence) {
      const message = messages.get(evidence.messageId);
      if (
        !message ||
        evidence.end <= evidence.start ||
        evidence.end > message.content.length ||
        message.content.slice(evidence.start, evidence.end) !== evidence.quote
      )
        throw new Error('Candidate evidence does not match an existing source span.');
    }
  }
  for (const candidate of result.candidates) {
    if (candidate.supersedes.some((id) => !ids.has(id) || id === candidate.id))
      throw new Error('Invalid supersession reference.');
  }
  for (const candidate of result.candidates) {
    const quotes = candidate.evidence.map((e) => e.quote);
    const sourceText = quotes.join('\n');
    const requireLiteral = (value: string | null) => {
      if (value !== null && !sourceText.toLowerCase().includes(value.toLowerCase()))
        throw new Error('Structured candidate field is absent from its source evidence.');
    };
    if (candidate.kind === 'board')
      for (const value of Object.values(candidate.details)) requireLiteral(value);
    if (candidate.kind === 'component') {
      requireLiteral(candidate.details.type);
      if (
        candidate.details.quantity !== null &&
        !quotes.some((q) =>
          new RegExp(
            `\\b${candidate.details.quantity}\\s*(?:[x×]\\s*)?${candidate.details.type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
            'i',
          ).test(q),
        )
      )
        throw new Error('Component quantity is not explicitly sourced.');
      if (candidate.details.resistanceOhms !== null) {
        const numericValues = quotes
          .flatMap((q) =>
            [
              ...q.matchAll(/\d+(?:\.\d+)?\s*(?:[µμmkM]|kilo|mega|micro|milli)?\s*(?:ohms?|Ω)/gi),
            ].map((m) => sourceDetails('component', `${m[0]} resistor`, q)),
          )
          .filter(
            (d): d is Extract<Candidate, { kind: 'component' }>['details'] => 'resistanceOhms' in d,
          );
        if (!numericValues.some((d) => d.resistanceOhms === candidate.details.resistanceOhms))
          throw new Error('Resistance is not explicitly sourced with a supported unit.');
      }
    }
    if (candidate.kind === 'connection')
      for (const endpoint of [candidate.details.from, candidate.details.to])
        if (endpoint) {
          requireLiteral(endpoint.label);
          if (
            endpoint.componentRef !== null &&
            !result.candidates.some(
              (c) =>
                c.id === endpoint.componentRef && (c.kind === 'board' || c.kind === 'component'),
            )
          )
            throw new Error('Invalid connection component reference.');
        }
    if (candidate.kind === 'firmware') {
      requireLiteral(candidate.details.content);
      if (
        candidate.details.language !== null &&
        !candidate.evidence.some((e) => {
          const m = messages.get(e.messageId)!;
          return m.codeBlocks.some(
            (block) =>
              block.language === candidate.details.language &&
              block.content === candidate.details.content,
          );
        })
      )
        throw new Error('Firmware language/content does not match a source code block.');
    }
    if (candidate.kind === 'requirement') requireLiteral(candidate.details.text);
  }
  const conflictIds = new Set<string>();
  for (const conflict of result.conflicts) {
    if (
      conflictIds.has(conflict.id) ||
      conflict.candidateIds.some((id) => !ids.has(id)) ||
      new Set(conflict.candidateIds).size < 2
    )
      throw new Error('Invalid conflict references.');
    conflictIds.add(conflict.id);
  }
  const byId = new Map(result.candidates.map((c) => [c.id, c]));
  for (const candidate of result.candidates) {
    const path = new Set<string>();
    const visit = (id: string): void => {
      if (path.has(id)) throw new Error('Cyclic supersession.');
      path.add(id);
      for (const parent of byId.get(id)!.supersedes) visit(parent);
      path.delete(id);
    };
    visit(candidate.id);
  }
  return result;
}
