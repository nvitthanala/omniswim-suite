/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The swimmer-times endpoint is learned from the page, never written down.
 *
 * A swimmer's `/times/` page builds its table in the browser, so fetching it
 * returns a 15-17 KB shell — proven on all 73 stored pages that returned HTTP
 * 200. The data comes from a request the page's own bundle makes. These tests
 * cover the rules for reading that request out of Resource Timing, and in
 * particular the rules for *rejecting* one, because a wrong endpoint here would
 * file one swimmer's times under everybody else's name.
 *
 * No real observation exists yet — this session may not touch swimcloud.com —
 * so the entries below are synthetic and say so. What they exercise is the
 * filtering logic, which is where the damage would be done.
 */

import { describe, expect, it } from 'vitest';
import {
  SWIMMER_ID_PLACEHOLDER,
  discoverSwimmerTimesEndpoints,
  swimmerTimesEndpointReport,
  swimmerTimesUrlFromTemplate,
} from '../extensions/swimcloud-companion/src/timesEndpointDiscovery';

const SWIMMER = '1028842';

/** Entries in the shape Resource Timing reports, synthetic. */
const entry = (name: string, initiatorType = 'fetch') => ({ name, initiatorType });

describe('discoverSwimmerTimesEndpoints', () => {
  it('keeps a SwimCloud data request that carries the swimmer id', () => {
    const found = discoverSwimmerTimesEndpoints(
      [entry(`https://www.swimcloud.com/api/swimmer/${SWIMMER}/times/?season=30`)],
      SWIMMER,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.url).toBe(`https://www.swimcloud.com/api/swimmer/${SWIMMER}/times/?season=30`);
    expect(found[0]?.template).toBe(
      `https://www.swimcloud.com/api/swimmer/${SWIMMER_ID_PLACEHOLDER}/times/?season=30`,
    );
  });

  it('ignores the bundle and the stylesheet that loaded it', () => {
    // These are the entries that definitely exist on the real page. Neither is
    // the data; both mention nothing useful.
    const found = discoverSwimmerTimesEndpoints(
      [
        entry('https://www.swimcloud.com/media/webpack/swimmerProfileTimes/index.1788442886.js', 'script'),
        entry('https://www.swimcloud.com/media/webpack/swimmerProfileTimes/index.1777471821.css', 'link'),
      ],
      SWIMMER,
    );
    expect(found).toStrictEqual([]);
  });

  it('ignores third-party data requests, which this page really does make', () => {
    // Sentry, Google Analytics and Chartbeat are all on the stored shell and
    // all make genuine fetch/XHR calls. Treating one as the times endpoint
    // would be both wrong and a privacy problem.
    const found = discoverSwimmerTimesEndpoints(
      [
        entry(`https://o375140.ingest.sentry.io/api/5199088/envelope/?swimmer=${SWIMMER}`),
        entry(`https://www.google-analytics.com/g/collect?cid=${SWIMMER}`),
        entry(`https://ping.chartbeat.net/ping?u=${SWIMMER}`, 'xmlhttprequest'),
      ],
      SWIMMER,
    );
    expect(found).toStrictEqual([]);
  });

  it('rejects a SwimCloud data request that does not name the swimmer', () => {
    // This is the filter that matters most. Such a URL cannot be turned into a
    // request for anyone else, so a template built from it would return the
    // discovered swimmer's times for all 184 swimmers — plausible rows, wrong
    // people, which is precisely what this repo's provenance rules exist to
    // prevent. Reporting nothing is the correct outcome.
    const found = discoverSwimmerTimesEndpoints(
      [entry('https://www.swimcloud.com/api/times/?season=30&course=Y')],
      SWIMMER,
    );
    expect(found).toStrictEqual([]);
  });

  it('accepts an XHR, because this page ships jQuery and a CSRF cookie for it', () => {
    const found = discoverSwimmerTimesEndpoints(
      [entry(`https://www.swimcloud.com/swimmer/${SWIMMER}/times/data/`, 'xmlhttprequest')],
      SWIMMER,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.initiatorType).toBe('xmlhttprequest');
  });

  it('templates every occurrence of the id, not just the first', () => {
    const found = discoverSwimmerTimesEndpoints(
      [entry(`https://www.swimcloud.com/api/swimmer/${SWIMMER}/times/?ref=${SWIMMER}`)],
      SWIMMER,
    );
    expect(found[0]?.template).toBe(
      `https://www.swimcloud.com/api/swimmer/${SWIMMER_ID_PLACEHOLDER}/times/?ref=${SWIMMER_ID_PLACEHOLDER}`,
    );
  });

  it('reports one candidate once, however many times the page asked', () => {
    const url = `https://www.swimcloud.com/api/swimmer/${SWIMMER}/times/`;
    expect(discoverSwimmerTimesEndpoints([entry(url), entry(url), entry(url)], SWIMMER)).toHaveLength(1);
  });

  it('returns both candidates rather than choosing between them', () => {
    // Two plausible endpoints is not a decision this module has evidence to
    // make. A human reads them.
    const found = discoverSwimmerTimesEndpoints(
      [
        entry(`https://www.swimcloud.com/api/swimmer/${SWIMMER}/times/`),
        entry(`https://www.swimcloud.com/api/swimmer/${SWIMMER}/meets/`),
      ],
      SWIMMER,
    );
    expect(found.map((c) => c.url)).toStrictEqual([
      `https://www.swimcloud.com/api/swimmer/${SWIMMER}/times/`,
      `https://www.swimcloud.com/api/swimmer/${SWIMMER}/meets/`,
    ]);
  });

  it('finds nothing when given no swimmer id', () => {
    expect(
      discoverSwimmerTimesEndpoints([entry('https://www.swimcloud.com/api/swimmer/1/times/')], ''),
    ).toStrictEqual([]);
  });
});

