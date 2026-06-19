export interface LapSplit {
  lap: number;
  time: number;
  distance: number;
}

export interface BiomechanicsData {
  splits: LapSplit[];
  avgVelocity: number;
  strokeRate: number;
  distancePerStroke: number;
  fatigueIndex: number;
  underwaterKickTempo: number;
  diveVelocity: number;
  diveDistance: number;
  
  // Granular metrics
  vel0to15m: number;
  vel15mToWall: number;
  firstLengthVel: number;
  breakoutDistance: number;
  breakoutTime: number;
  kicksCount: number;
}

export type CourseType = 'SCY' | 'SCM' | 'LCM';
export type StrokeType = 'Freestyle' | 'Backstroke' | 'Breaststroke' | 'Butterfly' | 'IM';

export interface RaceConfig {
  swimmerName: string;
  stroke: StrokeType;
  distance: number;
  course: CourseType;
  videoStartTime: number | null;
  videoEndTime: number | null;
  manualRaceTime: number | null;
  manualSplits: string;
  manualDiveVelocity?: number | null;
  manualBreakoutDistance?: number | null;
  manualKickCount?: number | null;
}
