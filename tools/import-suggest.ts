const targets = [
  'first_name', 'last_name', 'email', 'phone', 'company', 'amount_cents',
  'amount_decimal', 'contact_person', 'campaign', 'occurred_at', 'currency',
  'external_id', 'ignore', 'unknown',
] as const;

type Column = { header: string; samples: string[] };
type Target = typeof targets[number];

export function suggestionRequest(columns: Column[]) {
  return {
    model: 'jev-latest',
    state: JSON.stringify(columns.map(({ header }) => header)),
    questions: {
      column: {
        type: 'choice',
        instructions: 'Choose the best import field for each source column. Source header: ' +
          columns.map(({ header }) => header).join(', '),
        criteria: Object.fromEntries(targets.map((target) => [target, target])),
      },
    },
  };
}

export function readSuggestion(response: unknown): {
  accepted: boolean;
  target: Target;
  confidence: number;
} {
  const answer = (response as { answers?: { column?: Record<string, unknown> } } | null)
    ?.answers?.column;
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string' ||
      !targets.includes(answer.choice as Target) || !answer.probabilities ||
      typeof answer.probabilities !== 'object' ||
      typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) {
    throw new Error('Invalid column suggestion');
  }

  const target = answer.choice as Target;
  const probability = (answer.probabilities as Record<string, unknown>)[target];
  if (typeof probability !== 'number' || !Number.isFinite(probability)) {
    throw new Error('Invalid column suggestion');
  }
  return {
    accepted: target !== 'ignore' && target !== 'unknown' &&
      answer.confidence >= 0.8 && probability >= 0.8,
    target,
    confidence: answer.confidence,
  };
}

export async function suggestColumn(
  column: Column,
  fetchImpl: typeof fetch = fetch,
): Promise<ReturnType<typeof readSuggestion>> {
  const key = process.env.JEV_API_KEY;
  if (!key) throw new Error('JEV_API_KEY is required');

  const response = await fetchImpl('https://jevmodel.net/v1/systemone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(suggestionRequest([column])),
  });
  if (response.status !== 200) {
    throw new Error(`Suggestion request failed (${response.status})`);
  }
  return readSuggestion(await response.json());
}
