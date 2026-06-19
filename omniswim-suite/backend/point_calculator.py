import sys

import json

import math

import re

from collections import defaultdict



DEFAULT_NCAA_D2_SCORING = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1]


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
        pp = a.get('pdf_points')
        if pp is None or pp == '':
            return False
        try:
            val = float(pp)
        except (TypeError, ValueError):
            return False
        return math.isfinite(val)

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


def _pdf_place_points_for_row(a):
    if a.get('is_exhibition'):
        return 0.0
    ev_nm = str(a.get('event', '') or '')
    if a.get('is_time_trial') and not is_championship_gender_event(ev_nm):
        return 0.0
    pp = a.get('pdf_points')
    if pp is None or pp == '':
        return 0.0
    try:
        val = float(pp)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(val) or val < 0:
        return 0.0
    return val


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


def _resolve_scoring_settings(scoring_settings=None):

    import os

    from pathlib import Path



    cfg = {}

    if not scoring_settings:

        try:

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

        except Exception:

            pass

    else:

        cfg = dict(scoring_settings)



    cfg.setdefault('scoringPoints', DEFAULT_NCAA_D2_SCORING)

    cfg.setdefault('relayMultiplier', 2)

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

    cfg.setdefault('exhibitionMarkers', ['x', 'X'])

    cfg.setdefault('timeTrialMarkers', ['TIME TRIAL', 'TT'])

    npts = len(cfg['scoringPoints'])

    cfg.setdefault('aFinalBracketSize', max(1, npts // 2))

    return _merge_roster_mode(cfg)





def classify_round_tier(round_swam):

    r = (round_swam or '').upper()

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





def is_unscored_round_or_event(round_swam, event_name, cfg):

    r = (round_swam or '').upper()

    e = (event_name or '').upper()

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

    if not t or t == 'NT':

        return 9999.99

    val = re.sub(r'[^\d\.:]', '', str(t)).rstrip('.')

    if not val:

        return 9999.99

    if ':' in val:

        parts = val.split(':')

        try:

            minutes = float(parts[0])

            seconds = float(parts[1]) if len(parts) > 1 else 0.0

            return minutes * 60 + seconds

        except ValueError:

            return 9999.99

    try:

        return float(val)

    except ValueError:

        return 9999.99





def get_ev_sort_key(a):

    t_final = a.get('finals_time') or a.get('prelims_time')

    t = time_to_sec(t_final) if t_final else 9999.99

    is_exh = a.get('is_exhibition', False)

    is_tt = a.get('is_time_trial', False)

    if is_exh or is_tt:

        return (99999, 99999, t)

    rnum = parse_rank_int(a)

    if rnum is None:

        rnum = 9999

    return (round_tier_sort_order(a.get('round_swam')), rnum, t)





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

    if tier not in tiers:

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

    if rules.get('includeRelayLegsInFinals', True) and tier in tiers:

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





def calculate_points(athletes, scoring_settings=None):

    cfg = _resolve_scoring_settings(scoring_settings)

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
        _apply_pdf_place_scoring_lock(cfg)
        for ath in athletes:
            ath['calculated_points'] = _pdf_place_points_for_row(ath)
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

                ind_by_key = defaultdict(list)

                for a in ev_athletes:

                    rk = parse_rank_int(a)

                    if rk is None or rk < 1:

                        key = (a.get('round_swam') or '', -1, id(a))

                    else:

                        key = (a.get('round_swam') or '', rk)

                    ind_by_key[key].append(a)



                sorted_groups = sorted(ind_by_key.values(), key=lambda grp: get_ev_sort_key(grp[0]))

                team_indiv_counts = defaultdict(int)



                for group in sorted_groups:

                    ineligible = [a for a in group if not is_scoring_athlete(a)]

                    eligible = [a for a in group if is_scoring_athlete(a)]

                    for athlete in ineligible:

                        athlete['calculated_points'] = 0.0

                    scored_athletes.extend(ineligible)

                    if not eligible:

                        continue

                    team_athlete = eligible[0]

                    is_exhibition = team_athlete.get('is_exhibition', False)

                    is_time_trial = team_athlete.get('is_time_trial', False)

                    ev_nm = str(team_athlete.get('event', '') or '')

                    rs = str(team_athlete.get('round_swam', '') or '')

                    rk = parse_rank_int(team_athlete)

                    grp_len = len(eligible)

                    is_prelim_diving = (
                        classify_round_tier(rs) == 'PRE' and is_diving_event(ev_nm, cfg)
                    )



                    if (
                        is_exhibition
                        or (is_time_trial and not is_championship_gender_event(ev_nm))
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

                            roster_ok = all(roster_is_scorer(n, team_name, gender) for n in unique_names)

                            for athlete in members:

                                athlete['calculated_points'] = (
                                    avg_pts if roster_ok and not _prelim_dive_blocked(athlete) else 0.0
                                )

                            if roster_ok and use_meet_wide_pool:

                                if mkey not in meet_states:

                                    meet_states[mkey] = {'pool': {}, 'relays': 0}

                                pool = meet_states[mkey]['pool']

                                for n in unique_names:

                                    if not any(
                                        _prelim_dive_blocked(a) for a in members if a.get('name') == n
                                    ):

                                        _add_to_pool(pool, n, ev_nm, cfg)

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



                    scored_athletes.extend(group)




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
        pp = a.get('pdf_points')
        if pp is None or pp == '':
            continue
        try:
            val = float(pp)
        except (TypeError, ValueError):
            continue
        if val < 0:
            continue
        a['calculated_points'] = val


if __name__ == "__main__":

    input_data = sys.stdin.read()

    if input_data:

        try:

            athletes = json.loads(input_data)

            scored = calculate_points(athletes)

            print(json.dumps(scored))

        except Exception as e:

            print(json.dumps({"error": str(e)}))


