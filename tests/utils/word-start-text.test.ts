/**
 * @fileoverview Tests for word-start token matching: where a word starts, and
 * that the scan stays linear in the text on its worst shapes.
 * @module tests/utils/word-start-text.test
 */

import { describe, expect, it } from 'vitest';
import { WordStartText } from '@/utils/word-start-text.js';

describe('WordStartText', () => {
  it.each([
    ['the start of the text', 'TiVA 2025 edition', 'tiva'],
    ['a space', 'Trade in Value Added', 'value'],
    ['a hyphen', 'Child well-being', 'being'],
    ['a parenthesis', 'Trade in Value Added (TiVA)', 'tiva'],
    ['an apostrophe', "Côte d'Ivoire", 'ivoire'],
    ['an ampersand', 'R&D expenditure', 'd'],
    ['a lowercase-to-uppercase step', 'RioMarkers: Aid (ODA) activities', 'markers'],
    ['a digit-led word', 'Inventory 2025 edition', '2025'],
  ])('matches a token after %s', (_boundary, text, token) => {
    expect(new WordStartText(text).matches(token)).toBe(true);
  });

  it.each([
    ['a letter', 'Strictness of activation requirements', 'tiva'],
    ['a letter, in a description', 'emissions of greenhouse gases', 'house'],
    ['an accented letter', 'Côte', 'te'],
    ['a digit', 'G20 economies', '20'],
    ['a letter before a digit', 'HS2017 classification', '2017'],
    ['an uppercase letter', 'ICT access', 'ct'],
  ])('does not match a token after %s', (_boundary, text, token) => {
    expect(new WordStartText(text).matches(token)).toBe(false);
  });

  it.each([
    ['an ampersand on its own', 'R&D expenditure', '&'],
    ['a hyphen-led token', 'Non-OECD economies', '-oecd'],
    ['an apostrophe-led token', 'People’s Republic of China', '’s'],
  ])('matches %s wherever it occurs, since a separator opens no word', (_shape, text, token) => {
    expect(new WordStartText(text).matches(token)).toBe(true);
  });

  it('reads the token as a prefix and ignores the case of the text', () => {
    const text = new WordStartText('Analytical HOUSE Prices indicators');

    expect(text.matches('price')).toBe(true);
    expect(text.matches('house')).toBe(true);
  });

  it('keeps scanning past mid-word occurrences to a later word start', () => {
    expect(new WordStartText('activation, cultivated, then (TiVA)').matches('tiva')).toBe(true);
  });

  it('starts words only at separators when lowercasing moves the offsets', () => {
    // U+0130 lowercases to two code units, so the published case cannot be read
    // at the offsets the lowercased text is searched at.
    const text = new WordStartText('İzmir RioMarkers');

    expect(text.matches('rio')).toBe(true);
    expect(text.matches('markers')).toBe(false);
    // Read one code unit off, the published text shows `oM` where `omarkers` sits mid-word.
    expect(text.matches('omarkers')).toBe(false);
  });
});

/**
 * CPU growth of a full field match — lowercasing and the scan — across a 64-fold
 * span of text, on shapes that send the scan to an occurrence test at every
 * character or two and never find a word start. Thread CPU time, least of
 * several trials, with the 5k baseline re-timed beside each size.
 */
describe('WordStartText timing', () => {
  const BASE_CHARS = 5_000;
  const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const TRIALS = 5;
  /** Characters scanned per measurement, so the 5k input is timed over a batch of calls. */
  const CHARS_PER_MEASUREMENT = 640_000;
  /** Per-call ceiling at any size, in microseconds of thread CPU time. */
  const CPU_CEILING_US = 100_000;

  function cpuPerCallUs(text: string, token: string): number {
    const calls = Math.max(1, Math.round(CHARS_PER_MEASUREMENT / text.length));
    let found = 0;
    const start = process.threadCpuUsage();
    for (let i = 0; i < calls; i++) if (new WordStartText(text).matches(token)) found++;
    const { user, system } = process.threadCpuUsage(start);
    expect(found).toBe(0);
    return (user + system) / calls;
  }

  it.each([
    ['one long line ending in a break', (n: number) => `x${'y1 x'.repeat(n / 4)}\ny`, '1'],
    ['breaks throughout', (n: number) => 'xa  \r\n'.repeat(n / 6), 'a'],
    ['overlapping occurrences', (n: number) => `x${'a'.repeat(n)}`, 'aaaaaaaa'],
    ['an uppercase run at every occurrence', (n: number) => 'XA'.repeat(n / 2), 'a'],
    ['a long digit run', (n: number) => `x${'1'.repeat(n)}`, '1'],
    ['a prefix that never completes', (n: number) => 'activ '.repeat(n / 6), 'activa'],
  ])(
    'stays linear on %s',
    (_shape, build, token) => {
      const base = build(BASE_CHARS);
      for (const size of SIZES) {
        const sample = build(size);
        let leastGrowth = Number.POSITIVE_INFINITY;
        let leastCpu = Number.POSITIVE_INFINITY;
        for (let trial = 0; trial < TRIALS; trial++) {
          const baseline = cpuPerCallUs(base, token);
          const cpu = cpuPerCallUs(sample, token);
          leastGrowth = Math.min(leastGrowth, cpu / baseline);
          leastCpu = Math.min(leastCpu, cpu);
        }
        expect(leastGrowth, `growth at ${size} characters`).toBeLessThan(4 * (size / BASE_CHARS));
        expect(leastCpu, `CPU per call at ${size} characters`).toBeLessThan(CPU_CEILING_US);
      }
    },
    0,
  );
});
