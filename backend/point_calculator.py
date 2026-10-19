import sys

import json

import math

import re

from collections import defaultdict



class ScoringSettingsMissing(ValueError):
    """No scoring configuration was supplied or found.

    There is deliberately no default scoring table. Place points differ by
    division and by conference, so a built-in table would be a guess that
    produces plausible, wrong totals for any meet outside the guessed division.

    `code` is the machine-readable tag the CLIs put in their error JSON, so the
    Node routes can tell this failure apart from a generic one.
    """

    code = 'scoring_settings_missing'


class PointsOnStatusClock(ValueError):
    """A row prints place points beside a clock that says the swim did not count.

    A swimmer who is NT, DQ, NS, SCR or DNF has no place, so a printed points
    value on the same row means the columns drifted: the points belong to a
    neighbouring row. Trusting them would put another swimmer's points on this
    team. Scoring stops instead, because there is no safe row to drop.

    `code` is the machine-readable tag the CLIs put in their error JSON.
    `rows` lists each offending row as a short description.
    """

    code = 'points_on_status_clock'

    def __init__(self, rows, total=None):
        self.rows = list(rows)
        self.total = total if total is not None else len(self.rows)
        shown = '; '.join(self.rows)
        more = f' (+{self.total - len(self.rows)} more)' if self.total > len(self.rows) else ''
        super().__init__(
            f'{self.total} row(s) print place points beside a clock that reads as '
            f'NT, DQ, NS, SCR or DNF, which means the PDF columns drifted. Nothing '
            f'was scored: {shown}{more}'
        )


def parse_pdf_points(value):
    """Read one printed PDF points value, or None when the PDF printed none.

    The single accepted shape is a finite, non-negative JSON number. `None` and
    an empty string mean "no points column value" and return None. Everything
    else raises ValueError, including booleans, non-numeric strings, and
    numeric strings (whitespace-wrapped or not). The TypeScript twin is
    `parsePdfPointsValue` in `apps/shell/lib/routes/parsingPipeline.ts`; both
    must accept and reject the same inputs.
    """
    if value is None or (isinstance(value, str) and value == ''):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'malformed pdf_points value: {value!r}')
    val = float(value)
    if not math.isfinite(val) or val < 0:
        raise ValueError(f'malformed pdf_points value: {value!r}')
    return val


def _is_nsisc_shaped_settings(cfg):
    try:
        return (
            int(cfg.get('maxIndividualScorersPerTeam', 999)) == 18
            and int(cfg.get('maxRelaysScoringPerTeam', 999)) == 2
            and cfg.get('scorerCapScope') == 'meet'
            and abs(float(cfg.get('diverScorerWeight', 1)) - (1.0 / 3.0)) < 0.01
        )
    except (TypeError, ValueError):
        return False


def _merge_roster_mode(cfg):
    if cfg.get('usePdfPlacePoints') is True:
        return cfg
    mode = cfg.get('scorerEligibilityMode')
    if mode != 'points_pool' and (mode == 'roster' or _is_nsisc_shaped_settings(cfg)):
        cfg['scorerEligibilityMode'] = 'roster'
        if not cfg.get('scorerAutoRules'):
            cfg['scorerAutoRules'] = {
                'abFinalTiers': ['A', 'B'],
                'includeRelayLegsInFinals': True,
                'distanceFinalRequired': True,
                'distanceEventPattern': ['1000', '1650', '1500'],
            }
    return cfg


def _results_have_pdf_place_points(athletes):
    non_recruit = [a for a in athletes if not a.get('is_recruit')]
    if not non_recruit:
        return False

    def _has_pdf(a):
        return parse_pdf_points(a.get('pdf_points')) is not None

    with_pdf = sum(1 for a in non_recruit if _has_pdf(a))
    threshold = max(8, math.ceil(len(non_recruit) * 0.01))
    return with_pdf >= threshold


def _effective_pdf_place_points_mode(cfg, athletes):
    flag = cfg.get('usePdfPlacePoints')
    if flag is False:
        return False
    if flag is True:
        return True
    if isinstance(flag, str) and flag.lower() == 'false':
        return False
    if isinstance(flag, str) and flag.lower() == 'true':
        return True
    return _results_have_pdf_place_points(athletes)


def _apply_pdf_place_neutral_caps(cfg):
    cfg['maxIndividualScorersPerTeam'] = 999
    cfg['maxRelaysScoringPerTeam'] = 999
    cfg['scorerCapScope'] = 'event'
    cfg['diverScorerWeight'] = 1
    cfg['relayEligibleFromScorerPool'] = False


def _apply_pdf_place_scoring_lock(cfg):
    cfg['scorerEligibilityMode'] = 'points_pool'
    if 'scorerAutoRules' in cfg:
        del cfg['scorerAutoRules']
    _apply_pdf_place_neutral_caps(cfg)


def _pdf_place_points_for_row(a, cfg=None):
    """
    Place points a row earns when the source PDF already prints them.

    The meet's scored program bounds this the same way it bounds the calculated
    path. `pdf_points` is read off any row whose line ends in a points integer,
    once a results header sets the meet-wide points latch — the extractor never
    filters by event number. So a post-program extra session (NSISC events
    938/939) carries a printed points column even though the meet's own "Team
    Rankings - Through Event 42" leaves it out of the team totals. That boundary
    comes from the same official rankings block, so honouring it here makes this
    path agree with the published totals rather than diverge from them.

    Only `is_outside_scored_program` applies. The rest of
    `is_unscored_round_or_event` (the `unscoredRounds` list) deliberately does
    not: this mode trusts the PDF's own points column, and a C final the meet
    chose to award points to is a meet decision to reproduce, not to override.

    The clause order matches this function's TypeScript twin,
    `pdfPlacePointsForRow` in `packages/core/src/lib/utils.ts`, which already
    carried the boundary check. This copy is the one that drifted.
    """
    if a.get('is_exhibition'):
        return 0.0
    ev_nm = str(a.get('event', '') or '')
    if is_outside_scored_program(ev_nm, (cfg or {}).get('scoredEventNumberMax')):
        return 0.0
    if a.get('is_time_trial') and not is_championship_gender_event(ev_nm):
        return 0.0
    val = parse_pdf_points(a.get('pdf_points'))
    return 0.0 if val is None else val


