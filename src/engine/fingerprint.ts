// A short, stable name for a piece of text, so a record can say which policy produced it.

/**
 * FNV-1a over the text, with its length in front.
 *
 * Not a crypto hash, for the reason `registry.ts` and `policycache.ts` both give: this
 * identifies a configuration, it does not protect one, and `node:crypto` costs the hook 10
 * to 15 ms to import (docs/adr/007). Two policies colliding costs a re-score that is told
 * nothing changed when something did; the length makes that rarer still, and the record
 * carries the question names beside it.
 */
/**
 * The fingerprint of what a set asks.
 *
 * By name, sorted, so moving a question up the file is not a change: the questions are
 * answered independently and their order means nothing to the classifier.
 */
export function fingerprintQuestions(
  questions: Readonly<Record<string, unknown>>,
  probeQuestions: Readonly<Record<string, unknown>>,
): string {
  const sorted = (record: Readonly<Record<string, unknown>>) =>
    Object.keys(record).sort().map((name) => [name, record[name]]);
  return fingerprint(JSON.stringify([sorted(questions), sorted(probeQuestions)]));
}

export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}-${hash.toString(16).padStart(8, "0")}`;
}
