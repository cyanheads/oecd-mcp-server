/**
 * @fileoverview Case-insensitive token matching anchored at the start of a word.
 * @module utils/word-start-text
 */

/** A letter or digit continues a word; any other character ends one. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const LOWERCASE_LETTER = /\p{Ll}/u;
const UPPERCASE_LETTER = /\p{Lu}/u;

/**
 * Text prepared once for testing many tokens against it. A token matches where it
 * starts a word: at the start of the text, after a character that is neither a
 * letter nor a digit (space, hyphen, parenthesis, apostrophe, `&`), or at a
 * lowercase-to-uppercase step in the text as published (`RioMarkers`). Matching
 * ignores case and reads the token as a prefix, so `price` matches `Prices` and
 * `tiva` matches `(TiVA)` but not `activation`. A token that opens on such a
 * separator (`&`, `-oecd`) matches wherever it occurs: it cannot sit inside a
 * word, so `science & technology` still finds the flows that write `R&D`.
 */
export class WordStartText {
  /** The text lowercased, which tokens are searched in. */
  readonly #folded: string;
  /**
   * The text as published, read for its case at a candidate camelCase step. Kept
   * only when lowercasing moved no offset; without it, only separators start words.
   */
  readonly #published: string | undefined;

  constructor(text: string) {
    this.#folded = text.toLowerCase();
    this.#published = this.#folded.length === text.length ? text : undefined;
  }

  /**
   * True when `token`, already lowercased, starts a word somewhere in the text,
   * or, when it opens on a separator, occurs anywhere in it. One `indexOf` scan
   * with a fixed character-class test at each occurrence; no pattern is built
   * from the token.
   */
  matches(token: string): boolean {
    const folded = this.#folded;
    if (!WORD_CHAR.test(token.charAt(0))) return folded.includes(token);
    const published = this.#published;
    for (let at = folded.indexOf(token); at !== -1; at = folded.indexOf(token, at + 1)) {
      if (at === 0 || !WORD_CHAR.test(folded.charAt(at - 1))) return true;
      if (
        published !== undefined &&
        LOWERCASE_LETTER.test(published.charAt(at - 1)) &&
        UPPERCASE_LETTER.test(published.charAt(at))
      ) {
        return true;
      }
    }
    return false;
  }
}