describe('swimmerTimesUrlFromTemplate', () => {
  it('substitutes the swimmer id', () => {
    expect(
      swimmerTimesUrlFromTemplate(`https://www.swimcloud.com/api/swimmer/${SWIMMER_ID_PLACEHOLDER}/times/`, '42'),
    ).toBe('https://www.swimcloud.com/api/swimmer/42/times/');
  });

  it('refuses a template with no placeholder', () => {
    // The whole point. Returning the template unchanged would request the
    // swimmer it was discovered on and store the result under a different
    // swimmer's name.
    expect(swimmerTimesUrlFromTemplate('https://www.swimcloud.com/api/swimmer/1028842/times/', '42')).toBeUndefined();
  });

  it('refuses an id that is not a plain number', () => {
    // A SwimCloud swimmer id is digits. Anything else reaching here is a bug
    // upstream, and interpolating it would build a URL nothing has shown to
    // exist — and could smuggle a path segment into it.
    const t = `https://www.swimcloud.com/api/swimmer/${SWIMMER_ID_PLACEHOLDER}/times/`;
    expect(swimmerTimesUrlFromTemplate(t, '../../admin')).toBeUndefined();
    expect(swimmerTimesUrlFromTemplate(t, '42?x=1')).toBeUndefined();
    expect(swimmerTimesUrlFromTemplate(t, '')).toBeUndefined();
  });
});

describe('swimmerTimesEndpointReport', () => {
  const base = { pageUrl: `https://www.swimcloud.com/swimmer/${SWIMMER}/times/`, swimmerId: SWIMMER };

  it('tells an empty buffer apart from a page that named no swimmer', () => {
    // Two different problems with two different fixes: reload with the
    // extension installed, versus read the Network tab because the id is in a
    // POST body this cannot see.
    const nothingRecorded = swimmerTimesEndpointReport({ ...base, candidates: [], entriesSeen: 0 });
    expect(nothingRecorded).toContain('No resource timing entries were recorded');

    const recordedButNoMatch = swimmerTimesEndpointReport({ ...base, candidates: [], entriesSeen: 37 });
    expect(recordedButNoMatch).toContain('POST body');
    expect(recordedButNoMatch).not.toContain('No resource timing entries were recorded');
  });

  it('prints each candidate with its template', () => {
    const report = swimmerTimesEndpointReport({
      ...base,
      seasonIds: '[30, 29, 28]',
      entriesSeen: 40,
      candidates: [
        {
          url: `https://www.swimcloud.com/api/swimmer/${SWIMMER}/times/`,
          template: `https://www.swimcloud.com/api/swimmer/${SWIMMER_ID_PLACEHOLDER}/times/`,
          initiatorType: 'fetch',
        },
      ],
    });
    expect(report).toContain('1 candidate request(s)');
    expect(report).toContain('[fetch] https://www.swimcloud.com/api/swimmer/1028842/times/');
    expect(report).toContain(`template: https://www.swimcloud.com/api/swimmer/${SWIMMER_ID_PLACEHOLDER}/times/`);
    expect(report).toContain('season ids:  [30, 29, 28]');
  });
});
