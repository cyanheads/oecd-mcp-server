/**
 * @fileoverview Tests for the validation gate on the service root an OECD
 * catalog entry delegates to — the only place upstream response data is allowed
 * to influence where this server sends a request.
 * @module tests/services/oecd-http/external-service-root.test
 */

import { describe, expect, it } from 'vitest';
import {
  externalServiceRoot,
  externalServiceRootOf,
} from '@/services/oecd-http/external-service-root.js';

const BASE = 'https://sdmx.oecd.test/public/rest';

/** A dataflow payload shaped the way OECD publishes an external reference. */
function dataflowPayload(links: Array<Record<string, unknown>>): unknown {
  return {
    data: {
      dataflows: [
        {
          agencyID: 'OECD.STI.PIE',
          id: 'DSD_TIVA_EXGRVA@DF_EXGRVA',
          isExternalReference: true,
          links,
        },
      ],
    },
  };
}

describe('externalServiceRoot', () => {
  it('derives the service root from a delegation on the configured origin', () => {
    expect(
      externalServiceRoot(
        'https://sdmx.oecd.test/sti-public/rest/dataflow/OECD.STI.PIE/DSD_TIVA_EXGRVA@DF_EXGRVA/1.1',
        BASE,
      ),
    ).toBe('https://sdmx.oecd.test/sti-public/rest');
  });

  it('keeps only the service segment, discarding the rest of the href', () => {
    // The href names a specific dataflow and version; the root is all that survives.
    expect(
      externalServiceRoot(
        'https://sdmx.oecd.test/archive/rest/dataflow/OECD.SDD.TPS/DSD_PDB@DF_PDB_LV/1.0?references=all',
        BASE,
      ),
    ).toBe('https://sdmx.oecd.test/archive/rest');
  });

  it('refuses an href pointing at a different host', () => {
    expect(
      externalServiceRoot(
        'https://attacker.example/sti-public/rest/dataflow/OECD.STI.PIE/DSD_A@DF_B/1.0',
        BASE,
      ),
    ).toBeUndefined();
  });

  it('refuses userinfo that makes an attacker host read like the configured one', () => {
    // `https://sdmx.oecd.test@attacker.example/…` parses to host attacker.example.
    expect(
      externalServiceRoot(
        'https://sdmx.oecd.test@attacker.example/sti-public/rest/dataflow/OECD.STI.PIE/DSD_A@DF_B/1.0',
        BASE,
      ),
    ).toBeUndefined();
  });

  it('refuses a scheme other than https', () => {
    expect(
      externalServiceRoot(
        'http://sdmx.oecd.test/sti-public/rest/dataflow/OECD.STI.PIE/DSD_A@DF_B/1.0',
        BASE,
      ),
    ).toBeUndefined();
    expect(
      externalServiceRoot('file:///etc/passwd/rest/dataflow/OECD.STI.PIE/DSD_A@DF_B', BASE),
    ).toBeUndefined();
  });

  it('refuses a port the configured base does not use', () => {
    expect(
      externalServiceRoot(
        'https://sdmx.oecd.test:8443/sti-public/rest/dataflow/OECD.STI.PIE/DSD_A@DF_B/1.0',
        BASE,
      ),
    ).toBeUndefined();
  });

  it('refuses a path that is not the SDMX dataflow shape', () => {
    expect(
      externalServiceRoot('https://sdmx.oecd.test/sti-public/rest/data/OECD.STI.PIE,X/all', BASE),
    ).toBeUndefined();
    expect(externalServiceRoot('https://sdmx.oecd.test/rest/dataflow/A/B', BASE)).toBeUndefined();
    expect(externalServiceRoot('https://sdmx.oecd.test/', BASE)).toBeUndefined();
  });

  it('refuses a service segment carrying anything but SDMX identifier characters', () => {
    // A traversal segment resolves away before the regex ever sees it; an
    // encoded one survives parsing and has to be rejected on the characters.
    expect(
      externalServiceRoot('https://sdmx.oecd.test/%2e%2e/rest/dataflow/A/B', BASE),
    ).toBeUndefined();
    expect(
      externalServiceRoot('https://sdmx.oecd.test/.hidden/rest/dataflow/A/B', BASE),
    ).toBeUndefined();
  });

  it('refuses a value that is not a parseable URL string', () => {
    expect(externalServiceRoot(undefined, BASE)).toBeUndefined();
    expect(externalServiceRoot(42, BASE)).toBeUndefined();
    expect(externalServiceRoot({ href: 'https://sdmx.oecd.test/' }, BASE)).toBeUndefined();
    expect(externalServiceRoot('/sti-public/rest/dataflow/A/B', BASE)).toBeUndefined();
    expect(externalServiceRoot('not a url', BASE)).toBeUndefined();
  });
});

describe('externalServiceRootOf', () => {
  it('reads the root off the external link of a delegating entry', () => {
    const payload = dataflowPayload([
      { rel: 'self', href: 'https://sdmx.oecd.test/public/rest/dataflow/OECD.STI.PIE/X' },
      {
        rel: 'external',
        href: 'https://sdmx.oecd.test/sti-public/rest/dataflow/OECD.STI.PIE/DSD_TIVA_EXGRVA@DF_EXGRVA/1.1',
      },
    ]);

    expect(externalServiceRootOf(payload, BASE)).toBe('https://sdmx.oecd.test/sti-public/rest');
  });

  it('skips a link whose href does not survive validation', () => {
    const payload = dataflowPayload([
      { rel: 'external', href: 'https://attacker.example/sti-public/rest/dataflow/A/B' },
      {
        rel: 'external',
        href: 'https://sdmx.oecd.test/dcd-public/rest/dataflow/OECD.DCD.FSD/DSD_CRS@DF_CRS/1.6',
      },
    ]);

    expect(externalServiceRootOf(payload, BASE)).toBe('https://sdmx.oecd.test/dcd-public/rest');
  });

  it('resolves nothing for an entry carrying no external link', () => {
    expect(
      externalServiceRootOf(
        dataflowPayload([
          { rel: 'self', href: 'https://sdmx.oecd.test/public/rest/dataflow/OECD.STI.PIE/X' },
        ]),
        BASE,
      ),
    ).toBeUndefined();
    expect(externalServiceRootOf(dataflowPayload([]), BASE)).toBeUndefined();
    expect(externalServiceRootOf({ data: { dataflows: [] } }, BASE)).toBeUndefined();
    expect(externalServiceRootOf({}, BASE)).toBeUndefined();
    expect(externalServiceRootOf(undefined, BASE)).toBeUndefined();
  });
});
