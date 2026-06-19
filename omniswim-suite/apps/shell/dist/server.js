// server.ts
import express from "express";
import path4 from "path";
import fs3 from "fs";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { spawn, execSync } from "child_process";

// ../../packages/core/src/constants.ts
var CONVERSION_FACTORS = {
  "50 Freestyle": { men_lcm: 0.87, women_lcm: 0.881, both_scm: 0.906 },
  "100 Freestyle": { men_lcm: 0.873, women_lcm: 0.884, both_scm: 0.906 },
  "200 Freestyle": { men_lcm: 0.875, women_lcm: 0.884, both_scm: 0.906 },
  "400 Freestyle": { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  "500 Freestyle": { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  "800 Freestyle": { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  "1000 Freestyle": { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  "1500 Freestyle": { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  "1650 Freestyle": { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  "100 Backstroke": { men_lcm: 0.845, women_lcm: 0.863, both_scm: 0.906 },
  "200 Backstroke": { men_lcm: 0.859, women_lcm: 0.867, both_scm: 0.906 },
  "100 Breaststroke": { men_lcm: 0.866, women_lcm: 0.88, both_scm: 0.906 },
  "200 Breaststroke": { men_lcm: 0.868, women_lcm: 0.888, both_scm: 0.906 },
  "100 Butterfly": { men_lcm: 0.878, women_lcm: 0.887, both_scm: 0.906 },
  "200 Butterfly": { men_lcm: 0.876, women_lcm: 0.891, both_scm: 0.906 },
  "200 IM": { men_lcm: 0.867, women_lcm: 0.877, both_scm: 0.906 },
  "400 IM": { men_lcm: 0.875, women_lcm: 0.886, both_scm: 0.906 }
};
var SCORING_POINTS = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

// ../../packages/core/src/lib/scoringDefaults.ts
var TOP16 = [...SCORING_POINTS];
var NSISC_PRESET_SETTINGS = {
  scoringPoints: TOP16,
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 18,
  maxRelaysScoringPerTeam: 2,
  aFinalBracketSize: 8,
  scorerCapScope: "meet",
  diverScorerWeight: 1 / 3,
  relayEligibleFromScorerPool: false,
  scorerEligibilityMode: "roster",
  scorerAutoRules: {
    abFinalTiers: ["A", "B"],
    includeRelayLegsInFinals: true,
    distanceFinalRequired: true,
    distanceEventPattern: ["1000", "1650", "1500"]
  },
  diverEventPattern: ["DIVING", "DIVE"],
  maxIndividualEntriesPerSwimmer: 3,
  maxRelayEntriesPerSwimmer: 4
};

// ../../packages/core/src/lib/utils.ts
function convertTimeToSeconds(timeStr) {
  if (!timeStr || timeStr === "NT" || timeStr === "DQ") return Infinity;
  const parts = timeStr.split(":");
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(parts[0]);
}
function formatSecondsToTime(seconds) {
  if (seconds === Infinity) return "NT";
  if (seconds < 60) return seconds.toFixed(2);
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${secs.padStart(5, "0")}`;
}
function convertToSCY(timeStr, event, gender, type) {
  if (type === "SCY") return timeStr;
  const seconds = convertTimeToSeconds(timeStr);
  const baseEvent = event.replace(/\s*\(Relay split\)\s*$/i, "").trim();
  let factors = CONVERSION_FACTORS[baseEvent];
  if (!factors && baseEvent.startsWith("50 ")) {
    const hundredKey = baseEvent.replace(/^50\s+/, "100 ");
    factors = CONVERSION_FACTORS[hundredKey];
  }
  if (!factors) factors = CONVERSION_FACTORS["50 Freestyle"];
  let factor = 1;
  if (type === "LCM") {
    factor = gender === "Men" /* MEN */ ? factors.men_lcm : factors.women_lcm;
  } else if (type === "SCM") {
    factor = factors.both_scm;
  }
  return formatSecondsToTime(seconds * factor);
}

// ../../packages/core/src/lib/relaySplits.ts
function parseRelayDistanceYards(event) {
  const ev = event.toLowerCase();
  const fourX = ev.match(/4\s*[x×]\s*(\d+)/);
  if (fourX) return parseInt(fourX[1], 10) * 4;
  const m = ev.match(/\b(\d{3,4})\b/);
  if (m) return parseInt(m[1], 10);
  if (/\b200\b/.test(ev)) return 200;
  if (/\b400\b/.test(ev)) return 400;
  return 200;
}
function relayLegDistanceYards(relayDistanceYards) {
  return relayDistanceYards / 4;
}
function asOptionalString(v) {
  if (v == null || v === "") return void 0;
  return String(v);
}
function normalizeRelaySplitSegment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const o = raw;
  const segmentTime = asOptionalString(o.segmentTime ?? o.segment_time);
  if (!segmentTime) return null;
  const yards = typeof o.yards === "number" ? o.yards : 0;
  const cumulativeLeg = asOptionalString(o.cumulativeLeg ?? o.cumulative_leg);
  return { yards, segmentTime, cumulativeLeg };
}
function normalizeRelayLegSplitDetail(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const o = raw;
  const legIndexRaw = o.legIndex ?? o.leg_index;
  const legIndex = typeof legIndexRaw === "number" ? legIndexRaw : 0;
  const stroke = o.stroke || "free";
  const legDistanceRaw = o.legDistanceYards ?? o.leg_distance_yards;
  const legDistanceYards = typeof legDistanceRaw === "number" ? legDistanceRaw : relayLegDistanceYards(200);
  const segments = Array.isArray(o.segments) ? o.segments.map(normalizeRelaySplitSegment).filter((s) => s != null) : [];
  const legTotal = asOptionalString(o.legTotal ?? o.leg_total);
  return { legIndex, stroke, legDistanceYards, segments, legTotal };
}
function normalizeRelayTeamSplits(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const o = raw;
  const legTotalsRaw = o.legTotals ?? o.leg_totals;
  const legTotals = Array.isArray(legTotalsRaw) ? legTotalsRaw.map((t) => t == null || t === "" ? null : String(t)) : [];
  const teamTotal = asOptionalString(o.teamTotal ?? o.team_total) ?? "";
  const firstHalf = asOptionalString(o.firstHalf ?? o.first_half);
  const secondHalf = asOptionalString(o.second_half ?? o.secondHalf);
  return { legTotals, firstHalf, secondHalf, teamTotal };
}
function isPlausibleLegTotal(timeStr, legDistanceYards) {
  const sec = convertTimeToSeconds(timeStr);
  if (!Number.isFinite(sec) || sec <= 0) return false;
  const bounds = {
    50: [12, 50],
    100: [28, 95],
    200: [55, 155]
  };
  const [minS, maxS] = bounds[legDistanceYards] ?? [
    Math.max(8, legDistanceYards * 0.15),
    legDistanceYards * 0.85
  ];
  return sec >= minS && sec <= maxS;
}
function relayTeamClock(row) {
  return String(row.relayTeamTime ?? row.finalsTime ?? row.time ?? "").trim();
}
function pickPlausibleLegTime(candidate, legDistanceYards, teamClock) {
  if (!candidate || candidate === "NT" || candidate === teamClock) return void 0;
  return isPlausibleLegTotal(candidate, legDistanceYards) ? candidate : void 0;
}
function displayTimeForRelayLeg(row) {
  const detail = normalizeRelayLegSplitDetail(row.relayLegSplitDetail);
  const legDist = detail?.legDistanceYards ?? relayLegDistanceYards(parseRelayDistanceYards(row.event || ""));
  const teamClock = relayTeamClock(row);
  const legIdx = row.relayLegIndex ?? detail?.legIndex;
  const fromDetail = pickPlausibleLegTime(detail?.legTotal, legDist, teamClock);
  if (fromDetail) return fromDetail;
  const fromTop = pickPlausibleLegTime(row.relayLegSplit, legDist, teamClock);
  if (fromTop) return fromTop;
  const teamSplits = normalizeRelayTeamSplits(row.relayTeamSplits);
  if (teamSplits && legIdx != null && legIdx >= 0) {
    const fromSummary = pickPlausibleLegTime(teamSplits.legTotals[legIdx] ?? void 0, legDist, teamClock);
    if (fromSummary) return fromSummary;
  }
  if (detail?.segments?.length) {
    for (let i = detail.segments.length - 1; i >= 0; i--) {
      const seg = detail.segments[i];
      if (seg.yards >= legDist) {
        const cum = pickPlausibleLegTime(seg.cumulativeLeg, legDist, teamClock);
        if (cum) return cum;
        const fullSeg = pickPlausibleLegTime(seg.segmentTime, legDist, teamClock);
        if (fullSeg) return fullSeg;
      }
    }
    for (let i = detail.segments.length - 1; i >= 0; i--) {
      const segT = pickPlausibleLegTime(detail.segments[i].segmentTime, legDist, teamClock);
      if (segT) return segT;
    }
  }
  return "\u2014";
}
function normalizeSwimmerResultRelayFields(r) {
  const isRelay = Boolean(r.isRelay) || /\brelay\b/i.test(String(r.event || ""));
  if (!isRelay) return r;
  const detail = normalizeRelayLegSplitDetail(r.relayLegSplitDetail);
  const teamSplits = normalizeRelayTeamSplits(r.relayTeamSplits);
  const displaySplit = displayTimeForRelayLeg({
    ...r,
    isRelay: true,
    relayLegSplitDetail: detail,
    relayTeamSplits: teamSplits
  });
  let relayLegSplit = r.relayLegSplit;
  const teamClock = relayTeamClock(r);
  if (relayLegSplit === teamClock) relayLegSplit = void 0;
  if (displaySplit !== "\u2014" && displaySplit !== relayLegSplit) {
    relayLegSplit = displaySplit;
  }
  const normalizedDetail = detail && displaySplit !== "\u2014" ? { ...detail, legTotal: detail.legTotal ?? displaySplit } : detail;
  return {
    ...r,
    isRelay: true,
    relayLegSplitDetail: normalizedDetail,
    relayTeamSplits: teamSplits,
    relayLegSplit: relayLegSplit ?? (displaySplit !== "\u2014" ? displaySplit : r.relayLegSplit)
  };
}

// ../../packages/core/src/data/teamDivisions.ts
var TEAM_DIVISION_MAP = {
  "university of pittsburgh": "D1",
  "pitt": "D1",
  "university of louisville": "D1",
  "florida state university": "D1",
  "henderson state university": "D2",
  "ouachita baptist university": "D2",
  "delta state university": "D2",
  "oklahoma baptist university": "D2",
  "lindenwood university": "D2",
  "mckendree university": "D2",
  "drury university": "D2"
};
function normalizeTeamKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
function divisionForTeam(teamName, overrides) {
  const key = normalizeTeamKey(teamName);
  if (overrides?.[teamName]) return overrides[teamName];
  if (overrides?.[key]) return overrides[key];
  if (TEAM_DIVISION_MAP[key]) return TEAM_DIVISION_MAP[key];
  for (const [known, div] of Object.entries(TEAM_DIVISION_MAP)) {
    if (key.includes(known) || known.includes(key)) return div;
  }
  return "D1";
}

// ../../packages/core/src/cutlines.ts
var D1_CUTLINE_ROWS = [
  { "gender": "Men", "event": "50 Freestyle", "standard": "A", "time_25_26": "19.39", "proj_26_27": "19.35", "proj_27_28": "19.30", "proj_28_29": "19.26" },
  { "gender": "Men", "event": "50 Freestyle", "standard": "B", "time_25_26": "20.36", "proj_26_27": "20.31", "proj_27_28": "20.26", "proj_28_29": "20.21" },
  { "gender": "Men", "event": "100 Freestyle", "standard": "A", "time_25_26": "43.08", "proj_26_27": "43.06", "proj_27_28": "43.04", "proj_28_29": "43.02" },
  { "gender": "Men", "event": "100 Freestyle", "standard": "B", "time_25_26": "45.23", "proj_26_27": "45.20", "proj_27_28": "45.18", "proj_28_29": "45.15" },
  { "gender": "Men", "event": "200 Freestyle", "standard": "A", "time_25_26": "1:34.74", "proj_26_27": "1:34.38", "proj_27_28": "1:34.03", "proj_28_29": "1:33.67" },
  { "gender": "Men", "event": "200 Freestyle", "standard": "B", "time_25_26": "1:39.48", "proj_26_27": "1:39.11", "proj_27_28": "1:38.74", "proj_28_29": "1:38.37" },
  { "gender": "Men", "event": "500 Freestyle", "standard": "A", "time_25_26": "4:19.98", "proj_26_27": "4:19.09", "proj_27_28": "4:18.20", "proj_28_29": "4:17.31" },
  { "gender": "Men", "event": "500 Freestyle", "standard": "B", "time_25_26": "4:32.98", "proj_26_27": "4:32.05", "proj_27_28": "4:31.12", "proj_28_29": "4:30.19" },
  { "gender": "Men", "event": "1000 Freestyle", "standard": "A", "time_25_26": "8:58.94", "proj_26_27": "8:57.10", "proj_27_28": "8:55.25", "proj_28_29": "8:53.41" },
  { "gender": "Men", "event": "1000 Freestyle", "standard": "B", "time_25_26": "9:25.89", "proj_26_27": "9:23.95", "proj_27_28": "9:22.02", "proj_28_29": "9:20.08" },
  { "gender": "Men", "event": "1650 Freestyle", "standard": "A", "time_25_26": "15:11.41", "proj_26_27": "15:10.85", "proj_27_28": "15:10.29", "proj_28_29": "15:09.73" },
  { "gender": "Men", "event": "1650 Freestyle", "standard": "B", "time_25_26": "15:56.98", "proj_26_27": "15:56.40", "proj_27_28": "15:55.81", "proj_28_29": "15:55.23" },
  { "gender": "Men", "event": "100 Backstroke", "standard": "A", "time_25_26": "46.32", "proj_26_27": "46.24", "proj_27_28": "46.17", "proj_28_29": "46.09" },
  { "gender": "Men", "event": "100 Backstroke", "standard": "B", "time_25_26": "48.64", "proj_26_27": "48.56", "proj_27_28": "48.49", "proj_28_29": "48.41" },
  { "gender": "Men", "event": "200 Backstroke", "standard": "A", "time_25_26": "1:42.18", "proj_26_27": "1:41.88", "proj_27_28": "1:41.58", "proj_28_29": "1:41.28" },
  { "gender": "Men", "event": "200 Backstroke", "standard": "B", "time_25_26": "1:47.29", "proj_26_27": "1:46.97", "proj_27_28": "1:46.66", "proj_28_29": "1:46.34" },
  { "gender": "Men", "event": "100 Breaststroke", "standard": "A", "time_25_26": "52.60", "proj_26_27": "52.44", "proj_27_28": "52.29", "proj_28_29": "52.13" },
  { "gender": "Men", "event": "100 Breaststroke", "standard": "B", "time_25_26": "55.23", "proj_26_27": "55.06", "proj_27_28": "54.90", "proj_28_29": "54.73" },
  { "gender": "Men", "event": "200 Breaststroke", "standard": "A", "time_25_26": "1:55.12", "proj_26_27": "1:55.12", "proj_27_28": "1:55.12", "proj_28_29": "1:55.12" },
  { "gender": "Men", "event": "200 Breaststroke", "standard": "B", "time_25_26": "2:00.87", "proj_26_27": "2:00.87", "proj_27_28": "2:00.87", "proj_28_29": "2:00.87" },
  { "gender": "Men", "event": "100 Butterfly", "standard": "A", "time_25_26": "46.17", "proj_26_27": "46.03", "proj_27_28": "45.89", "proj_28_29": "45.75" },
  { "gender": "Men", "event": "100 Butterfly", "standard": "B", "time_25_26": "48.48", "proj_26_27": "48.33", "proj_27_28": "48.19", "proj_28_29": "48.04" },
  { "gender": "Men", "event": "200 Butterfly", "standard": "A", "time_25_26": "1:44.66", "proj_26_27": "1:44.66", "proj_27_28": "1:44.66", "proj_28_29": "1:44.66" },
  { "gender": "Men", "event": "200 Butterfly", "standard": "B", "time_25_26": "1:49.89", "proj_26_27": "1:49.89", "proj_27_28": "1:49.89", "proj_28_29": "1:49.89" },
  { "gender": "Men", "event": "200 Individual Medley", "standard": "A", "time_25_26": "1:44.60", "proj_26_27": "1:43.97", "proj_27_28": "1:43.34", "proj_28_29": "1:42.71" },
  { "gender": "Men", "event": "200 Individual Medley", "standard": "B", "time_25_26": "1:49.83", "proj_26_27": "1:49.17", "proj_27_28": "1:48.51", "proj_28_29": "1:47.85" },
  { "gender": "Men", "event": "400 Individual Medley", "standard": "A", "time_25_26": "3:46.91", "proj_26_27": "3:46.33", "proj_27_28": "3:45.75", "proj_28_29": "3:45.17" },
  { "gender": "Men", "event": "400 Individual Medley", "standard": "B", "time_25_26": "3:58.26", "proj_26_27": "3:57.65", "proj_27_28": "3:57.04", "proj_28_29": "3:56.43" },
  { "gender": "Men", "event": "200 Freestyle Relay", "standard": "B", "time_25_26": "1:19.88", "proj_26_27": "1:19.58", "proj_27_28": "1:19.27", "proj_28_29": "1:18.97" },
  { "gender": "Men", "event": "400 Freestyle Relay", "standard": "B", "time_25_26": "2:56.83", "proj_26_27": "2:56.01", "proj_27_28": "2:55.19", "proj_28_29": "2:54.37" },
  { "gender": "Men", "event": "800 Freestyle Relay", "standard": "B", "time_25_26": "6:33.68", "proj_26_27": "6:32.74", "proj_27_28": "6:31.80", "proj_28_29": "6:30.86" },
  { "gender": "Men", "event": "200 Medley Relay", "standard": "B", "time_25_26": "1:27.39", "proj_26_27": "1:27.09", "proj_27_28": "1:26.79", "proj_28_29": "1:26.49" },
  { "gender": "Men", "event": "400 Medley Relay", "standard": "B", "time_25_26": "3:12.57", "proj_26_27": "3:11.43", "proj_27_28": "3:10.28", "proj_28_29": "3:09.14" },
  { "gender": "Women", "event": "50 Freestyle", "standard": "A", "time_25_26": "22.50", "proj_26_27": "22.39", "proj_27_28": "22.28", "proj_28_29": "22.17" },
  { "gender": "Women", "event": "50 Freestyle", "standard": "B", "time_25_26": "23.62", "proj_26_27": "23.50", "proj_27_28": "23.38", "proj_28_29": "23.26" },
  { "gender": "Women", "event": "100 Freestyle", "standard": "A", "time_25_26": "49.47", "proj_26_27": "49.41", "proj_27_28": "49.36", "proj_28_29": "49.30" },
  { "gender": "Women", "event": "100 Freestyle", "standard": "B", "time_25_26": "51.94", "proj_26_27": "51.88", "proj_27_28": "51.82", "proj_28_29": "51.76" },
  { "gender": "Women", "event": "200 Freestyle", "standard": "A", "time_25_26": "1:47.32", "proj_26_27": "1:47.13", "proj_27_28": "1:46.94", "proj_28_29": "1:46.75" },
  { "gender": "Women", "event": "200 Freestyle", "standard": "B", "time_25_26": "1:52.69", "proj_26_27": "1:52.50", "proj_27_28": "1:52.30", "proj_28_29": "1:52.11" },
  { "gender": "Women", "event": "500 Freestyle", "standard": "A", "time_25_26": "4:49.42", "proj_26_27": "4:48.98", "proj_27_28": "4:48.54", "proj_28_29": "4:48.10" },
  { "gender": "Women", "event": "500 Freestyle", "standard": "B", "time_25_26": "5:03.89", "proj_26_27": "5:03.43", "proj_27_28": "5:02.96", "proj_28_29": "5:02.50" },
  { "gender": "Women", "event": "1000 Freestyle", "standard": "A", "time_25_26": "9:52.78", "proj_26_27": "9:51.78", "proj_27_28": "9:50.79", "proj_28_29": "9:49.79" },
  { "gender": "Women", "event": "1000 Freestyle", "standard": "B", "time_25_26": "10:22.42", "proj_26_27": "10:21.38", "proj_27_28": "10:20.33", "proj_28_29": "10:19.29" },
  { "gender": "Women", "event": "1650 Freestyle", "standard": "A", "time_25_26": "16:31.17", "proj_26_27": "16:31.17", "proj_27_28": "16:31.17", "proj_28_29": "16:31.17" },
  { "gender": "Women", "event": "1650 Freestyle", "standard": "B", "time_25_26": "17:20.73", "proj_26_27": "17:20.73", "proj_27_28": "17:20.73", "proj_28_29": "17:20.73" },
  { "gender": "Women", "event": "100 Backstroke", "standard": "A", "time_25_26": "53.49", "proj_26_27": "53.48", "proj_27_28": "53.47", "proj_28_29": "53.46" },
  { "gender": "Women", "event": "100 Backstroke", "standard": "B", "time_25_26": "56.16", "proj_26_27": "56.15", "proj_27_28": "56.14", "proj_28_29": "56.13" },
  { "gender": "Women", "event": "200 Backstroke", "standard": "A", "time_25_26": "1:57.00", "proj_26_27": "1:57.00", "proj_27_28": "1:57.00", "proj_28_29": "1:57.00" },
  { "gender": "Women", "event": "200 Backstroke", "standard": "B", "time_25_26": "2:02.85", "proj_26_27": "2:02.85", "proj_27_28": "2:02.85", "proj_28_29": "2:02.85" },
  { "gender": "Women", "event": "100 Breaststroke", "standard": "A", "time_25_26": "1:01.03", "proj_26_27": "1:01.03", "proj_27_28": "1:01.03", "proj_28_29": "1:01.03" },
  { "gender": "Women", "event": "100 Breaststroke", "standard": "B", "time_25_26": "1:04.08", "proj_26_27": "1:04.08", "proj_27_28": "1:04.08", "proj_28_29": "1:04.08" },
  { "gender": "Women", "event": "200 Breaststroke", "standard": "A", "time_25_26": "2:13.06", "proj_26_27": "2:13.06", "proj_27_28": "2:13.06", "proj_28_29": "2:13.06" },
  { "gender": "Women", "event": "200 Breaststroke", "standard": "B", "time_25_26": "2:19.71", "proj_26_27": "2:19.71", "proj_27_28": "2:19.71", "proj_28_29": "2:19.71" },
  { "gender": "Women", "event": "100 Butterfly", "standard": "A", "time_25_26": "53.37", "proj_26_27": "53.37", "proj_27_28": "53.37", "proj_28_29": "53.37" },
  { "gender": "Women", "event": "100 Butterfly", "standard": "B", "time_25_26": "56.04", "proj_26_27": "56.04", "proj_27_28": "56.04", "proj_28_29": "56.04" },
  { "gender": "Women", "event": "200 Butterfly", "standard": "A", "time_25_26": "1:58.97", "proj_26_27": "1:58.81", "proj_27_28": "1:58.64", "proj_28_29": "1:58.48" },
  { "gender": "Women", "event": "200 Butterfly", "standard": "B", "time_25_26": "2:04.92", "proj_26_27": "2:04.75", "proj_27_28": "2:04.58", "proj_28_29": "2:04.41" },
  { "gender": "Women", "event": "200 Individual Medley", "standard": "A", "time_25_26": "1:59.39", "proj_26_27": "1:59.39", "proj_27_28": "1:59.39", "proj_28_29": "1:59.39" },
  { "gender": "Women", "event": "200 Individual Medley", "standard": "B", "time_25_26": "2:05.36", "proj_26_27": "2:05.36", "proj_27_28": "2:05.36", "proj_28_29": "2:05.36" },
  { "gender": "Women", "event": "400 Individual Medley", "standard": "A", "time_25_26": "4:16.33", "proj_26_27": "4:15.65", "proj_27_28": "4:14.97", "proj_28_29": "4:14.29" },
  { "gender": "Women", "event": "400 Individual Medley", "standard": "B", "time_25_26": "4:29.14", "proj_26_27": "4:28.43", "proj_27_28": "4:27.71", "proj_28_29": "4:27.00" },
  { "gender": "Women", "event": "200 Freestyle Relay", "standard": "B", "time_25_26": "1:33.14", "proj_26_27": "1:32.79", "proj_27_28": "1:32.45", "proj_28_29": "1:32.10" },
  { "gender": "Women", "event": "400 Freestyle Relay", "standard": "B", "time_25_26": "3:24.60", "proj_26_27": "3:24.30", "proj_27_28": "3:24.01", "proj_28_29": "3:23.71" },
  { "gender": "Women", "event": "800 Freestyle Relay", "standard": "B", "time_25_26": "7:27.03", "proj_26_27": "7:25.62", "proj_27_28": "7:24.22", "proj_28_29": "7:22.81" },
  { "gender": "Women", "event": "200 Medley Relay", "standard": "B", "time_25_26": "1:42.20", "proj_26_27": "1:41.88", "proj_27_28": "1:41.56", "proj_28_29": "1:41.24" },
  { "gender": "Women", "event": "400 Medley Relay", "standard": "B", "time_25_26": "3:44.86", "proj_26_27": "3:44.54", "proj_27_28": "3:44.23", "proj_28_29": "3:43.91" }
];
var cutlines = D1_CUTLINE_ROWS.map((row) => ({
  ...row,
  division: "D1"
}));

// ../../packages/core/src/lib/cutlineUtils.ts
var SEASON_TIME_KEY = {
  "25_26": "time_25_26",
  "26_27": "proj_26_27",
  "27_28": "proj_27_28",
  "28_29": "proj_28_29"
};
function normalizeEventForCutline(event) {
  let e = event.replace(/\s+/g, " ").trim();
  e = e.replace(/\b(SCY|LCM|SCM)\b/gi, "").trim();
  if (/\bfly\b/i.test(e) && !/butterfly/i.test(e)) {
    e = e.replace(/\bfly\b/i, "Butterfly");
  }
  if (/\bback\b/i.test(e) && !/backstroke/i.test(e)) {
    e = e.replace(/\bback\b/i, "Backstroke");
  }
  if (/\bbreast\b/i.test(e) && !/breaststroke/i.test(e)) {
    e = e.replace(/\bbreast\b/i, "Breaststroke");
  }
  if (/\bfree\b/i.test(e) && !/freestyle/i.test(e)) {
    e = e.replace(/\bfree\b/i, "Freestyle");
  }
  if (/\bIM\b/.test(e) && !/individual medley/i.test(e)) {
    e = e.replace(/\bIM\b/, "Individual Medley");
  }
  return e.replace(/\s+/g, " ").trim();
}
function genderKey(gender) {
  return gender === "Women" /* WOMEN */ ? "Women" : "Men";
}
function getCutlinesForSwim(gender, event, division = "D1", season = "25_26") {
  const g = genderKey(gender);
  const cleanEvent = normalizeEventForCutline(event);
  const timeKey = SEASON_TIME_KEY[season];
  const rows = cutlines.filter(
    (c) => c.division === division && c.gender === g && c.event.toUpperCase() === cleanEvent.toUpperCase()
  );
  const aCut = rows.find((c) => c.standard === "A");
  const bCut = rows.find((c) => c.standard === "B");
  const aTime = aCut ? String(aCut[timeKey] ?? aCut.time_25_26 ?? "") : "";
  const bTime = bCut ? String(bCut[timeKey] ?? bCut.time_25_26 ?? "") : "";
  return {
    aCut,
    bCut,
    aCutSec: aTime ? convertTimeToSeconds(aTime) : 0,
    bCutSec: bTime ? convertTimeToSeconds(bTime) : 0
  };
}
function compareTimeToCutline(timeSec, gender, event, division = "D1", season = "25_26") {
  if (!timeSec || timeSec <= 0) {
    return { achieved: null, aCutSec: 0, bCutSec: 0 };
  }
  const { aCutSec, bCutSec } = getCutlinesForSwim(gender, event, division, season);
  if (aCutSec > 0 && timeSec <= aCutSec) {
    return { achieved: "A", aCutSec, bCutSec };
  }
  if (bCutSec > 0 && timeSec <= bCutSec) {
    return { achieved: "B", aCutSec, bCutSec };
  }
  return { achieved: null, aCutSec, bCutSec };
}

// ../../packages/core/src/lib/athleteHistory.ts
var TIME_RE = /^(\d{1,2}:)?\d{1,2}\.\d{2}$/;
var EVENT_COL_RE = /^\d+\s*(?:Yard\s*)?(?:Free|Fly|Back|Breast|IM|Individual Medley|Diving|Medley)/i;
var DATE_RE = /^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/;
var LOCATION_RE = /^.+,\s*[A-Z]{2}$/;
var SKIP_LINE_RE = /^(personal bests|event progression|course|season|sort by|stamp link|event|time|meet|date|name|swimmer)$/i;
var STAMP_BADGE_MAP = {
  x: "extracted",
  u: "user_input",
  b: "d1_b",
  "d1-b": "d1_b",
  a: "d1_a",
  "d1-a": "d1_a"
};
function splitRow(line) {
  if (line.includes("	")) {
    return line.split("	").map((c) => c.trim());
  }
  return line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
}
function isTimeToken(s) {
  return TIME_RE.test(s.trim());
}
function isEventToken(s) {
  return EVENT_COL_RE.test(s.trim());
}
function parseStampToken(raw) {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (STAMP_BADGE_MAP[key]) return STAMP_BADGE_MAP[key];
  if (/^d1-?[ab]$/i.test(raw)) return raw.toLowerCase().includes("a") ? "d1_a" : "d1_b";
  if (/^(r|rcon|pb)$/i.test(raw)) return "other";
  return null;
}
function parseCourseFromEvent(raw) {
  if (/\bLCM\b/i.test(raw)) return "LCM";
  if (/\bSCM\b/i.test(raw)) return "SCM";
  if (/\bSCY\b/i.test(raw)) return "SCY";
  return void 0;
}
function normalizeEventLabel(raw) {
  let e = raw.replace(/\s+/g, " ").trim();
  e = e.replace(/\b(SCY|LCM|SCM)\b/gi, "").trim();
  if (/\bfly\b/i.test(e) && !/butterfly/i.test(e)) {
    e = e.replace(/\bfly\b/i, "Butterfly");
  }
  if (/\bback\b/i.test(e) && !/backstroke/i.test(e)) {
    e = e.replace(/\bback\b/i, "Backstroke");
  }
  if (/\bbreast\b/i.test(e) && !/breaststroke/i.test(e)) {
    e = e.replace(/\bbreast\b/i, "Breaststroke");
  }
  if (/\bfree\b/i.test(e) && !/freestyle/i.test(e)) {
    e = e.replace(/\bfree\b/i, "Freestyle");
  }
  if (/\bIM\b/.test(e) && !/individual medley/i.test(e)) {
    e = e.replace(/\bIM\b/, "Individual Medley");
  }
  return e.replace(/\s+/g, " ").trim();
}
function looksLikePersonName(line) {
  const t = line.trim();
  if (!t || t.includes("	")) return false;
  if (SKIP_LINE_RE.test(t)) return false;
  if (LOCATION_RE.test(t)) return false;
  if (isEventToken(t) || isTimeToken(t)) return false;
  if (/university|college|school|swimming|team/i.test(t) && t.split(/\s+/).length > 2) return false;
  const parts = t.split(/\s+/);
  return parts.length >= 2 && parts.length <= 5 && /^[A-Za-z]/.test(parts[0]);
}
function extractSwimmerNameFromPaste(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (looksLikePersonName(t)) return t;
  }
  return void 0;
}
function isHeaderOrJunkLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (SKIP_LINE_RE.test(t)) return true;
  if (/^event\s+time/i.test(t)) return true;
  if (LOCATION_RE.test(t)) return true;
  if (/^(personal bests|event progression)$/i.test(t)) return true;
  return false;
}
function detectSwimCloudPasteFormat(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || isHeaderOrJunkLine(t)) continue;
    const cols = splitRow(t);
    if (cols.length < 2) continue;
    if (isEventToken(cols[0]) && isTimeToken(cols[1])) return "personal_bests";
    if (looksLikePersonName(cols[0])) return "roster";
    break;
  }
  return "unknown";
}
function enrichWithComputedCut(swims, team, division) {
  const div = division ?? divisionForTeam(team);
  return swims.map((s) => {
    if (s.timeType && s.timeType !== "SCY") {
      return { ...s, computedCut: s.computedCut ?? null };
    }
    const sec = convertTimeToSeconds(convertToSCY(s.time, s.event, s.gender, s.timeType ?? "SCY"));
    const { achieved } = compareTimeToCutline(sec, s.gender, s.event, div);
    return { ...s, computedCut: achieved };
  });
}
function parseSwimCloudPersonalBests(text, swimmerName, team, gender, division) {
  const out = [];
  const name = swimmerName.trim();
  if (!name) return out;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || isHeaderOrJunkLine(t)) continue;
    const cols = splitRow(t);
    if (cols.length < 2) continue;
    if (!isEventToken(cols[0]) || !isTimeToken(cols[1])) continue;
    const rawEvent = cols[0];
    const time = cols[1];
    const timeType = parseCourseFromEvent(rawEvent) ?? "SCY";
    let rest = cols.slice(2).filter((c) => c.length > 0);
    let swimcloudBadge = "none";
    if (rest.length > 0) {
      const stamp = parseStampToken(rest[0]);
      if (stamp) {
        swimcloudBadge = stamp;
        rest = rest.slice(1);
      }
    }
    let meetLabel = "";
    let date = "";
    for (const c of rest) {
      if (!date && DATE_RE.test(c)) {
        date = c;
      } else if (!meetLabel && c.length > 3 && !DATE_RE.test(c)) {
        meetLabel = c;
      }
    }
    out.push({
      name,
      team,
      gender,
      event: normalizeEventLabel(rawEvent),
      time,
      timeType,
      meetLabel: meetLabel || void 0,
      date: date || void 0,
      source: "paste",
      swimcloudBadge
    });
  }
  return enrichWithComputedCut(out, team, division);
}
function parseSwimCloudRosterPaste(text, team, gender, division) {
  const eventRe = /(\d+\s*(?:Yard\s*)?(?:Freestyle|Backstroke|Breaststroke|Butterfly|IM|Individual Medley|Diving)[^\t]*)/i;
  const timeRe = /(\d{1,2}:)?\d{1,2}\.\d{2}/;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const cols = line.split(/\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const swimmer = cols[0];
    if (!swimmer || /^(name|swimmer|event)/i.test(swimmer)) continue;
    let event = "";
    let time = "";
    for (const c of cols.slice(1)) {
      if (!event && eventRe.test(c)) event = c.replace(/\s+/g, " ").trim();
      else if (!time && timeRe.test(c)) time = c.match(timeRe)[0];
    }
    if (!event || !time) continue;
    out.push({
      name: swimmer,
      team,
      gender,
      event: normalizeEventLabel(event),
      time,
      source: "paste",
      swimcloudBadge: "none"
    });
  }
  return enrichWithComputedCut(out, team, division);
}
function parseSwimCloudPasteDetailed(text, opts) {
  const warnings = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return { swims: [], format: "unknown", warnings: ["Paste is empty"] };
  }
  const detectedName = extractSwimmerNameFromPaste(trimmed);
  let format = opts.format === "auto" || !opts.format ? detectSwimCloudPasteFormat(trimmed) : opts.format;
  if (format === "unknown") {
    warnings.push("Could not detect paste format; tried personal bests layout");
    format = "personal_bests";
  }
  let swims = [];
  if (format === "personal_bests") {
    const swimmerName = (opts.swimmerName ?? detectedName ?? "").trim();
    if (!swimmerName) {
      warnings.push("Swimmer name required for personal bests paste");
      return { swims: [], format, warnings, detectedName };
    }
    swims = parseSwimCloudPersonalBests(trimmed, swimmerName, opts.team, opts.gender, opts.division);
    if (swims.some((s) => s.timeType === "LCM" || s.timeType === "SCM")) {
      warnings.push("LCM/SCM times included \u2014 cut comparison uses SCY conversion where applicable");
    }
    if (swims.some((s) => s.swimcloudBadge === "user_input")) {
      warnings.push("Some rows are user-entered (U) \u2014 not from official meet files");
    }
  } else {
    swims = parseSwimCloudRosterPaste(trimmed, opts.team, opts.gender, opts.division);
  }
  if (swims.length === 0) {
    warnings.push("No swim rows parsed \u2014 check copy includes the Personal Bests table");
  }
  return { swims, format, warnings, detectedName };
}

// ../../packages/core/src/schemas/workspace.ts
import { z } from "zod";
var genderSchema = z.enum(["Men", "Women"]);
var swimmerResultSchema = z.object({
  id: z.string(),
  rank: z.number(),
  name: z.string(),
  classYear: z.string(),
  team: z.string(),
  time: z.string(),
  points: z.union([z.number(), z.string()]),
  event: z.string()
}).passthrough();
var recruitSchema = z.object({
  id: z.string(),
  name: z.string(),
  team: z.string(),
  event: z.string(),
  time: z.string(),
  gender: genderSchema,
  classYear: z.string(),
  timeType: z.enum(["SCY", "LCM", "SCM"])
}).passthrough();
var historicalSwimSchema = z.object({
  name: z.string(),
  team: z.string(),
  gender: genderSchema,
  event: z.string(),
  time: z.string(),
  source: z.enum(["pdf", "paste", "ocr", "csv", "manual"])
}).passthrough();
var workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  menResults: z.array(swimmerResultSchema).default([]),
  womenResults: z.array(swimmerResultSchema).default([]),
  recruits: z.array(recruitSchema).default([]),
  createdAt: z.number()
}).passthrough();
var createWorkspaceSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional()
}).passthrough();
var updateWorkspaceSchema = z.object({}).passthrough();
var parsePdfSchema = z.object({
  base64: z.string().min(1, "No base64 PDF data provided"),
  format: z.string().optional()
});
var parseAthleteHistorySchema = z.object({
  text: z.string().optional(),
  imageBase64: z.string().optional(),
  team: z.string().optional(),
  gender: z.union([genderSchema, z.string()]).optional(),
  swimmerName: z.string().optional(),
  division: z.string().optional()
}).passthrough();
var importCsvSchema = z.object({
  csv: z.string().min(1, "CSV content required"),
  team: z.string().optional(),
  gender: z.union([genderSchema, z.string()]).optional()
});

// lib/workspaceRepo.ts
import { promises as fsp2 } from "node:fs";
import path3 from "node:path";

// lib/jsonStore.ts
import { promises as fsp } from "fs";
import fs from "fs";
import path from "path";
var JsonStore = class {
  filePath;
  backupDir;
  fallback;
  queue = Promise.resolve();
  cache = null;
  constructor(filePath, fallback, backupDir) {
    this.filePath = filePath;
    this.fallback = fallback;
    this.backupDir = backupDir ?? path.join(path.dirname(filePath), "backups");
  }
  /** Ensure the file exists, seeding it with the fallback value if missing. */
  async init() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      const seed = this.fallback();
      await this.atomicWrite(seed);
      this.cache = seed;
    }
  }
  /** Read the current value (from disk; cache kept for fast subsequent reads). */
  async read() {
    try {
      const raw = await fsp.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      this.cache = parsed;
      return parsed;
    } catch (err) {
      if (this.cache != null) return this.cache;
      const seed = this.fallback();
      this.cache = seed;
      return seed;
    }
  }
  /**
   * Apply a mutation under the write lock. The mutator receives the freshest
   * on-disk value and returns the next value to persist. Returns the value
   * actually written so callers can respond with it.
   */
  async mutate(mutator) {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const next = await mutator(current);
      await this.atomicWrite(next);
      this.cache = next;
      return next;
    });
    this.queue = run.catch(() => void 0);
    return run;
  }
  /** Write a JSON snapshot to the backup directory (timestamped). */
  async backup(label = "manual") {
    const value = await this.read();
    await fsp.mkdir(this.backupDir, { recursive: true });
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const dest = path.join(this.backupDir, `${path.basename(this.filePath, ".json")}-${label}-${stamp}.json`);
    await fsp.writeFile(dest, JSON.stringify(value, null, 2), "utf-8");
    await this.pruneBackups(20);
    return dest;
  }
  async pruneBackups(keep) {
    try {
      const entries = (await fsp.readdir(this.backupDir)).filter((f) => f.endsWith(".json")).sort();
      if (entries.length <= keep) return;
      const stale = entries.slice(0, entries.length - keep);
      await Promise.all(stale.map((f) => fsp.unlink(path.join(this.backupDir, f)).catch(() => void 0)));
    } catch {
    }
  }
  async atomicWrite(value) {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    await fsp.rename(tmp, this.filePath);
  }
};

// ../../packages/db/src/WorkspaceService.ts
import { DatabaseSync } from "node:sqlite";
import fs2 from "node:fs";
import path2 from "node:path";

// ../../packages/db/src/schema.ts
var SCHEMA_VERSION = 1;
var CREATE_TABLES_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  conference           TEXT,
  entry_plan_mode      TEXT,
  scoring_settings     TEXT,
  loaded_meet          TEXT,
  official_team_scores TEXT,
  active_entry_ids     TEXT,
  history_sources      TEXT,
  sort_index           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meet_results (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  gender       TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_results_ws ON meet_results(workspace_id);

CREATE TABLE IF NOT EXISTS recruits (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruits_ws ON recruits(workspace_id);

CREATE TABLE IF NOT EXISTS roster_overrides (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roster_overrides_ws ON roster_overrides(workspace_id);

CREATE TABLE IF NOT EXISTS meet_entry_plans (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_entry_plans_ws ON meet_entry_plans(workspace_id);

CREATE TABLE IF NOT EXISTS relay_leg_overrides (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_leg_overrides_ws ON relay_leg_overrides(workspace_id);

CREATE TABLE IF NOT EXISTS deleted_swimmers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleted_swimmers_ws ON deleted_swimmers(workspace_id);

CREATE TABLE IF NOT EXISTS athlete_history (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_athlete_history_ws ON athlete_history(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  label        TEXT,
  blob         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_ws ON workspace_snapshots(workspace_id);
`;

// ../../packages/db/src/WorkspaceService.ts
function parseJson(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
var WorkspaceService = class {
  db;
  constructor(dbPath) {
    fs2.mkdirSync(path2.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(CREATE_TABLES_SQL);
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run("schema_version", String(SCHEMA_VERSION));
  }
  close() {
    this.db.close();
  }
  /** Number of workspaces currently stored (used to detect an empty DB). */
  count() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM workspaces").get();
    return row?.n ?? 0;
  }
  listWorkspaces() {
    const rows = this.db.prepare("SELECT id FROM workspaces ORDER BY sort_index ASC, created_at ASC").all();
    return rows.map((r) => this.getWorkspace(r.id)).filter((w) => w != null);
  }
  getWorkspace(id) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    if (!row) return void 0;
    const childData = (table) => {
      const rows = this.db.prepare(`SELECT data FROM ${table} WHERE workspace_id = ? ORDER BY position ASC`).all(id);
      return rows.map((r) => parseJson(r.data, null)).filter((d) => d != null);
    };
    const allResults = childData("meet_results");
    const menResults = allResults.filter((r) => r.gender !== "Women");
    const womenResults = allResults.filter((r) => r.gender === "Women");
    const workspace = {
      id: String(row.id),
      name: String(row.name ?? ""),
      createdAt: Number(row.created_at ?? Date.now()),
      menResults,
      womenResults,
      recruits: childData("recruits"),
      deletedSwimmers: childData("deleted_swimmers"),
      scorerRosterOverrides: childData("roster_overrides"),
      meetEntryPlans: childData("meet_entry_plans"),
      relayLegOverrides: childData("relay_leg_overrides"),
      athleteHistory: childData("athlete_history"),
      conference: row.conference != null ? String(row.conference) : void 0,
      entryPlanMode: row.entry_plan_mode ?? void 0,
      scoringSettings: parseJson(row.scoring_settings, void 0),
      loadedMeet: parseJson(row.loaded_meet, void 0),
      officialTeamScores: parseJson(
        row.official_team_scores,
        void 0
      ),
      activeEntryIds: parseJson(row.active_entry_ids, void 0),
      historySources: parseJson(row.history_sources, void 0)
    };
    return workspace;
  }
  createWorkspace(ws, sortIndex) {
    this.writeWorkspace(ws, sortIndex ?? this.count());
    return this.getWorkspace(ws.id);
  }
  updateWorkspace(id, patch) {
    const existing = this.getWorkspace(id);
    if (!existing) return void 0;
    const merged = { ...existing, ...patch, id };
    const sortRow = this.db.prepare("SELECT sort_index FROM workspaces WHERE id = ?").get(id);
    this.writeWorkspace(merged, sortRow?.sort_index ?? this.count());
    return this.getWorkspace(id);
  }
  deleteWorkspace(id) {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }
  /** Replace the entire dataset (used by the JSON → SQLite migration). */
  replaceAll(workspaces) {
    this.tx(() => {
      this.db.exec("DELETE FROM workspaces");
      workspaces.forEach((ws, i) => this.writeWorkspaceUnsafe(ws, i));
    });
  }
  /** Full export for JSON backup / portability. */
  exportAll() {
    return this.listWorkspaces();
  }
  createSnapshot(workspaceId, label) {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return void 0;
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(
      "INSERT INTO workspace_snapshots(id, workspace_id, created_at, label, blob) VALUES(?, ?, ?, ?, ?)"
    ).run(id, workspaceId, Date.now(), label, JSON.stringify(ws));
    return { id };
  }
  listSnapshots(workspaceId) {
    const rows = this.db.prepare(
      "SELECT id, created_at, label FROM workspace_snapshots WHERE workspace_id = ? ORDER BY created_at DESC"
    ).all(workspaceId);
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, label: r.label }));
  }
  restoreSnapshot(snapshotId) {
    const row = this.db.prepare("SELECT workspace_id, blob FROM workspace_snapshots WHERE id = ?").get(snapshotId);
    if (!row) return void 0;
    const ws = parseJson(row.blob, null);
    if (!ws) return void 0;
    return this.updateWorkspace(row.workspace_id, ws);
  }
  tx(fn) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  writeWorkspace(ws, sortIndex) {
    this.tx(() => this.writeWorkspaceUnsafe(ws, sortIndex));
  }
  /** Write without its own transaction (caller must provide one). */
  writeWorkspaceUnsafe(ws, sortIndex) {
    {
      this.db.prepare(
        `INSERT INTO workspaces
            (id, name, created_at, conference, entry_plan_mode, scoring_settings,
             loaded_meet, official_team_scores, active_entry_ids, history_sources, sort_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             created_at = excluded.created_at,
             conference = excluded.conference,
             entry_plan_mode = excluded.entry_plan_mode,
             scoring_settings = excluded.scoring_settings,
             loaded_meet = excluded.loaded_meet,
             official_team_scores = excluded.official_team_scores,
             active_entry_ids = excluded.active_entry_ids,
             history_sources = excluded.history_sources,
             sort_index = excluded.sort_index`
      ).run(
        ws.id,
        ws.name,
        ws.createdAt ?? Date.now(),
        ws.conference ?? null,
        ws.entryPlanMode ?? null,
        ws.scoringSettings ? JSON.stringify(ws.scoringSettings) : null,
        ws.loadedMeet ? JSON.stringify(ws.loadedMeet) : null,
        ws.officialTeamScores ? JSON.stringify(ws.officialTeamScores) : null,
        ws.activeEntryIds ? JSON.stringify(ws.activeEntryIds) : null,
        ws.historySources ? JSON.stringify(ws.historySources) : null,
        sortIndex
      );
      for (const table of [
        "meet_results",
        "recruits",
        "roster_overrides",
        "meet_entry_plans",
        "relay_leg_overrides",
        "deleted_swimmers",
        "athlete_history"
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(ws.id);
      }
      this.insertResults(ws.id, ws.menResults ?? [], "Men");
      this.insertResults(ws.id, ws.womenResults ?? [], "Women");
      this.insertWithId("recruits", ws.id, ws.recruits ?? []);
      this.insertWithId("meet_entry_plans", ws.id, ws.meetEntryPlans ?? []);
      this.insertPositional("roster_overrides", ws.id, ws.scorerRosterOverrides ?? []);
      this.insertPositional("relay_leg_overrides", ws.id, ws.relayLegOverrides ?? []);
      this.insertPositional("deleted_swimmers", ws.id, ws.deletedSwimmers ?? []);
      this.insertPositional("athlete_history", ws.id, ws.athleteHistory ?? []);
    }
  }
  insertResults(workspaceId, results, gender) {
    const stmt = this.db.prepare(
      "INSERT INTO meet_results(id, workspace_id, gender, position, data) VALUES(?, ?, ?, ?, ?)"
    );
    results.forEach((r, i) => {
      const rid = r.id || `${workspaceId}_${gender}_${i}`;
      stmt.run(rid, workspaceId, gender, i, JSON.stringify(r));
    });
  }
  insertWithId(table, workspaceId, rows) {
    const stmt = this.db.prepare(
      `INSERT INTO ${table}(id, workspace_id, position, data) VALUES(?, ?, ?, ?)`
    );
    rows.forEach((row, i) => {
      const rid = row.id || `${workspaceId}_${table}_${i}`;
      stmt.run(rid, workspaceId, i, JSON.stringify(row));
    });
  }
  insertPositional(table, workspaceId, rows) {
    const stmt = this.db.prepare(
      `INSERT INTO ${table}(workspace_id, position, data) VALUES(?, ?, ?)`
    );
    rows.forEach((row, i) => stmt.run(workspaceId, i, JSON.stringify(row)));
  }
};

// lib/workspaceRepo.ts
async function writeJsonBackup(backupDir, workspaces, label) {
  await fsp2.mkdir(backupDir, { recursive: true });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const dest = path3.join(backupDir, `meets-${label}-${stamp}.json`);
  await fsp2.writeFile(dest, JSON.stringify(workspaces, null, 2), "utf-8");
  return dest;
}
var JsonRepo = class {
  kind = "json";
  store;
  constructor(filePath, backupDir, seed) {
    this.store = new JsonStore(filePath, seed, backupDir);
  }
  init() {
    return this.store.init();
  }
  list() {
    return this.store.read();
  }
  async create(ws) {
    await this.store.mutate((list) => [...list, ws]);
    return ws;
  }
  async update(id, patch) {
    let updated;
    await this.store.mutate(
      (list) => list.map((w) => {
        if (w.id !== id) return w;
        updated = { ...w, ...patch };
        return updated;
      })
    );
    return updated;
  }
  async remove(id) {
    await this.store.mutate((list) => list.filter((w) => w.id !== id));
  }
  backup(label = "manual") {
    return this.store.backup(label);
  }
  // Snapshots are SQLite-only; JSON repo returns no-ops.
  async snapshot() {
    return void 0;
  }
  async listSnapshots() {
    return [];
  }
  async restoreSnapshot() {
    return void 0;
  }
};
var SqliteRepo = class {
  kind = "sqlite";
  service;
  backupDir;
  seed;
  constructor(dbPath, backupDir, seed) {
    this.service = new WorkspaceService(dbPath);
    this.backupDir = backupDir;
    this.seed = seed;
  }
  async init() {
    if (this.service.count() === 0) {
      for (const ws of this.seed()) this.service.createWorkspace(ws);
    }
  }
  async list() {
    return this.service.listWorkspaces();
  }
  async create(ws) {
    return this.service.createWorkspace(ws);
  }
  async update(id, patch) {
    return this.service.updateWorkspace(id, patch);
  }
  async remove(id) {
    this.service.deleteWorkspace(id);
  }
  async backup(label = "manual") {
    return writeJsonBackup(this.backupDir, this.service.exportAll(), label);
  }
  async snapshot(id, label) {
    const res = this.service.createSnapshot(id, label);
    if (!res) return void 0;
    return { id: res.id, createdAt: Date.now(), label };
  }
  async listSnapshots(id) {
    return this.service.listSnapshots(id);
  }
  async restoreSnapshot(snapshotId) {
    return this.service.restoreSnapshot(snapshotId);
  }
};

// server.ts
var PORT = 3e3;
var __filename = fileURLToPath(import.meta.url);
var SHELL_ROOT = path4.dirname(__filename);
var PROJECT_ROOT = path4.join(SHELL_ROOT, "../..");
var DATA_DIR = path4.join(PROJECT_ROOT, "data");
var MEETS_FILE = path4.join(DATA_DIR, "meets.json");
var DB_FILE = path4.join(DATA_DIR, "omniswim.db");
var BACKUP_DIR = path4.join(DATA_DIR, "backups");
var STORAGE_BACKEND = (process.env.OMNI_DB ?? "json").toLowerCase();
var SCORING_PRESETS_DIR = path4.join(DATA_DIR, "scoring_presets");
var CUTLINES_DIR = path4.join(DATA_DIR, "cutlines");
var BUILTIN_CUTLINE_VERSION = "2025-2026";
var SCORING_SETTINGS_FILE = path4.join(DATA_DIR, "scoring_settings.json");
var AI_ENABLED = process.env.OMNI_AI_ENABLED === "true";
var PARSE_MEET_SCRIPT = path4.join(PROJECT_ROOT, "backend", "parse_meet.py");
var PDF_PARSER_SCRIPT = path4.join(PROJECT_ROOT, "backend", "pdf_parser.py");
var POINT_CALCULATOR_SCRIPT = path4.join(PROJECT_ROOT, "backend", "point_calculator.py");
var TEAM_RANKINGS_SCRIPT = path4.join(PROJECT_ROOT, "backend", "team_rankings_parser.py");
var PRESET_META_KEYS = /* @__PURE__ */ new Set(["id", "label", "description"]);
function loadScoringPresetFile(presetId) {
  const safeId = presetId.replace(/[^a-zA-Z0-9_-]/g, "");
  const filePath = path4.join(SCORING_PRESETS_DIR, `${safeId}.json`);
  if (!fs3.existsSync(filePath)) return null;
  return JSON.parse(fs3.readFileSync(filePath, "utf-8"));
}
function stripPresetMeta(raw) {
  const settings = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PRESET_META_KEYS.has(k)) settings[k] = v;
  }
  return settings;
}
function loadDefaultScoringSettings() {
  const generic = loadScoringPresetFile("generic-top16");
  if (generic) return stripPresetMeta(generic);
  if (fs3.existsSync(SCORING_SETTINGS_FILE)) {
    return JSON.parse(fs3.readFileSync(SCORING_SETTINGS_FILE, "utf-8"));
  }
  return {
    scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    aFinalBracketSize: 8,
    scorerCapScope: "event",
    diverScorerWeight: 1,
    relayEligibleFromScorerPool: false,
    maxIndividualEntriesPerSwimmer: 999,
    maxRelayEntriesPerSwimmer: 999
  };
}
var defaultScoringSettings = loadDefaultScoringSettings();
async function runPythonScript(scriptPath, args, stdin) {
  return new Promise((resolve, reject) => {
    const venvPython = process.platform === "win32" ? path4.join(PROJECT_ROOT, "venv", "Scripts", "python.exe") : path4.join(PROJECT_ROOT, "venv", "bin", "python");
    const pythonCmd = fs3.existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3";
    const proc = spawn(pythonCmd, [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, OMNI_PROJECT_ROOT: PROJECT_ROOT, OMNI_DATA_DIR: DATA_DIR }
    });
    let output = "";
    let errorOutput = "";
    let resolved = false;
    proc.stdout.on("data", (d) => {
      output += d.toString();
    });
    proc.stderr.on("data", (d) => {
      errorOutput += d.toString();
    });
    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    proc.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) reject(new Error(`Python exit ${code}: ${errorOutput || output.slice(0, 500)}`));
      else resolve(output);
    });
    if (stdin) {
      proc.stdin.write(stdin, "utf-8", () => proc.stdin.end());
    }
  });
}
async function startServer() {
  try {
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const venvPath = path4.join(PROJECT_ROOT, "venv");
    if (!fs3.existsSync(venvPath)) {
      execSync(`${pythonCmd} -m venv venv`, { stdio: "ignore", cwd: PROJECT_ROOT });
    }
    const venvPython = process.platform === "win32" ? path4.join(venvPath, "Scripts", "python.exe") : path4.join(venvPath, "bin", "python");
    try {
      execSync(`"${venvPython}" -c "import pdfplumber"`, { stdio: "ignore", cwd: PROJECT_ROOT });
    } catch {
      const pip = process.platform === "win32" ? path4.join(venvPath, "Scripts", "pip.exe") : path4.join(venvPath, "bin", "pip");
      execSync(`"${pip}" install pdfplumber`, { stdio: "inherit", cwd: PROJECT_ROOT });
    }
  } catch (err) {
    console.warn("Python venv setup warning:", err);
  }
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  const seedWorkspaces = () => [
    {
      id: uuidv4(),
      name: "Blank Workspace 1",
      menResults: [],
      womenResults: [],
      recruits: [],
      deletedSwimmers: [],
      createdAt: Date.now(),
      scoringSettings: defaultScoringSettings
    }
  ];
  let repo;
  if (STORAGE_BACKEND === "sqlite") {
    try {
      repo = new SqliteRepo(DB_FILE, BACKUP_DIR, seedWorkspaces);
      await repo.init();
      console.log("Storage backend: SQLite (data/omniswim.db)");
    } catch (err) {
      console.warn("SQLite backend failed to initialize, falling back to JSON:", err);
      repo = new JsonRepo(MEETS_FILE, BACKUP_DIR, seedWorkspaces);
      await repo.init();
    }
  } else {
    repo = new JsonRepo(MEETS_FILE, BACKUP_DIR, seedWorkspaces);
    await repo.init();
    console.log("Storage backend: JSON (data/meets.json)");
  }
  function normalizeWorkspaceResults(ws) {
    return {
      ...ws,
      menResults: (ws.menResults || []).map(normalizeSwimmerResultRelayFields),
      womenResults: (ws.womenResults || []).map(normalizeSwimmerResultRelayFields)
    };
  }
  app.get("/api/workspaces", async (_req, res) => {
    try {
      const data = await repo.list();
      res.json(data.map(normalizeWorkspaceResults));
    } catch (err) {
      res.status(500).json({ error: "Failed to read workspaces", details: String(err) });
    }
  });
  app.post("/api/workspaces", async (req, res) => {
    const parsed = createWorkspaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid workspace payload", details: parsed.error.issues });
    }
    const body = parsed.data;
    const newWorkspace = {
      id: typeof body.id === "string" ? body.id : uuidv4(),
      name: body.name || "New Workspace",
      menResults: body.menResults ?? [],
      womenResults: body.womenResults ?? [],
      recruits: body.recruits ?? [],
      deletedSwimmers: body.deletedSwimmers ?? [],
      createdAt: body.createdAt ?? Date.now(),
      scoringSettings: body.scoringSettings ?? defaultScoringSettings,
      ...body
    };
    try {
      const created = await repo.create(newWorkspace);
      res.json(created);
    } catch (err) {
      res.status(500).json({ error: "Failed to create workspace", details: String(err) });
    }
  });
  app.put("/api/workspaces/:id", async (req, res) => {
    const parsed = updateWorkspaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid workspace patch", details: parsed.error.issues });
    }
    try {
      const updated = await repo.update(req.params.id, parsed.data);
      if (!updated) return res.status(404).json({ error: "Workspace not found" });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: "Failed to update workspace", details: String(err) });
    }
  });
  app.delete("/api/workspaces/:id", async (req, res) => {
    try {
      await repo.remove(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete workspace", details: String(err) });
    }
  });
  app.post("/api/workspaces/backup", async (_req, res) => {
    try {
      const file = await repo.backup("manual");
      res.json({ success: true, file: path4.basename(file) });
    } catch (err) {
      res.status(500).json({ error: "Backup failed", details: String(err) });
    }
  });
  app.post("/api/workspaces/:id/snapshots", async (req, res) => {
    try {
      const label = typeof req.body?.label === "string" ? req.body.label : "snapshot";
      const snap = await repo.snapshot(req.params.id, label);
      if (!snap) return res.status(400).json({ error: "Snapshots require the SQLite backend" });
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: "Snapshot failed", details: String(err) });
    }
  });
  app.get("/api/workspaces/:id/snapshots", async (req, res) => {
    try {
      res.json(await repo.listSnapshots(req.params.id));
    } catch (err) {
      res.status(500).json({ error: "Failed to list snapshots", details: String(err) });
    }
  });
  app.post("/api/snapshots/:snapshotId/restore", async (req, res) => {
    try {
      const restored = await repo.restoreSnapshot(req.params.snapshotId);
      if (!restored) return res.status(404).json({ error: "Snapshot not found" });
      res.json(restored);
    } catch (err) {
      res.status(500).json({ error: "Restore failed", details: String(err) });
    }
  });
  app.get("/api/scoring-presets", (_req, res) => {
    if (!fs3.existsSync(SCORING_PRESETS_DIR)) return res.json([]);
    const files = fs3.readdirSync(SCORING_PRESETS_DIR).filter((f) => f.endsWith(".json"));
    res.json(
      files.map((f) => {
        const raw = JSON.parse(fs3.readFileSync(path4.join(SCORING_PRESETS_DIR, f), "utf-8"));
        const id = raw.id || f.replace(/\.json$/, "");
        return { id, label: raw.label || id, description: raw.description };
      })
    );
  });
  app.get("/api/scoring-presets/:id", (req, res) => {
    const raw = loadScoringPresetFile(req.params.id);
    if (!raw) return res.status(404).json({ error: "Preset not found" });
    res.json(stripPresetMeta(raw));
  });
  function listCutlineVersions() {
    const versions = /* @__PURE__ */ new Set([BUILTIN_CUTLINE_VERSION]);
    if (fs3.existsSync(CUTLINES_DIR)) {
      for (const f of fs3.readdirSync(CUTLINES_DIR)) {
        if (f.endsWith(".json") && f !== "index.json") versions.add(f.replace(/\.json$/, ""));
      }
    }
    return [...versions].sort().reverse();
  }
  app.get("/api/cutlines/versions", (_req, res) => {
    res.json({ versions: listCutlineVersions(), default: BUILTIN_CUTLINE_VERSION });
  });
  app.get("/api/cutlines/:version?", (req, res) => {
    const version = req.params.version || BUILTIN_CUTLINE_VERSION;
    const safe = version.replace(/[^0-9a-zA-Z._-]/g, "");
    const filePath = path4.join(CUTLINES_DIR, `${safe}.json`);
    if (fs3.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs3.readFileSync(filePath, "utf-8"));
        return res.json({ version: safe, cutlines: Array.isArray(data) ? data : data.cutlines ?? [] });
      } catch (err) {
        return res.status(500).json({ error: "Failed to read cutlines version", details: String(err) });
      }
    }
    if (safe === BUILTIN_CUTLINE_VERSION) {
      return res.json({ version: BUILTIN_CUTLINE_VERSION, cutlines });
    }
    return res.status(404).json({ error: `Cutline version not found: ${safe}` });
  });
  function mapAthleteRows(athletes) {
    return athletes.map((a) => {
      const rankMatch = a.rank != null ? String(a.rank).match(/(\d+)/) : null;
      const parsedRank = rankMatch ? parseInt(rankMatch[1], 10) : 0;
      const teamClock = a.relay_team_time || a.finals_time || a.prelims_time;
      const isRelay = Boolean(a.is_relay) || /\brelay\b/i.test(String(a.event || ""));
      return normalizeSwimmerResultRelayFields({
        id: uuidv4(),
        rank: parsedRank > 0 ? parsedRank : 0,
        name: String(a.name),
        classYear: a.year || "UNKNOWN",
        team: String(a.team),
        time: teamClock || "NT",
        prelimsTime: a.prelims_time,
        finalsTime: a.finals_time,
        roundSwam: a.round_swam,
        points: a.calculated_points === "N/A" ? "N/A" : Number(a.calculated_points) || 0,
        event: String(a.event),
        gender: a.gender === "Women" ? "Women" /* WOMEN */ : "Men" /* MEN */,
        isRelay,
        isExhibition: a.is_exhibition,
        isTimeTrial: a.is_time_trial,
        relayNames: a.relay_names || [],
        relayLegIndex: a.relay_leg_index,
        relayLegStroke: a.relay_leg_stroke,
        relayLegSplit: a.relay_leg_split,
        relayLegSplitDetail: a.relay_leg_split_detail,
        relayTeamSplits: a.relay_team_splits,
        relayTeamTime: isRelay ? teamClock : a.relay_team_time,
        pdfPoints: a.pdf_points != null ? Number(a.pdf_points) : void 0
      });
    });
  }
  async function parseMeetUnified(tempFile, format) {
    const output = await runPythonScript(PARSE_MEET_SCRIPT, [tempFile, format]);
    const parsed = JSON.parse(output.trim());
    if (parsed.error) throw new Error(parsed.error);
    const athletes = Array.isArray(parsed.athletes) ? parsed.athletes : [];
    return {
      results: mapAthleteRows(athletes),
      conference: typeof parsed.conference === "string" ? parsed.conference : void 0,
      officialTeamScores: parsed.officialTeamScores ?? void 0
    };
  }
  async function parseMeetLegacy(tempFile, format) {
    const parserOutput = await runPythonScript(PDF_PARSER_SCRIPT, [tempFile, format]);
    try {
      const parsedJson = JSON.parse(parserOutput.trim());
      if (!Array.isArray(parsedJson) && parsedJson.error) {
        throw new Error(parsedJson.error);
      }
    } catch (err) {
      if (err instanceof Error && err.message && !err.message.startsWith("Unexpected")) throw err;
    }
    const calcOutput = await runPythonScript(POINT_CALCULATOR_SCRIPT, [], parserOutput);
    const athletes = JSON.parse(calcOutput);
    if (!Array.isArray(athletes)) throw new Error("Points calculation failed");
    const conference = athletes.length > 0 && typeof athletes[0].conference === "string" ? athletes[0].conference : void 0;
    let officialTeamScores;
    try {
      const rankingsOutput = await runPythonScript(TEAM_RANKINGS_SCRIPT, [tempFile]);
      const rankingsJson = JSON.parse(rankingsOutput.trim());
      if (!rankingsJson.error) {
        officialTeamScores = {
          eventThrough: rankingsJson.eventThrough,
          men: rankingsJson.men ?? {},
          women: rankingsJson.women ?? {}
        };
      }
    } catch {
    }
    return { results: mapAthleteRows(athletes), conference, officialTeamScores };
  }
  app.post("/api/parse-pdf", async (req, res) => {
    const parsed = parsePdfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid PDF payload", details: parsed.error.issues });
    }
    const { base64, format } = parsed.data;
    const tempFile = path4.join(PROJECT_ROOT, `temp_${Date.now()}.pdf`);
    try {
      fs3.writeFileSync(tempFile, Buffer.from(base64, "base64"));
      const fmt = format || "auto";
      let payload;
      try {
        payload = await parseMeetUnified(tempFile, fmt);
      } catch (unifiedErr) {
        console.warn("Unified parse_meet failed, falling back to legacy pipeline:", unifiedErr);
        payload = await parseMeetLegacy(tempFile, fmt);
      }
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: "Failed to parse PDF", details: String(error) });
    } finally {
      if (fs3.existsSync(tempFile)) fs3.unlinkSync(tempFile);
    }
  });
  app.post("/api/parse-athlete-history", async (req, res) => {
    const validated = parseAthleteHistorySchema.safeParse(req.body ?? {});
    if (!validated.success) {
      return res.status(400).json({ error: "Invalid request", details: validated.error.issues });
    }
    try {
      const { text, imageBase64, team, gender, swimmerName, division } = validated.data;
      const g = gender === "Women" /* WOMEN */ || gender === "Women" ? "Women" /* WOMEN */ : "Men" /* MEN */;
      const teamName = typeof team === "string" && team.trim() ? team.trim() : "Unknown";
      const div = division === "D2" || division === "D3" || division === "NAIA" ? division : "D1";
      if (typeof text === "string" && text.trim()) {
        const result = parseSwimCloudPasteDetailed(text, {
          team: teamName,
          gender: g,
          swimmerName: typeof swimmerName === "string" ? swimmerName : void 0,
          division: div
        });
        return res.json(result);
      }
      if (typeof imageBase64 === "string" && imageBase64.trim() && AI_ENABLED && process.env.GEMINI_API_KEY) {
        let GoogleGenAI;
        try {
          ({ GoogleGenAI } = await import("@google/genai"));
        } catch {
          return res.status(501).json({ error: "AI image parsing is not installed in this build" });
        }
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: [
            {
              role: "user",
              parts: [
                { text: "Extract swimmer rows as JSON array: [{name, event, time}]. No markdown." },
                { inlineData: { mimeType: "image/png", data: imageBase64 } }
              ]
            }
          ]
        });
        const raw = response.text ?? "[]";
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : "[]");
        const swims = (Array.isArray(parsed) ? parsed : []).map((row) => ({
          name: String(row.name ?? ""),
          team: teamName,
          gender: g,
          event: String(row.event ?? ""),
          time: String(row.time ?? ""),
          source: "ocr"
        }));
        return res.json({ swims: swims.filter((s) => s.name && s.event) });
      }
      return res.status(400).json({
        error: AI_ENABLED ? "Provide pasted text, or imageBase64 with GEMINI_API_KEY" : "Image parsing is disabled. Provide pasted text or set OMNI_AI_ENABLED=true with GEMINI_API_KEY."
      });
    } catch (err) {
      return res.status(500).json({ error: "Parse failed", details: String(err) });
    }
  });
  const uploadDir = path4.join(PROJECT_ROOT, "uploads");
  fs3.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
    })
  });
  app.post("/api/analyze-video", upload.single("video"), async (_req, res) => {
    res.status(501).json({
      error: "Gemini video analysis reserved for a future release. Use local metrics in the Metrics applet."
    });
  });
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      configFile: path4.join(SHELL_ROOT, "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path4.join(PROJECT_ROOT, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path4.join(PROJECT_ROOT, "dist", "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Omni Swim Suite running at http://localhost:${PORT}`);
  });
}
startServer();
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/**

 * @license

 * SPDX-License-Identifier: Apache-2.0

 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Team name → NCAA division lookup (fuzzy). Expand as needed.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 4: athlete history index. Test: npx tsx scripts/test_athlete_history.mjs
 */