def _relay_team_clock(a):
    return str(a.get('relay_team_time') or a.get('finals_time') or a.get('prelims_time') or '').strip()


def _relay_entry_group_key(a):
    """One team relay entry (all four legs); not per-leg."""
    rk = parse_rank_int(a)
    rk_s = str(rk) if rk is not None else ''
    return '|'.join([
        str(a.get('event') or '').strip(),
        str(a.get('team') or '').strip(),
        str(a.get('round_swam') or '').strip(),
        rk_s,
        _relay_team_clock(a),
    ])


def _resolve_scoring_settings(scoring_settings=None, overrides=None):
    """Return the complete scoring configuration, or raise.

    `scoring_settings` is a complete configuration supplied by the caller. When
    it is empty the settings file is loaded instead; a missing file raises
    `ScoringSettingsMissing`. `overrides` are applied on top of whichever base
    was used (the parse pipeline passes the meet's own `scoredEventNumberMax`
    this way so that a meet boundary never replaces the settings).
    """

    import os

    from pathlib import Path



    cfg = {}

    if not scoring_settings:

        settings_path = None

        data_dir = os.environ.get('OMNI_DATA_DIR')

        if data_dir:

            candidate = Path(data_dir) / 'scoring_settings.json'

            if candidate.is_file():

                settings_path = str(candidate)

        if not settings_path:

            repo_root = Path(__file__).resolve().parent.parent

            for candidate in (

                repo_root / 'data' / 'scoring_settings.json',

                repo_root / 'scoring_settings.json',

                Path('scoring_settings.json'),

            ):

                if candidate.is_file():

                    settings_path = str(candidate.resolve())

                    break

        if settings_path:

            with open(settings_path, 'r', encoding='utf-8') as f:

                settings_file = json.load(f)

            for k, v in settings_file.items():

                if isinstance(v, dict) and 'value' in v:

                    cfg[k] = v['value']

                else:

                    cfg[k] = v
        else:
            raise ScoringSettingsMissing(
                'No scoring settings file found (looked in OMNI_DATA_DIR, data/ and the working '
                'directory). Refusing to score without settings; there is no default scoring table.'
            )

    else:

        cfg = dict(scoring_settings)

    if overrides:
        cfg.update(overrides)

    sp = cfg.get('scoringPoints')
    if not isinstance(sp, list) or not sp:
        raise ScoringSettingsMissing(
            "Scoring settings have no 'scoringPoints' table; refusing to substitute a default."
        )
    rm = cfg.get('relayMultiplier')
    if isinstance(rm, bool) or not isinstance(rm, (int, float)):
        raise ScoringSettingsMissing(
            "Scoring settings have no numeric 'relayMultiplier'; refusing to substitute a default."
        )

    cfg.setdefault('halfRateRelaySwimmer', True)

    cfg.setdefault('maxIndividualScorersPerTeam', 999)

    cfg.setdefault('maxRelaysScoringPerTeam', 999)

    cfg.setdefault('scorerCapScope', 'event')

    cfg.setdefault('diverScorerWeight', 1)

    cfg.setdefault('relayEligibleFromScorerPool', False)

    if _is_nsisc_shaped_settings(cfg):
        cfg['maxRelaysScoringPerTeam'] = min(int(cfg.get('maxRelaysScoringPerTeam', 2)), 2)

    cfg.setdefault('maxRosterSize', 99)

    cfg.setdefault('unscoredRounds', ['C FINAL', 'C-FINAL', 'BONUS FINAL', 'D FINAL', 'D-FINAL', 'TIME TRIAL'])

    # Last event number the meet scored, from "Team Rankings - Through Event N".
    # None means the meet published no boundary, so every event scores.
    cfg.setdefault('scoredEventNumberMax', None)

    cfg.setdefault('exhibitionMarkers', ['x', 'X'])

    cfg.setdefault('timeTrialMarkers', ['TIME TRIAL', 'TT'])

    npts = len(cfg['scoringPoints'])

    cfg.setdefault('aFinalBracketSize', max(1, npts // 2))

    return _merge_roster_mode(cfg)





def _normalized_round_label(label):

    # "Timed Finals" holds the text "D FINAL" (TIME-D FINAL-s). Read it as "Finals".

    return re.sub(r'\bTIMED[\s-]+FINAL(S?)\b', r'FINAL\1', (label or '').upper())




def classify_round_tier(round_swam):

    r = _normalized_round_label(round_swam)

    if 'TIME TRIAL' in r or 'TIME TRIALS' in r:

        return 'TT'

    if 'C FINAL' in r or 'C-FINAL' in r or 'BONUS FINAL' in r:

        return 'C'

    if 'D FINAL' in r or 'D-FINAL' in r:

        return 'D'

    if 'PRELIM' in r:

        return 'PRE'

    if 'B FINAL' in r or 'B-FINAL' in r or 'CONSOLATION' in r:

        return 'B'

    if 'A FINAL' in r or 'A-FINAL' in r or 'CHAMPIONSHIP' in r:

        return 'A'

    if re.match(r'^FINALS?$', r.strip()) or (
        re.search(r'\bFINALS?\b', r) and not re.search(r'[ABCD]\s*FINAL', r)
    ):

        return 'FIN'

    return 'UNK'





def is_distance_event(event_name):

    u = (event_name or '').upper()

    return bool(re.search(r'\b(1000|1650|1500|800|10000)\b', u)) or 'TIMED' in u





def is_timed_final_distance_heat(round_swam, event_name):

    if not is_distance_event(event_name):

        return False

    return classify_round_tier(round_swam) == 'FIN'





def is_timed_final_distance_session(ev_athletes):

    return bool(ev_athletes) and all(
        is_timed_final_distance_heat(a.get('round_swam'), a.get('event')) for a in ev_athletes
    )





def is_championship_gender_event(event_name):

    return bool(re.search(r'\b(Boys?|Girls?)\b', event_name or '', re.IGNORECASE))





def is_diving_event(event_name, cfg=None):

    u = (event_name or '').upper()

    patterns = (cfg or {}).get('diverEventPattern') if cfg else None

    if patterns:

        for p in patterns:

            token = str(p).upper()

            if token == 'DIVE':

                if re.search(r'\bDIVE\b', u):

                    return True

            elif token in u:

                return True

        return False

    return 'DIVING' in u or bool(re.search(r'\bDIVE\b', u))





def parse_event_number(event_name):
    """Event number from a HyTek label ("Event 13 Men 100 Fly" -> 13), else None."""
    m = re.match(r'\s*Event\s+(\d+)\b', str(event_name or ''), re.IGNORECASE)
    return int(m.group(1)) if m else None


def is_outside_scored_program(event_name, scored_event_number_max):
    """
    True when the label names an event past the meet's scored program.

    HyTek numbers post-meet extra sessions above the program and leaves them out
    of the published team totals. Most carry "Time Trial" in the name, but the
    host may omit it — the 2026 NSISC results print events 938/939 after the
    time trials with nothing but the number to give them away. Only a positively
    out-of-range number excludes a row; an unnumbered label keeps scoring.
    """
    if scored_event_number_max is None:
        return False
    n = parse_event_number(event_name)
    return n is not None and n > scored_event_number_max


def is_unscored_round_or_event(round_swam, event_name, cfg):

    r = _normalized_round_label(round_swam)

    e = _normalized_round_label(event_name)

    if is_outside_scored_program(event_name, cfg.get('scoredEventNumberMax')):

        return True

    for ur in cfg.get('unscoredRounds', []):

        u = ur.upper()

        if u in r or u in e:

            return True

    if 'TIME TRIAL' in e and not is_championship_gender_event(event_name):

        return True

    return False


_NON_SCORING_TIME_RE = re.compile(
    r'^(?:DQ|DFS|SCR|NS|NP|NC|NT|N/A|---)(?:\b|$)',
    re.IGNORECASE,
)


def _is_finals_round(round_swam):
    tier = classify_round_tier(round_swam)
    return tier in ('A', 'B', 'FIN')


def _swim_result_clock(a):
    if classify_round_tier(a.get('round_swam')) == 'PRE':
        return str(a.get('prelims_time') or a.get('time') or '').strip()
    return str(
        a.get('relay_team_time') or a.get('finals_time') or a.get('time') or ''
    ).strip()


def is_scoring_swim_time(clock):
    u = str(clock or '').strip()
    if not u:
        return False
    return _NON_SCORING_TIME_RE.match(u) is None


def is_scoring_athlete(a):
    if not _is_finals_round(a.get('round_swam')):
        return True
    return is_scoring_swim_time(_swim_result_clock(a))


def can_score_swim(round_swam, event_name, cfg):

    if is_unscored_round_or_event(round_swam, event_name, cfg):

        return False

    tier = classify_round_tier(round_swam)

    if tier in ('TT', 'C', 'D'):

        return False

    if tier == 'PRE':

        return is_distance_event(event_name) or is_diving_event(event_name, cfg)

    return True





def _score_timed_final_individuals(
    ev_athletes,
    cfg,
    meet_states,
    gender,
    use_meet_wide_pool,
    roster_is_scorer,
    max_individuals_cfg,
):
    """Timed-finals distance: scoring-place ladder skips non-point-earning finishers."""
    SCORING = cfg['scoringPoints']
    out = []
    by_rank = defaultdict(list)
    for a in ev_athletes:
        rk = parse_rank_int(a)
        key = str(rk) if rk is not None and rk > 0 else f"T|{id(a)}"
        by_rank[key].append(a)

    def rank_sort_key(item):
        a = item[1][0]
        return parse_rank_int(a) or 9999

    sorted_groups = sorted(by_rank.items(), key=rank_sort_key)
    team_indiv_counts = defaultdict(int)
    scoring_place = 0

    for _key, group in sorted_groups:
        ineligible = [a for a in group if not is_scoring_athlete(a)]
        for athlete in ineligible:
            athlete['calculated_points'] = 0.0
        out.extend(ineligible)

        eligible = [a for a in group if is_scoring_athlete(a)]
        if not eligible:
            continue

        sample = eligible[0]
        ev_nm = str(sample.get('event', '') or '')
        point_eligible = []

        for athlete in eligible:
            if athlete.get('is_exhibition', False):
                athlete['calculated_points'] = 0.0
                out.append(athlete)
                continue
            if athlete.get('is_time_trial', False) and not is_championship_gender_event(ev_nm):
                athlete['calculated_points'] = 0.0
                out.append(athlete)
                continue
            rs = str(athlete.get('round_swam', '') or '')
            if not can_score_swim(rs, ev_nm, cfg):
                athlete['calculated_points'] = 0.0
                out.append(athlete)
                continue
            point_eligible.append(athlete)

        if not point_eligible:
            continue

        avail = len(SCORING) - scoring_place
        take = min(len(point_eligible), avail)
        slice_pts = SCORING[scoring_place : scoring_place + take]
        if not slice_pts:
            for athlete in point_eligible:
                athlete['calculated_points'] = 0.0
                out.append(athlete)
            continue

        avg_pts = sum(slice_pts) / len(point_eligible)
        by_team = defaultdict(list)
        for athlete in point_eligible:
            by_team[athlete.get('team')].append(athlete)

        any_awarded = False
        for team_name, members in by_team.items():
            mkey = _meet_state_key(team_name, gender)
            unique_names = list({a.get('name') for a in members})

            if use_meet_wide_pool:
                if mkey not in meet_states:
                    meet_states[mkey] = {'pool': {}, 'relays': 0}
                pool = meet_states[mkey]['pool']
                can_all = all(_can_add_to_pool(pool, n, ev_nm, cfg) for n in unique_names)
                for athlete in members:
                    award = avg_pts if can_all else 0.0
                    athlete['calculated_points'] = award
                    out.append(athlete)
                    if award > 0:
                        any_awarded = True
                if can_all:
                    for n in unique_names:
                        _add_to_pool(pool, n, ev_nm, cfg)
            elif max_individuals_cfg < 999 and team_indiv_counts[team_name] >= max_individuals_cfg:
                for athlete in members:
                    athlete['calculated_points'] = 0.0
                    out.append(athlete)
            else:
                for athlete in members:
                    athlete['calculated_points'] = avg_pts
                    out.append(athlete)
                any_awarded = True
                if max_individuals_cfg < 999:
                    team_indiv_counts[team_name] += len(unique_names)

        if any_awarded:
            scoring_place += take

    return out


def _rank_as_if_exhibition_absent(athletes):
    """Rewrite ranks in place as if every exhibition entry were absent (user decision E2).

    In each round tier that holds an exhibition entry with a rank, every other ranked
    row moves up by the exhibition entries ranked strictly ahead of it (the subtraction
    `shiftRanksAfterRemoval` makes in TypeScript). The result is floored at 1 plus the
    number of other ranked rows strictly ahead, so a tie keeps its rank and the entry
    after a tie of n still skips n places.

    A gap in the printed ranks is the meet's data and survives: a row at A-Final rank 12
    behind eight finishers moves to 11, not to the dense rank 9. A disqualified or
    time-trial row holds its printed place and counts as ahead; only the exhibition
    entries leave. Pass every row of the event, including rows set aside for an unreadable
    time, so the count matches TypeScript. A tier with no ranked exhibition entry is not
    touched. TS twin: `rankAsIfExhibitionAbsent` in individualScoring.ts.

    Returns [(athlete, source_rank)] so the caller can restore the printed ranks.
    """
    exhibition_tiers = set()
    for a in athletes:
        rk = parse_rank_int(a)
        if is_scoring_athlete(a) and a.get('is_exhibition', False) and rk is not None and rk >= 1:
            exhibition_tiers.add(classify_round_tier(a.get('round_swam')))
    if not exhibition_tiers:
        return []

    exhibition = []
    present = []
    for a in athletes:
        rk = parse_rank_int(a)
        if rk is None or rk < 1:
            continue
        tier = classify_round_tier(a.get('round_swam'))
        if tier not in exhibition_tiers:
            continue
        if is_scoring_athlete(a) and a.get('is_exhibition', False):
            exhibition.append((rk, tier))
        else:
            present.append((a, rk, tier))

    rewrites = []
    for a, rk, tier in present:
        exhibition_ahead = sum(1 for xrk, xtier in exhibition if xtier == tier and xrk < rk)
        others_ahead = sum(1 for _h, hrk, htier in present if htier == tier and hrk < rk)
        new_rank = max(rk - exhibition_ahead, 1 + others_ahead, 1)
        if new_rank != rk:
            rewrites.append((a, a.get('rank'), new_rank))
    for a, _source, new_rank in rewrites:
        a['rank'] = new_rank
    return [(a, source) for a, source, _new in rewrites]


def _athlete_has_finals_dive_in_event(event_rows, name, team, cfg):

    n = (name or '').strip()

    t = (team or '').strip()

    for r in event_rows:

        if (r.get('name') or '').strip() != n:

            continue

        if (str(r.get('team') or '').strip()) != t:

            continue

        if not is_diving_event(r.get('event'), cfg):

            continue

        tier = classify_round_tier(r.get('round_swam'))

        if tier in ('A', 'B'):

            return True

    return False





def parse_rank_int(a):

    rk = a.get('rank')

    if rk is None:

        return None

    m = re.search(r'(\d+)', str(rk))

    return int(m.group(1)) if m else None





def scoring_row_index(round_swam, rank_int, event_name, cfg):

    if rank_int is None or rank_int < 1:

        return None

    if not can_score_swim(round_swam, event_name, cfg):

        return None

    pts = cfg['scoringPoints']

    if not pts:

        return None

    bracket = int(cfg.get('aFinalBracketSize', len(pts) // 2))

    tier = classify_round_tier(round_swam)

    if tier == 'B':

        return _scoring_row_index_b_final(rank_int, bracket, len(pts))

    idx = rank_int - 1

    return idx if 0 <= idx < len(pts) else None





def _scoring_row_index_b_final(rank_int, bracket, pts_len):

    if rank_int < 1:

        return None

    last_place = min(pts_len, bracket * 2)

    if rank_int > bracket:

        if rank_int < bracket + 1 or rank_int > last_place:

            return None

        idx = rank_int - 1

        return idx if 0 <= idx < pts_len else None

    idx = bracket + (rank_int - 1)

    return idx if 0 <= idx < pts_len else None





def scoring_row_index_for_relay(round_swam, rank_int, event_name, cfg):

    return scoring_row_index(round_swam, rank_int, event_name, cfg)





def round_tier_sort_order(round_swam):

    tier = classify_round_tier(round_swam)

    return {'A': 1, 'FIN': 1, 'UNK': 1, 'B': 2, 'PRE': 3, 'C': 8, 'D': 8, 'TT': 9}.get(tier, 5)





def time_to_sec(t):
    """Seconds for a printed clock, or None when there is no readable time.

    None means absent. It is never a number: an empty, NT, DQ or unparseable
    clock has no seconds value, so nothing here may stand in for one. Callers
    must handle None (see `_unreadable_time_warning`).

    Trailing qualifier letters ("1:02.63R") are still stripped and read.
    """
    if not t:
        return None
    val = re.sub(r'[^\d\.:]', '', str(t)).rstrip('.')
    if not val:
        return None
    if ':' in val:
        parts = val.split(':')
        if len(parts) > 2:
            return None
        try:
            return float(parts[0]) * 60 + float(parts[1])
        except ValueError:
            return None
    try:
        return float(val)
    except ValueError:
        return None


def _row_time_seconds(a):
    """Seconds of the swim a row reports, or None when it has no readable time.

    The finals clock wins over the prelims clock, matching `get_ev_sort_key`.
    """
    clock = a.get('finals_time') or a.get('prelims_time') or a.get('relay_team_time')
    return time_to_sec(clock) if clock else None


def _unreadable_time_warning(a, points_kept=False):
    """None when the row has a readable time, else a warning dict for it.

    `points_kept` is True in PDF-place-points mode, where the points printed in
    the PDF are trusted and the clock is never consulted: the warning then says
    the row still carries them, because "earns no points" would be false.
    """
    if _row_time_seconds(a) is not None:
        return None
    clock = str(
        a.get('finals_time') or a.get('prelims_time') or a.get('relay_team_time') or ''
    ).strip()
    if not clock:
        reason = 'empty'
    elif _NON_SCORING_TIME_RE.match(clock):
        reason = 'status_code'
    else:
        reason = 'unparseable'
    who = str(a.get('name') or '?')
    event = str(a.get('event') or '?')
    shown = repr(clock) if clock else 'no time printed'
    outcome = (
        "the points printed in the PDF were kept."
        if points_kept
        else 'the row earns no place and no points.'
    )
    return {
        'code': 'unreadable_time',
        'reason': reason,
        'value': clock or None,
        'message': f'{who}, {event}: no readable swim time ({shown}); {outcome}',
    }


_STATUS_CLOCK_RE = re.compile(r'^(?:NT|DQ|NS|SCR|DNF)\b', re.IGNORECASE)


def _check_points_beside_status_clocks(athletes, max_listed=10):
    """Raise PointsOnStatusClock when a row has pdf_points > 0 and a status clock.

    Only the explicit status words count. An empty or garbled clock is a missing
    time, not a contradiction, and keeps the points the PDF printed.
    """
    offenders = []
    for i, a in enumerate(athletes):
        pts = parse_pdf_points(a.get('pdf_points'))
        if pts is None or pts <= 0:
            continue
        clock = str(
            a.get('finals_time') or a.get('prelims_time') or a.get('relay_team_time') or ''
        ).strip()
        if _STATUS_CLOCK_RE.match(clock):
            offenders.append(
                f"row {i} ({a.get('name') or '?'}, {a.get('event') or '?'}): "
                f"clock {clock!r} with {pts:g} printed points"
            )
    if offenders:
        raise PointsOnStatusClock(offenders[:max_listed], total=len(offenders))


def _add_row_warning(a, warning):
    """Append a warning to the row's `parse_warnings`, once per code."""
    existing = a.get('parse_warnings')
    if not isinstance(existing, list):
        existing = []
        a['parse_warnings'] = existing
    if not any(isinstance(w, dict) and w.get('code') == warning['code'] for w in existing):
        existing.append(warning)


def _set_aside_untimed_rows(ev_athletes, scored_out):
    """Return the rows with a readable time; zero and record the rest.

    A row with no readable time earns no place and no points, and it must not
    take a scoring slot or dilute a tie. So it never reaches the place ladder.
    It stays in the output with `calculated_points` 0.0 (the value every other
    non-scoring row carries) and a warning, appended to `scored_out` once.
    """
    timed = []
    for a in ev_athletes:
        warning = _unreadable_time_warning(a)
        if warning is None:
            timed.append(a)
            continue
        a['podium'] = None
        a['cutline_achieved'] = a.get('is_cutline', False)
        a['calculated_points'] = 0.0
        _add_row_warning(a, warning)
        scored_out.append(a)
    return timed


def get_ev_sort_key(a):
    """Sort key (tier, rank, time-missing, seconds). A missing time sorts last."""
    t = _row_time_seconds(a)
    missing = t is None
    seconds = 0.0 if missing else t

    is_exh = a.get('is_exhibition', False)
    is_tt = a.get('is_time_trial', False)
    if is_exh or is_tt:
        return (99999, 99999, missing, seconds)

    rnum = parse_rank_int(a)
    if rnum is None:
        rnum = 9999
    return (round_tier_sort_order(a.get('round_swam')), rnum, missing, seconds)


def event_meet_sort_key(event_name):

    m = re.search(r'Event\s+(\d+)', event_name or '', re.I)

    return int(m.group(1)) if m else 99999





def _norm_name(name):

    return re.sub(r'\s+', ' ', (name or '').strip().lower())





def _scorer_weight(event_name, cfg):

    if not is_diving_event(event_name, cfg):

        return 1.0

    return cfg.get('diverScorerWeight', 1)





def _pool_total(pool):

    return sum(pool.values())





def _in_pool(pool, name):

    return _norm_name(name) in pool





def _can_add_to_pool(pool, name, event_name, cfg):

    cap = float(cfg.get('maxIndividualScorersPerTeam', 18))

    if cap >= 999:

        return True

    key = _norm_name(name)

    if key in pool:

        return True

    return _pool_total(pool) + _scorer_weight(event_name, cfg) <= cap + 1e-9





def _add_to_pool(pool, name, event_name, cfg):

    key = _norm_name(name)

    if key not in pool:

        pool[key] = _scorer_weight(event_name, cfg)





def _meet_state_key(team, gender):

    return f"{team}|||{gender or ''}"





def _roster_key(team, gender, name):

    return f"{team}|||{gender or ''}|||{_norm_name(name)}"





def _distance_for_rules(event_name, rules):

    patterns = (rules or {}).get('distanceEventPattern') or ['1000', '1650', '1500']

    u = (event_name or '').upper()

    return any(str(p).upper() in u for p in patterns)





def _row_suggests_scorer(ath, rules):

    if not rules:

        return False

    tiers = rules.get('abFinalTiers') or ['A', 'B']

    tier = classify_round_tier(ath.get('round_swam'))

    # A relay has no A or B heat: it is swum once, as a timed final (tier FIN).
    # That is a final, so a relay leg in it counts like a leg in an A or B final.
    # Relay legs only: an individual swim in a FIN round marks no scorer.
    # Effect: a relay-only swimmer of a timed-final relay now joins the scorer
    # roster and counts toward its caps. Mirrors scorerRoster.ts rowSuggestsScorer.
    # A SwimCloud entry row (legs listed in relayNames) is a label, not a swimmer.
    entry_label = bool(ath.get('relayNames') or ath.get('relay_names'))

    if tier not in tiers and not (ath.get('is_relay') and tier == 'FIN' and not entry_label):

        return False

    if rules.get('distanceFinalRequired') and _distance_for_rules(ath.get('event'), rules):

        if tier == 'PRE':

            return False

    if ath.get('is_relay'):

        return rules.get('includeRelayLegsInFinals', True)

    return True





def _build_roster_is_scorer(athletes, cfg):

    rules = _effective_auto_rules(cfg)

    overrides = cfg.get('scorerRosterOverrides') or []

    auto_keys = set()

    for a in athletes:

        if _row_suggests_scorer(a, rules):

            auto_keys.add(_roster_key(a.get('team'), a.get('gender'), a.get('name')))

    manual = {}

    for o in overrides:

        manual[_roster_key(o.get('team'), o.get('gender'), o.get('name'))] = bool(o.get('isScorer'))

    def is_scorer(name, team, gender):

        k = _roster_key(team, gender, name)

        if k in manual:

            return manual[k]

        return k in auto_keys

    return is_scorer





def _uses_roster(cfg):

    return cfg.get('scorerEligibilityMode') == 'roster'





def _effective_auto_rules(cfg):

    rules = cfg.get('scorerAutoRules')

    if rules:

        return rules

    return {

        'abFinalTiers': ['A', 'B'],

        'includeRelayLegsInFinals': True,

        'distanceFinalRequired': True,

        'distanceEventPattern': ['1000', '1650', '1500'],

    }





def _relay_entry_roster_eligible(group, cfg, roster_is_scorer):

    if not _uses_roster(cfg):

        return True

    sample = group[0]

    rules = _effective_auto_rules(cfg)

    tier = classify_round_tier(sample.get('round_swam'))

    tiers = rules.get('abFinalTiers') or ['A', 'B']

    # A timed-final relay (tier FIN) counts as a final: same rule as
    # _row_suggests_scorer and relayEntryRosterEligible in scorerRoster.ts.
    if rules.get('includeRelayLegsInFinals', True) and (tier in tiers or tier == 'FIN'):

        return True

    if roster_is_scorer is None:

        return False

    team_name = sample.get('team')

    gender = sample.get('gender')

    return all(roster_is_scorer(a.get('name'), team_name, gender) for a in group)





def _is_ab_final_relay_leg(ath, cfg):

    if not ath.get('is_relay'):

        return False

    return _row_suggests_scorer(ath, _effective_auto_rules(cfg))





def _seed_ab_relay_legs_into_pool(relay_athletes, cfg, meet_states, gender):

    for a in relay_athletes:

        if not _is_ab_final_relay_leg(a, cfg):

            continue

        team_name = a.get('team')

        mkey = _meet_state_key(team_name, gender)

        if mkey not in meet_states:

            meet_states[mkey] = {'pool': {}, 'relays': 0}

        pool = meet_states[mkey]['pool']

        ev_nm = str(a.get('event', '') or '')

        if _can_add_to_pool(pool, a.get('name'), ev_nm, cfg):

            _add_to_pool(pool, a.get('name'), ev_nm, cfg)





def calculate_points(athletes, scoring_settings=None, overrides=None):

    cfg = _resolve_scoring_settings(scoring_settings, overrides)

    for ath in athletes:

        ev_name = str(ath.get('event', '')).upper()

        rank_str = str(ath.get('rank', ''))

        t_final = str(ath.get('finals_time', ''))

        t_pre = str(ath.get('prelims_time', ''))

        ath['is_exhibition'] = False

        ath['is_time_trial'] = False

        for marker in cfg.get('exhibitionMarkers', ['x', 'X']):

            if marker in rank_str or marker in t_final or marker in t_pre:

                ath['is_exhibition'] = True

        for marker in cfg.get('timeTrialMarkers', ['TIME TRIAL', 'TT']):

            if re.search(r'\b' + re.escape(marker) + r'\b', ev_name):

                ath['is_time_trial'] = True

        if re.search(r'\bTIME\s+TRIAL\b', ev_name):

            ath['is_time_trial'] = True

    if _effective_pdf_place_points_mode(cfg, athletes):
        _check_points_beside_status_clocks(athletes)
        _apply_pdf_place_scoring_lock(cfg)
        for ath in athletes:
            ath['calculated_points'] = _pdf_place_points_for_row(ath, cfg)
            # Points stay as the PDF printed them; an unreadable clock is only recorded.
            warning = _unreadable_time_warning(ath, points_kept=True)
            if warning is not None:
                _add_row_warning(ath, warning)
        return athletes

    SCORING = cfg['scoringPoints']

    relay_multiplier = cfg['relayMultiplier']

    half_rate_relay = cfg['halfRateRelaySwimmer']

    max_relays_cfg = cfg['maxRelaysScoringPerTeam']

    max_individuals_cfg = cfg['maxIndividualScorersPerTeam']

    use_meet_wide_pool = cfg.get('scorerCapScope') == 'meet' and max_individuals_cfg < 999

    roster_is_scorer = _build_roster_is_scorer(athletes, cfg) if _uses_roster(cfg) else None

    relay_pool_rule = cfg.get('relayEligibleFromScorerPool', False) and not _uses_roster(cfg)

    process_events_chronologically = (
        use_meet_wide_pool
        or relay_pool_rule
        or max_relays_cfg < 999
        or max_individuals_cfg < 999
    )

    events = defaultdict(list)

    for ath in athletes:

        events[(ath['event'], ath['gender'])].append(ath)



    meet_states = {}

    scored_athletes = []



    sorted_event_keys = sorted(events.keys(), key=lambda k: event_meet_sort_key(k[0]))



    event_list = [(k, events[k]) for k in sorted_event_keys]

    def _process_scoring_event(ev_athletes, gender):

        all_event_rows = ev_athletes
        ev_athletes = _set_aside_untimed_rows(ev_athletes, scored_athletes)
        if not ev_athletes:
            return

        is_relay = any(a.get('is_relay') for a in ev_athletes)



        for a in ev_athletes:

            rk_s = str(a.get('rank'))
            a['podium'] = (
                'gold' if rk_s == '1' else 'silver' if rk_s == '2' else 'bronze' if rk_s == '3' else None
            )

            a['cutline_achieved'] = a.get('is_cutline', False)

            a['calculated_points'] = "N/A"



        if is_relay:

            teams = defaultdict(list)

            for a in ev_athletes:

                teams[_relay_entry_group_key(a)].append(a)



            sorted_keys = sorted(list(teams.keys()), key=lambda k: get_ev_sort_key(teams[k][0]))

            team_relay_counts = defaultdict(int)



            for t_key in sorted_keys:

                group = teams[t_key]

                team_athlete = group[0]

                is_exhibition = team_athlete.get('is_exhibition', False)

                is_time_trial = team_athlete.get('is_time_trial', False)

                ev_nm = str(team_athlete.get('event', '') or '')

                rs = str(team_athlete.get('round_swam', '') or '')

                rk = parse_rank_int(team_athlete)

                team_name = team_athlete.get('team')



                can_score = (

                    not is_exhibition

                    and not (is_time_trial and not is_championship_gender_event(ev_nm))

                    and can_score_swim(rs, ev_nm, cfg)

                    and is_scoring_athlete(team_athlete)

                )

                idx = scoring_row_index_for_relay(rs, rk, ev_nm, cfg) if can_score else None



                if idx is None:

                    for a in group:

                        a['calculated_points'] = 0.0

                    scored_athletes.extend(group)

                    continue



                mkey = _meet_state_key(team_name, gender)

                # Relay cap is per team per relay event (_process_scoring_event is one event).
                relay_count = team_relay_counts[team_name]



                if relay_count >= max_relays_cfg:

                    for a in group:

                        a['calculated_points'] = 0.0

                    scored_athletes.extend(group)

                    continue



                if roster_is_scorer is not None:

                    if not _relay_entry_roster_eligible(group, cfg, roster_is_scorer):

                        for a in group:

                            a['calculated_points'] = 0.0

                        scored_athletes.extend(group)

                        continue

                elif use_meet_wide_pool and relay_pool_rule:

                    pool = meet_states[mkey]['pool']

                    if not all(_in_pool(pool, a.get('name')) for a in group):

                        for a in group:

                            a['calculated_points'] = 0.0

                        scored_athletes.extend(group)

                        continue



                team_pts_val = SCORING[idx] * relay_multiplier

                num_swimmers = len(group)

                if half_rate_relay and num_swimmers <= 4:

                    divisor = 4.0 if num_swimmers >= 4 else num_swimmers

                    swimmer_pts = team_pts_val / divisor if divisor > 0 else 0

                else:

                    swimmer_pts = team_pts_val / num_swimmers if num_swimmers > 0 else 0



                team_relay_counts[team_name] += 1



                for a in group:

                    a['calculated_points'] = swimmer_pts

                scored_athletes.extend(group)



        else:

            if is_timed_final_distance_session(ev_athletes):

                scored_athletes.extend(
                    _score_timed_final_individuals(
                        ev_athletes,
                        cfg,
                        meet_states,
                        gender,
                        use_meet_wide_pool,
                        roster_is_scorer,
                        max_individuals_cfg,
                    )
                )

            else:

                # Ranks as if every exhibition entry were absent; restored after the event.
                source_ranks = _rank_as_if_exhibition_absent(all_event_rows)

                ind_by_key = defaultdict(list)

                for a in ev_athletes:

                    rk = parse_rank_int(a)

                    if rk is None or rk < 1:

                        key = (a.get('round_swam') or '', -1, id(a))

                    else:

                        key = (a.get('round_swam') or '', rk)

                    ind_by_key[key].append(a)



                # An exhibition row sorts last, so key a tie group off a row that holds
                # the place: the scoring rows of the group keep their order (TS twin
                # `buildIndividualEventGroups` keys off the group's first row).
                sorted_groups = sorted(
                    ind_by_key.values(),
                    key=lambda grp: get_ev_sort_key(
                        next((a for a in grp if not a.get('is_exhibition', False)), grp[0])
                    ),
                )

                team_indiv_counts = defaultdict(int)



                for group in sorted_groups:

                    ineligible = [a for a in group if not is_scoring_athlete(a)]

                    eligible = [a for a in group if is_scoring_athlete(a)]

                    for athlete in ineligible:

                        athlete['calculated_points'] = 0.0

                    scored_athletes.extend(ineligible)

                    # An exhibition swim holds no place: it scores 0 and leaves the tie
                    # count, whichever row of the group it is. The other rows earn what
                    # they would with it absent (user decision E2). TS twin:
                    # `eligibleIndividualGroupOrNull`.
                    exhibition_rows = [a for a in eligible if a.get('is_exhibition', False)]

                    for athlete in exhibition_rows:

                        athlete['calculated_points'] = 0.0

                    scored_athletes.extend(exhibition_rows)

                    eligible = [a for a in eligible if not a.get('is_exhibition', False)]

                    if not eligible:

                        continue

                    team_athlete = eligible[0]

                    # Any time trial in the group removes the group (TS: `eligible.some`).
                    is_time_trial = any(a.get('is_time_trial', False) for a in eligible)

                    ev_nm = str(team_athlete.get('event', '') or '')

                    rs = str(team_athlete.get('round_swam', '') or '')

                    rk = parse_rank_int(team_athlete)

                    grp_len = len(eligible)

                    is_prelim_diving = (
                        classify_round_tier(rs) == 'PRE' and is_diving_event(ev_nm, cfg)
                    )



                    if (
                        (is_time_trial and not is_championship_gender_event(ev_nm))
                        or not can_score_swim(rs, ev_nm, cfg)
                    ):

                        for athlete in eligible:

                            athlete['calculated_points'] = 0.0

                        scored_athletes.extend(eligible)

                        continue



                    base_idx = scoring_row_index(rs, rk, ev_nm, cfg)

                    if base_idx is None:

                        for athlete in eligible:

                            athlete['calculated_points'] = 0.0

                        scored_athletes.extend(eligible)

                        continue



                    avail = len(SCORING) - base_idx

                    take = min(grp_len, avail)

                    slice_pts = SCORING[base_idx : base_idx + take]

                    if not slice_pts:

                        for athlete in eligible:

                            athlete['calculated_points'] = 0.0

                        scored_athletes.extend(eligible)

                        continue



                    avg_pts = sum(slice_pts) / grp_len



                    by_team = defaultdict(list)

                    for athlete in eligible:

                        by_team[athlete.get('team')].append(athlete)



                    for team_name, members in by_team.items():

                        mkey = _meet_state_key(team_name, gender)

                        unique_names = list({a.get('name') for a in members})

                        def _prelim_dive_blocked(athlete):

                            return is_prelim_diving and _athlete_has_finals_dive_in_event(
                                ev_athletes, athlete.get('name'), team_name, cfg
                            )

                        if roster_is_scorer is not None:

                            # Roster eligibility is per swimmer, as in TS
                            # `awardIndividualEventTeamGroup`: a tied teammate off the scoring
                            # roster costs only their own points. The tie share is unchanged.
                            on_roster = {
                                n: roster_is_scorer(n, team_name, gender) for n in unique_names
                            }

                            # Admission is per athlete, fastest first, as in TS
                            # `admitTieGroupToMeetPool` / `admitTieGroupToEventCap`. An
                            # athlete the cap cannot take forfeits their share; the share of
                            # the others does not move.
                            candidates = [
                                a for a in members
                                if on_roster[a.get('name')] and not _prelim_dive_blocked(a)
                            ]
                            best_seconds = {}
                            for a in candidates:
                                t = _row_time_seconds(a)
                                t = float('inf') if t is None else t
                                n = a.get('name')
                                if n not in best_seconds or t < best_seconds[n]:
                                    best_seconds[n] = t
                            fastest_first = sorted(best_seconds, key=lambda n: (best_seconds[n], str(n).casefold(), str(n)))

                            if use_meet_wide_pool:

                                if mkey not in meet_states:

                                    meet_states[mkey] = {'pool': {}, 'relays': 0}

                                pool = meet_states[mkey]['pool']

                                admitted = set()
                                for n in fastest_first:
                                    if _can_add_to_pool(pool, n, ev_nm, cfg):
                                        _add_to_pool(pool, n, ev_nm, cfg)
                                        admitted.add(n)

                            elif max_individuals_cfg < 999:

                                room = max(0, max_individuals_cfg - team_indiv_counts[team_name])
                                admitted = set(fastest_first[:room])
                                team_indiv_counts[team_name] += len(admitted)

                            else:

                                admitted = set(fastest_first)

                            for athlete in members:

                                athlete['calculated_points'] = (
                                    avg_pts
                                    if athlete.get('name') in admitted and not _prelim_dive_blocked(athlete)
                                    else 0.0
                                )

                            continue

                        if use_meet_wide_pool:

                            if mkey not in meet_states:

                                meet_states[mkey] = {'pool': {}, 'relays': 0}

                            pool = meet_states[mkey]['pool']

                            can_all = all(_can_add_to_pool(pool, n, ev_nm, cfg) for n in unique_names)

                            for athlete in members:

                                athlete['calculated_points'] = (
                                    avg_pts if can_all and not _prelim_dive_blocked(athlete) else 0.0
                                )

                            if can_all:

                                for n in unique_names:

                                    if not any(
                                        _prelim_dive_blocked(a) for a in members if a.get('name') == n
                                    ):

                                        _add_to_pool(pool, n, ev_nm, cfg)

                        else:

                            cap = max_individuals_cfg

                            for athlete in members:

                                if _prelim_dive_blocked(athlete):

                                    athlete['calculated_points'] = 0.0

                                elif cap < 999 and team_indiv_counts[team_name] >= cap:

                                    athlete['calculated_points'] = 0.0

                                else:

                                    athlete['calculated_points'] = avg_pts

                                    if cap < 999:

                                        team_indiv_counts[team_name] += 1



                    # Not `group`: its ineligible rows were emitted above.
                    scored_athletes.extend(eligible)

                for a, source_rank in source_ranks:
                    a['rank'] = source_rank




    if process_events_chronologically:
        for (event, gender), ev_athletes in event_list:
            indiv = [a for a in ev_athletes if not a.get('is_relay')]
            relays = [a for a in ev_athletes if a.get('is_relay')]
            if indiv:
                _process_scoring_event(indiv, gender)
            if relays:
                if relay_pool_rule:
                    _seed_ab_relay_legs_into_pool(relays, cfg, meet_states, gender)
                _process_scoring_event(relays, gender)
    else:
        for (event, gender), ev_athletes in event_list:
            _process_scoring_event(ev_athletes, gender)

    return scored_athletes


def _apply_pdf_points_overrides(athletes):
    """When HyTek PDF includes a Points column, use those values instead of calculated."""
    for a in athletes:
        val = parse_pdf_points(a.get('pdf_points'))
        if val is None:
            continue
        a['calculated_points'] = val


if __name__ == "__main__":

    input_data = sys.stdin.read()

    if input_data:

        try:

            athletes = json.loads(input_data)

            # Optional argv[1]: the meet's last scored event number, read from
            # "Team Rankings - Through Event N". Without it every event scores.
            cutoff_overrides = None
            if len(sys.argv) > 1:
                cutoff_overrides = {'scoredEventNumberMax': int(sys.argv[1])}

            scored = calculate_points(athletes, overrides=cutoff_overrides)

            print(json.dumps(scored))

        except Exception as e:

            print(json.dumps({
                "error": str(e),
                "code": getattr(e, 'code', None),
                "rows": getattr(e, 'rows', None),
            }))

