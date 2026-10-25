// Independent reader of the documented table contract for semantic assertions.
export function readableReplyWire(input) {
  if (!input.messageEncoding) return input;
  const { messageEncoding: schema, ...result } = input;
  result.messages = input.messages.map(values => {
    const row = Object.fromEntries(schema.columns.map((name, index) => [name, values[index]]));
    const author = schema.authors[row.author];
    return { id: row.id, direction: author.direction, speaker: structuredClone(author.speaker),
      authorship: row.authorship, aiGenerated: row.aiGenerated, timestamp: row.timestamp,
      sourceDate: row.sourceDate, temporal: { ...schema.temporalDefaults, ...row.temporal, sourceDate: row.sourceDate },
      pending: row.pending, ...structuredClone(row.fields) };
  });
  return result;
}
