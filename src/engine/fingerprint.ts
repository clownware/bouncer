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

/**
 * Walks code points by index rather than with `for (const char of text)`.
 *
 * The same hash, deliberately: the surrogate branch is what makes it the same, and
 * `test/fingerprint.test.ts` pins the exact output for the cases where the two spellings
 * could diverge. A fingerprint names a policy in the decision log, so a line written before
 * this change and one written after have to agree about the same file.
 *
 * The string iterator allocates a one-character string per code point, which on the shipped
 * 27.5 KB policy cost about 5 ms in a cold process against about 2 ms for this loop — most
 * of the hook's cold-start regression over 2026-09-19's correctness pass, paid on the first
 * call of every session and after every policy edit.
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // A surrogate pair is one code point. Anything else, a lone surrogate included, is its
    // own code unit — which is exactly what `codePointAt` yields for it too.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}-${hash.toString(16).padStart(8, "0")}`;
}
