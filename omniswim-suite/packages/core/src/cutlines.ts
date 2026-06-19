import type { NcaaDivision } from './types';

export type CutlineRecord = {
  division: NcaaDivision;
  gender: string;
  event: string;
  standard: 'A' | 'B';
  time_25_26: string;
  proj_26_27: string;
  proj_27_28: string;
  proj_28_29: string;
};

type CutlineRowRaw = Omit<CutlineRecord, 'division'>;

const D1_CUTLINE_ROWS: CutlineRowRaw[] = [
  {"gender": "Men", "event": "50 Freestyle", "standard": "A", "time_25_26": "19.39", "proj_26_27": "19.35", "proj_27_28": "19.30", "proj_28_29": "19.26"},
  {"gender": "Men", "event": "50 Freestyle", "standard": "B", "time_25_26": "20.36", "proj_26_27": "20.31", "proj_27_28": "20.26", "proj_28_29": "20.21"},
  {"gender": "Men", "event": "100 Freestyle", "standard": "A", "time_25_26": "43.08", "proj_26_27": "43.06", "proj_27_28": "43.04", "proj_28_29": "43.02"},
  {"gender": "Men", "event": "100 Freestyle", "standard": "B", "time_25_26": "45.23", "proj_26_27": "45.20", "proj_27_28": "45.18", "proj_28_29": "45.15"},
  {"gender": "Men", "event": "200 Freestyle", "standard": "A", "time_25_26": "1:34.74", "proj_26_27": "1:34.38", "proj_27_28": "1:34.03", "proj_28_29": "1:33.67"},
  {"gender": "Men", "event": "200 Freestyle", "standard": "B", "time_25_26": "1:39.48", "proj_26_27": "1:39.11", "proj_27_28": "1:38.74", "proj_28_29": "1:38.37"},
  {"gender": "Men", "event": "500 Freestyle", "standard": "A", "time_25_26": "4:19.98", "proj_26_27": "4:19.09", "proj_27_28": "4:18.20", "proj_28_29": "4:17.31"},
  {"gender": "Men", "event": "500 Freestyle", "standard": "B", "time_25_26": "4:32.98", "proj_26_27": "4:32.05", "proj_27_28": "4:31.12", "proj_28_29": "4:30.19"},
  {"gender": "Men", "event": "1000 Freestyle", "standard": "A", "time_25_26": "8:58.94", "proj_26_27": "8:57.10", "proj_27_28": "8:55.25", "proj_28_29": "8:53.41"},
  {"gender": "Men", "event": "1000 Freestyle", "standard": "B", "time_25_26": "9:25.89", "proj_26_27": "9:23.95", "proj_27_28": "9:22.02", "proj_28_29": "9:20.08"},
  {"gender": "Men", "event": "1650 Freestyle", "standard": "A", "time_25_26": "15:11.41", "proj_26_27": "15:10.85", "proj_27_28": "15:10.29", "proj_28_29": "15:09.73"},
  {"gender": "Men", "event": "1650 Freestyle", "standard": "B", "time_25_26": "15:56.98", "proj_26_27": "15:56.40", "proj_27_28": "15:55.81", "proj_28_29": "15:55.23"},
  {"gender": "Men", "event": "100 Backstroke", "standard": "A", "time_25_26": "46.32", "proj_26_27": "46.24", "proj_27_28": "46.17", "proj_28_29": "46.09"},
  {"gender": "Men", "event": "100 Backstroke", "standard": "B", "time_25_26": "48.64", "proj_26_27": "48.56", "proj_27_28": "48.49", "proj_28_29": "48.41"},
  {"gender": "Men", "event": "200 Backstroke", "standard": "A", "time_25_26": "1:42.18", "proj_26_27": "1:41.88", "proj_27_28": "1:41.58", "proj_28_29": "1:41.28"},
  {"gender": "Men", "event": "200 Backstroke", "standard": "B", "time_25_26": "1:47.29", "proj_26_27": "1:46.97", "proj_27_28": "1:46.66", "proj_28_29": "1:46.34"},
  {"gender": "Men", "event": "100 Breaststroke", "standard": "A", "time_25_26": "52.60", "proj_26_27": "52.44", "proj_27_28": "52.29", "proj_28_29": "52.13"},
  {"gender": "Men", "event": "100 Breaststroke", "standard": "B", "time_25_26": "55.23", "proj_26_27": "55.06", "proj_27_28": "54.90", "proj_28_29": "54.73"},
  {"gender": "Men", "event": "200 Breaststroke", "standard": "A", "time_25_26": "1:55.12", "proj_26_27": "1:55.12", "proj_27_28": "1:55.12", "proj_28_29": "1:55.12"},
  {"gender": "Men", "event": "200 Breaststroke", "standard": "B", "time_25_26": "2:00.87", "proj_26_27": "2:00.87", "proj_27_28": "2:00.87", "proj_28_29": "2:00.87"},
  {"gender": "Men", "event": "100 Butterfly", "standard": "A", "time_25_26": "46.17", "proj_26_27": "46.03", "proj_27_28": "45.89", "proj_28_29": "45.75"},
  {"gender": "Men", "event": "100 Butterfly", "standard": "B", "time_25_26": "48.48", "proj_26_27": "48.33", "proj_27_28": "48.19", "proj_28_29": "48.04"},
  {"gender": "Men", "event": "200 Butterfly", "standard": "A", "time_25_26": "1:44.66", "proj_26_27": "1:44.66", "proj_27_28": "1:44.66", "proj_28_29": "1:44.66"},
  {"gender": "Men", "event": "200 Butterfly", "standard": "B", "time_25_26": "1:49.89", "proj_26_27": "1:49.89", "proj_27_28": "1:49.89", "proj_28_29": "1:49.89"},
  {"gender": "Men", "event": "200 Individual Medley", "standard": "A", "time_25_26": "1:44.60", "proj_26_27": "1:43.97", "proj_27_28": "1:43.34", "proj_28_29": "1:42.71"},
  {"gender": "Men", "event": "200 Individual Medley", "standard": "B", "time_25_26": "1:49.83", "proj_26_27": "1:49.17", "proj_27_28": "1:48.51", "proj_28_29": "1:47.85"},
  {"gender": "Men", "event": "400 Individual Medley", "standard": "A", "time_25_26": "3:46.91", "proj_26_27": "3:46.33", "proj_27_28": "3:45.75", "proj_28_29": "3:45.17"},
  {"gender": "Men", "event": "400 Individual Medley", "standard": "B", "time_25_26": "3:58.26", "proj_26_27": "3:57.65", "proj_27_28": "3:57.04", "proj_28_29": "3:56.43"},
  {"gender": "Men", "event": "200 Freestyle Relay", "standard": "B", "time_25_26": "1:19.88", "proj_26_27": "1:19.58", "proj_27_28": "1:19.27", "proj_28_29": "1:18.97"},
  {"gender": "Men", "event": "400 Freestyle Relay", "standard": "B", "time_25_26": "2:56.83", "proj_26_27": "2:56.01", "proj_27_28": "2:55.19", "proj_28_29": "2:54.37"},
  {"gender": "Men", "event": "800 Freestyle Relay", "standard": "B", "time_25_26": "6:33.68", "proj_26_27": "6:32.74", "proj_27_28": "6:31.80", "proj_28_29": "6:30.86"},
  {"gender": "Men", "event": "200 Medley Relay", "standard": "B", "time_25_26": "1:27.39", "proj_26_27": "1:27.09", "proj_27_28": "1:26.79", "proj_28_29": "1:26.49"},
  {"gender": "Men", "event": "400 Medley Relay", "standard": "B", "time_25_26": "3:12.57", "proj_26_27": "3:11.43", "proj_27_28": "3:10.28", "proj_28_29": "3:09.14"},
  {"gender": "Women", "event": "50 Freestyle", "standard": "A", "time_25_26": "22.50", "proj_26_27": "22.39", "proj_27_28": "22.28", "proj_28_29": "22.17"},
  {"gender": "Women", "event": "50 Freestyle", "standard": "B", "time_25_26": "23.62", "proj_26_27": "23.50", "proj_27_28": "23.38", "proj_28_29": "23.26"},
  {"gender": "Women", "event": "100 Freestyle", "standard": "A", "time_25_26": "49.47", "proj_26_27": "49.41", "proj_27_28": "49.36", "proj_28_29": "49.30"},
  {"gender": "Women", "event": "100 Freestyle", "standard": "B", "time_25_26": "51.94", "proj_26_27": "51.88", "proj_27_28": "51.82", "proj_28_29": "51.76"},
  {"gender": "Women", "event": "200 Freestyle", "standard": "A", "time_25_26": "1:47.32", "proj_26_27": "1:47.13", "proj_27_28": "1:46.94", "proj_28_29": "1:46.75"},
  {"gender": "Women", "event": "200 Freestyle", "standard": "B", "time_25_26": "1:52.69", "proj_26_27": "1:52.50", "proj_27_28": "1:52.30", "proj_28_29": "1:52.11"},
  {"gender": "Women", "event": "500 Freestyle", "standard": "A", "time_25_26": "4:49.42", "proj_26_27": "4:48.98", "proj_27_28": "4:48.54", "proj_28_29": "4:48.10"},
  {"gender": "Women", "event": "500 Freestyle", "standard": "B", "time_25_26": "5:03.89", "proj_26_27": "5:03.43", "proj_27_28": "5:02.96", "proj_28_29": "5:02.50"},
  {"gender": "Women", "event": "1000 Freestyle", "standard": "A", "time_25_26": "9:52.78", "proj_26_27": "9:51.78", "proj_27_28": "9:50.79", "proj_28_29": "9:49.79"},
  {"gender": "Women", "event": "1000 Freestyle", "standard": "B", "time_25_26": "10:22.42", "proj_26_27": "10:21.38", "proj_27_28": "10:20.33", "proj_28_29": "10:19.29"},
  {"gender": "Women", "event": "1650 Freestyle", "standard": "A", "time_25_26": "16:31.17", "proj_26_27": "16:31.17", "proj_27_28": "16:31.17", "proj_28_29": "16:31.17"},
  {"gender": "Women", "event": "1650 Freestyle", "standard": "B", "time_25_26": "17:20.73", "proj_26_27": "17:20.73", "proj_27_28": "17:20.73", "proj_28_29": "17:20.73"},
  {"gender": "Women", "event": "100 Backstroke", "standard": "A", "time_25_26": "53.49", "proj_26_27": "53.48", "proj_27_28": "53.47", "proj_28_29": "53.46"},
  {"gender": "Women", "event": "100 Backstroke", "standard": "B", "time_25_26": "56.16", "proj_26_27": "56.15", "proj_27_28": "56.14", "proj_28_29": "56.13"},
  {"gender": "Women", "event": "200 Backstroke", "standard": "A", "time_25_26": "1:57.00", "proj_26_27": "1:57.00", "proj_27_28": "1:57.00", "proj_28_29": "1:57.00"},
  {"gender": "Women", "event": "200 Backstroke", "standard": "B", "time_25_26": "2:02.85", "proj_26_27": "2:02.85", "proj_27_28": "2:02.85", "proj_28_29": "2:02.85"},
  {"gender": "Women", "event": "100 Breaststroke", "standard": "A", "time_25_26": "1:01.03", "proj_26_27": "1:01.03", "proj_27_28": "1:01.03", "proj_28_29": "1:01.03"},
  {"gender": "Women", "event": "100 Breaststroke", "standard": "B", "time_25_26": "1:04.08", "proj_26_27": "1:04.08", "proj_27_28": "1:04.08", "proj_28_29": "1:04.08"},
  {"gender": "Women", "event": "200 Breaststroke", "standard": "A", "time_25_26": "2:13.06", "proj_26_27": "2:13.06", "proj_27_28": "2:13.06", "proj_28_29": "2:13.06"},
  {"gender": "Women", "event": "200 Breaststroke", "standard": "B", "time_25_26": "2:19.71", "proj_26_27": "2:19.71", "proj_27_28": "2:19.71", "proj_28_29": "2:19.71"},
  {"gender": "Women", "event": "100 Butterfly", "standard": "A", "time_25_26": "53.37", "proj_26_27": "53.37", "proj_27_28": "53.37", "proj_28_29": "53.37"},
  {"gender": "Women", "event": "100 Butterfly", "standard": "B", "time_25_26": "56.04", "proj_26_27": "56.04", "proj_27_28": "56.04", "proj_28_29": "56.04"},
  {"gender": "Women", "event": "200 Butterfly", "standard": "A", "time_25_26": "1:58.97", "proj_26_27": "1:58.81", "proj_27_28": "1:58.64", "proj_28_29": "1:58.48"},
  {"gender": "Women", "event": "200 Butterfly", "standard": "B", "time_25_26": "2:04.92", "proj_26_27": "2:04.75", "proj_27_28": "2:04.58", "proj_28_29": "2:04.41"},
  {"gender": "Women", "event": "200 Individual Medley", "standard": "A", "time_25_26": "1:59.39", "proj_26_27": "1:59.39", "proj_27_28": "1:59.39", "proj_28_29": "1:59.39"},
  {"gender": "Women", "event": "200 Individual Medley", "standard": "B", "time_25_26": "2:05.36", "proj_26_27": "2:05.36", "proj_27_28": "2:05.36", "proj_28_29": "2:05.36"},
  {"gender": "Women", "event": "400 Individual Medley", "standard": "A", "time_25_26": "4:16.33", "proj_26_27": "4:15.65", "proj_27_28": "4:14.97", "proj_28_29": "4:14.29"},
  {"gender": "Women", "event": "400 Individual Medley", "standard": "B", "time_25_26": "4:29.14", "proj_26_27": "4:28.43", "proj_27_28": "4:27.71", "proj_28_29": "4:27.00"},
  {"gender": "Women", "event": "200 Freestyle Relay", "standard": "B", "time_25_26": "1:33.14", "proj_26_27": "1:32.79", "proj_27_28": "1:32.45", "proj_28_29": "1:32.10"},
  {"gender": "Women", "event": "400 Freestyle Relay", "standard": "B", "time_25_26": "3:24.60", "proj_26_27": "3:24.30", "proj_27_28": "3:24.01", "proj_28_29": "3:23.71"},
  {"gender": "Women", "event": "800 Freestyle Relay", "standard": "B", "time_25_26": "7:27.03", "proj_26_27": "7:25.62", "proj_27_28": "7:24.22", "proj_28_29": "7:22.81"},
  {"gender": "Women", "event": "200 Medley Relay", "standard": "B", "time_25_26": "1:42.20", "proj_26_27": "1:41.88", "proj_27_28": "1:41.56", "proj_28_29": "1:41.24"},
  {"gender": "Women", "event": "400 Medley Relay", "standard": "B", "time_25_26": "3:44.86", "proj_26_27": "3:44.54", "proj_27_28": "3:44.23", "proj_28_29": "3:43.91"}
];

/** NCAA D1 championship qualifying standards (existing table). */
export const cutlines: CutlineRecord[] = D1_CUTLINE_ROWS.map(row => ({
  ...row,
  division: 'D1' as NcaaDivision,
}));

/** Placeholder exports for future D2/D3/NAIA tables — append rows then merge into `cutlines`. */
export const D2_CUTLINE_ROWS: CutlineRowRaw[] = [];
export const D3_CUTLINE_ROWS: CutlineRowRaw[] = [];
export const NAIA_CUTLINE_ROWS: CutlineRowRaw[] = [];

export function allCutlines(): CutlineRecord[] {
  return [
    ...cutlines,
    ...D2_CUTLINE_ROWS.map(row => ({ ...row, division: 'D2' as NcaaDivision })),
    ...D3_CUTLINE_ROWS.map(row => ({ ...row, division: 'D3' as NcaaDivision })),
    ...NAIA_CUTLINE_ROWS.map(row => ({ ...row, division: 'NAIA' as NcaaDivision })),
  ];
}
