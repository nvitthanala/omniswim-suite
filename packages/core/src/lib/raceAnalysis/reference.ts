export interface ReferenceBand {
  key: 'start' | 'fifteenMetreTime' | 'turnTime' | 'underwaterLimit';
  label: string;
  sourceUrl: string;
  retrievedAt: '2026-08-02';
  quote: string;
}

const SWIMCLOUD_ANALYSIS_URL =
  'https://support.swimcloud.com/hc/en-us/articles/360008576693-Analyzing-the-Data';

export const UNDERWATER_LEGAL_LIMIT_METRES = 15;

export const raceAnalysisReferenceBands: readonly ReferenceBand[] = [
  {
    key: 'start',
    label: 'Start',
    sourceUrl: SWIMCLOUD_ANALYSIS_URL,
    retrievedAt: '2026-08-02',
    quote: '.75 to 1.00 avg.',
  },
  {
    key: 'fifteenMetreTime',
    label: '15 m time',
    sourceUrl: SWIMCLOUD_ANALYSIS_URL,
    retrievedAt: '2026-08-02',
    quote: 'world-class swimmers get there in under 6 seconds. Senior kids should shoot for 6-7 seconds or better.',
  },
  {
    key: 'turnTime',
    label: 'Turn time',
    sourceUrl: SWIMCLOUD_ANALYSIS_URL,
    retrievedAt: '2026-08-02',
    quote: 'Generally speaking you are trying to keep the turn at 1.0 to 1.2 or less.',
  },
  {
    key: 'underwaterLimit',
    label: 'Underwater limit',
    sourceUrl: SWIMCLOUD_ANALYSIS_URL,
    retrievedAt: '2026-08-02',
    quote: 'you can only legally go 15 meters underwater.',
  },
] as const;

