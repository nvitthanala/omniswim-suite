import sys
import json
import os
import re
import pdfplumber
import difflib

def is_time(s):
    """Check if string is a swimming time or diving score."""
    s = s.strip().rstrip('.')
    cleaned = re.sub(r'[#\*&$%^!@~\'\+\-qQjJ]', '', s).strip()
    if re.match(r'^\d*:?\d{1,2}\.\d{2}[a-zA-Z\s]*$', cleaned, re.IGNORECASE):
        return True
    # Diving totals (e.g. 400.80) — no colon, often 3+ digits before decimal
    if re.match(r'^\d{2,4}\.\d{2}$', cleaned):
        return True
    return False

def clean_time_str(s):
    """Extract clean time value, handling X prefix for exhibition"""
    s = s.strip()
    is_exh = False
    if s.upper().startswith('X'):
        is_exh = True
        s = s[1:].strip()
    # Strip trailing non-numeric chars like #, *, etc.
    s = re.sub(r'[#\*&$%^!@~\'\+\-qQjJ]', '', s).strip()
    return s, is_exh

YEAR_TOKENS = {'FR', 'SO', 'JR', 'SR', '5Y', 'FY', 'GS', 'GR'}
YEAR_PATTERN = r'\b(FR|SO|JR|SR|5Y|FY|GS|GR)\b'

QUALIFIER_CODES = r'(NP|NT|DQ|DFS|SCR|NS|NC\b|PROV|D2\s*[AB]|IV25|25D2)'

# Tokens after times that are not place points (SEC / HyTek qualifiers on the points column)
_POINTS_SKIP_TOKENS = frozenset({
    'NC', 'PROV', 'NT', 'DQ', 'DFS', 'SCR', 'NS', 'NP', 'A', 'B', 'S', 'R', 'P', 'M',
})

# Map known abbreviations to full team names (NSISC + GLVC; see packages/core/src/data/teamAbbreviations.json)
_ALIASES_JSON = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', 'packages', 'core', 'src', 'data', 'teamAbbreviations.json')
)


def _load_abbrev_teams():
    # Fails loudly on purpose: a missing or unreadable teamAbbreviations.json
    # means every team code below silently degrades to the tiny hardcoded
    # fallback, misattributing points for every school not in that short
    # list. A broken deploy should not start up able to score meets wrong.
    merged = {}
    with open(_ALIASES_JSON, encoding='utf-8') as fh:
        merged.update(json.load(fh))
    merged.setdefault('UMSL', 'University of Missouri-St. Louis')
    merged.setdefault('HSU', 'Henderson State University')
    merged.setdefault('DSU', 'Delta State University')
    merged.setdefault('OUAC', 'Ouachita Baptist University')
    merged.setdefault('UWF', 'University of West Florida')
    return merged


ABBREV_TEAMS = _load_abbrev_teams()

def is_data_line_text(stripped, is_relay_event=False):
    """Check if line is likely an athlete data line (not header, not split times)"""
    upper = stripped.upper()
    # Skip page headers, metadata
    skip_flags = ['RECORD:', 'MEET:', 'CONF:', 'POOL:', 'NCAA', 'HY-TEK',
                  'PAGE', 'CHAMPION:', 'USOP', 'AMER', 'SEED TIME',
                  'CONSIDERATION', 'AUTOMATIC QUAL', 'EARLY TAKE-OFF',
                  '-- OF --', 'TEAM RANKINGS',
                  'WOMEN - TEAM SCORES', 'MEN - TEAM SCORES']
    for flag in skip_flags:
        if flag in upper:
            return False
    
    # Skip column header lines
    if 'YR' in stripped and 'SCHOOL' in upper:
        return False
    if 'YR' in stripped and 'NAME' in upper:
        return False
    if 'NAME' in stripped and 'SCHOOL' in upper:
        return False
    if 'TEAM RELAY' in upper and ('SEED' in upper or 'POINTS' in upper):
        return False
    if 'FINALS TIME' in upper and 'SEED TIME' in upper:
        return False
    if 'PRELIM TIME' in upper and 'FINALS TIME' in upper:
        return False
    if 'FINALS SCORE' in upper:
        return False
    if 'PRELIM SCORE' in upper:
        return False
    
    # Relay lines may not have year tokens; let them through in relay context
    if is_relay_event:
        if re.match(r'^\d+\s', stripped) or stripped.startswith('B ') or stripped.startswith('---'):
            return True
        if re.search(r'\d:\d+\.\d{2}|\d+\.\d{2}', stripped) and not stripped.upper().startswith('EVENT'):
            return True
    
    # Skip split time lines (lines that start with a time or contain parentheses with times)
    # Split lines look like: "26.77 55.40 (55.40)" or "1:59.85 (29.12) 1:30.73 (35.03)"
    if re.match(r'^[\d\.:]+\s', stripped) and '(' in stripped:
        return False
    # Skip pure split lines (all tokens are times)
    tokens = stripped.split()
    time_count = sum(1 for t in tokens if is_time(t))
    if time_count >= 3 and not any(y in stripped for y in YEAR_TOKENS):
        return False
    
    # Skip lines that are pure number+time patterns (split lines)
    if re.match(r'^[\d\.:\(\)\s]+\Z', stripped) and not re.search(r'[A-Za-z]', stripped):
        return False
    
    # Skip stray detail lines
    if stripped.startswith('r:') or stripped.startswith('r +'):
        return False
    if re.match(r'^\s*\d+\)\s+', stripped):
        return False
    
    # Lines with year tokens are data lines
    if re.search(YEAR_PATTERN, stripped):
        return True
    
    # Lines with a rank/number followed by text are potential data lines
    if re.match(r'^\d+\s+[A-Z]', stripped):
        return True
    
    return False

def is_exhib_or_split_line(stripped):
    """Check if a line is an exhibition swimmer or a field that should be marked exhibition"""
    return stripped.startswith('---') or stripped.startswith('X')

def normalize_name(name):
    """Normalize name: Last,First -> First Last"""
    name = name.strip().strip(',')
    if ', ' in name:
        parts = name.split(', ')
        name = f"{parts[1]} {parts[0]}"
    return name

def match_abbrev_team(candidate):
    """Try to match GLVC-style abbreviated team names"""
    upper = candidate.upper()
    for abbr, full in ABBREV_TEAMS.items():
        if upper.endswith(abbr) or upper == abbr:
            return full
        if abbr in upper.split():
            return full
    return None

def is_results_points_header(stripped):
    """HyTek results table with an explicit Points column (e.g. SEC)."""
    upper = stripped.upper()
    if 'TEAM RANKINGS' in upper or 'TEAM SCORES' in upper:
        return False
    if 'POINTS' not in upper:
        return False
    if re.search(r'\bTEAM\s+RELAY\b', upper):
        return True
    if 'NAME' in upper and ('YR' in upper or 'SCHOOL' in upper):
        return True
    return False


def extract_pdf_points_from_tokens(tokens):
    """Pop trailing place-point integer(s) from the end of a token list."""
    if not tokens:
        return None
    work = list(tokens)
    pts = None
    while work:
        raw = work[-1].strip()
        u = re.sub(r'[#\*&$%^!@~\']', '', raw).upper()
        if not u:
            work.pop()
            continue
        if u in _POINTS_SKIP_TOKENS:
            work.pop()
            continue
        if re.match(r'^D2\s*[AB]$', u) or re.match(r'^IV\d+', u) or re.match(r'^25D2$', u):
            work.pop()
            continue
        if re.match(r'^\d{1,3}$', u):
            val = int(u)
            if 0 <= val <= 128:
                pts = float(val)
                work.pop()
                continue
        break
    return pts


def detect_meet_type(full_text):
    """Detect the format type based on text patterns"""
    lines = full_text.split('\n')
    # Look at data lines to determine format
    sample_data_lines = []
    for line in lines:
        s = line.strip()
        if not s or len(s) < 20:
            continue
        # Look for a line with a year token
        if re.search(YEAR_PATTERN, s):
            sample_data_lines.append(s)
            if len(sample_data_lines) >= 10:
                break
    
    # Count patterns
    comma_name_count = 0
    no_comma_count = 0
    for line in sample_data_lines:
        if ',' in line and re.search(r'[A-Z][a-z]+,\s+[A-Z]', line):
            comma_name_count += 1
        else:
            no_comma_count += 1
    
    if comma_name_count > no_comma_count:
        return 'ACC'  # Names are "Last, First"
    return 'NSISC'  # Names are "First Last"

def parse_meet_data(lines, conference="NSISC"):
    """Parse generic meet format: Rank Name YR School PrelimTime FinalsTime QualCodes"""
    athletes = {}
    current_event = None
    current_gender = None
    current_round = "Finals"
    current_event_is_time_trial = False
    is_timed_final_event = False
    meet_has_pdf_points = False
    
    for line_idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        
        upper = stripped.upper()
        
        # ===== Event Headers =====
        event_match = re.match(r'^Event\s+(\d+)\s+(Men|Women|Boys?|Girls?|Mixed|Coed|Men\'s|Women\'s)[\'sS]?\s+(.*)', stripped, re.IGNORECASE)
        if event_match:
            event_num = int(event_match.group(1))
            gender_label = event_match.group(2).strip()
            gender_str = gender_label.lower()
            current_gender = "Women" if any(x in gender_str for x in ["women", "girl"]) else "Men"
            event_name = event_match.group(3).strip()
            # Preserve Boys/Girls in the event title (post-meet championship swims); bucket athletes by Men/Women.
            current_event = f"Event {event_num} {gender_label} {event_name}"
            current_event_is_time_trial = 'TIME TRIAL' in event_name.upper()
            current_round = "Time Trial" if current_event_is_time_trial else "Finals"
            
            # Detect timed-final events (distance events)
            is_timed_final_event = bool(re.search(r'\b(1000|1650|1500|10000|800)\b', event_name)) or 'TIMED' in event_name.upper()
            if is_timed_final_event:
                current_round = "Finals"  # Timed finals are scored as finals
            continue
        
        if not current_event:
            continue
        
        # ===== Round Headers =====
        if upper.startswith('PRELIMINARIES') or upper == 'PRELIMS':
            current_round = "Preliminaries"
            continue
        if 'A - FINAL' in upper or upper.startswith('A FINAL') or 'CHAMPIONSHIP FINAL' in upper:
            current_round = "A Final"
            continue
        if 'B - FINAL' in upper or upper.startswith('B FINAL') or 'CONSOLATION FINAL' in upper:
            current_round = "B Final"
            continue
        if 'C - FINAL' in upper or upper.startswith('C FINAL') or 'BONUS FINAL' in upper:
            current_round = "C Final"
            continue
        if 'D - FINAL' in upper or upper.startswith('D FINAL'):
            current_round = "D Final"
            continue

        if is_results_points_header(stripped):
            meet_has_pdf_points = True
            continue
        
        is_relay = "relay" in current_event.lower() or "free relay" in current_event.lower() or "medley relay" in current_event.lower()
        
        if is_relay:
            # For relays, use relay-aware filter
            if not is_data_line_text(stripped, is_relay_event=True):
                continue
            _parse_nsisc_relay(
                stripped, lines, line_idx, current_event, current_gender, current_round,
                current_event_is_time_trial, athletes, conference, meet_has_pdf_points,
            )
            continue
        
        # ===== INDIVIDUAL Athlete Lines =====
        # Skip non-data lines for individual events
        if not is_data_line_text(stripped):
            continue
        
        # Skip split time lines (lines starting with times and lots of time tokens)
        tokens = stripped.split()
        time_tokens = [t for t in tokens if is_time(t) or re.match(r'^\d+:\d+\.\d+', t) or re.match(r'^\d+\.\d+', t)]
        if len(time_tokens) >= 4 and not re.search(YEAR_PATTERN, stripped):
            continue  # Pure split line
        
        is_exhibition = False
        
        # Check if line starts with '---' (exhibition)
        if stripped.startswith('---'):
            is_exhibition = True
            rest_line = stripped[3:].strip()
        else:
            rest_line = stripped
        
        # Find year token. A missing one is not automatically noise: HyTek omits
        # the class year for an athlete who has none on file, and dropping the
        # line loses a real result. Recover off the school, and raise when a row
        # that plainly is a result cannot be recovered rather than losing it
        # silently — a short meet reads as a scoring defect, not a parse defect.
        yr_match = re.search(YEAR_PATTERN, rest_line)
        if yr_match:
            yr = yr_match.group(1).upper()
            before_yr = rest_line[:yr_match.start()].strip()
            after_yr = rest_line[yr_match.end():].strip()
        else:
            recovered = _split_yearless_individual_line(rest_line)
            if recovered is None:
                if _looks_like_relay_entry_row(rest_line):
                    # A relay entry row reached the individual branch. The event
                    # in hand is an individual event, so this relay's own header
                    # is not the one being tracked — the source PDF prints two
                    # result columns and pdfplumber interleaves them. Filing the
                    # row under `current_event` would put a relay under a diving
                    # event. Say it was dropped; never guess its event.
                    print(
                        f'WARNING: relay entry row {stripped!r} arrived under '
                        f'{current_event!r}, which is not a relay event. The '
                        'source PDF prints two columns and the extraction '
                        'interleaved them, so this row has no event to be filed '
                        'under and is dropped.',
                        file=sys.stderr,
                    )
                    continue
                if _looks_like_lost_result_row(rest_line):
                    raise ValueError(
                        'unparseable individual result row in '
                        f'{current_event!r} ({current_round}): no class year and '
                        f'no known school to split on: {stripped!r}'
                    )
                continue
            yr, before_yr, after_yr = recovered
        
        rank = None
        name = None
        school = None
        prelims_time = None
        finals_time = None
        
        has_rank = re.match(r'^(\d+|\*?\d+)\s+', before_yr)
        has_comma_before = ',' in before_yr
        has_comma_after = ',' in after_yr
        
        # If before_yr has a comma, it must contain "Last, First", meaning format is "Rank Name YR School"
        # If it doesn't have a comma, we fall back to rank detection or timed final logic
        if has_comma_before or has_rank or not is_timed_final_event:
            # === HEAT EVENT FORMAT: Rank Name YR School ... ===
            rank_match = re.match(r'^(\d+|\*?\d+)\s+(.*)', before_yr)
            if rank_match:
                rank_str = rank_match.group(1).strip().lstrip('*')
                if rank_str.isdigit():
                    rank = rank_str
                name_raw = rank_match.group(2).strip()
            else:
                name_raw = before_yr
            
            # Extract optional HyTek name markers (*, #, %, x)
            marker_match = re.match(r'^([\*xX#%])\s*(.*)', name_raw)
            if marker_match:
                marker = marker_match.group(1).upper()
                if marker == 'X':
                    is_exhibition = True
                name_raw = marker_match.group(2).strip()
            
            name = normalize_name(name_raw)
            if not name:
                continue
            
            # After year: School Name ... Times ...
            all_tokens = after_yr.split()
            
            school_words = []
            time_part_tokens = []
            in_times = False
            for t in all_tokens:
                if in_times:
                    time_part_tokens.append(t)
                else:
                    t_clean = t.lstrip('Xx*#')
                    if is_time(t_clean) or t_clean.upper() in ['NT', 'DQ', 'DFS', 'SCR', 'NS', 'NP'] or t_clean.startswith('---'):
                        in_times = True
                        time_part_tokens.append(t)
                    elif t in YEAR_TOKENS:
                        school_words.append(t)
                    elif re.match(r'^\d{1,3}$', t) and int(t) <= 40:
                        school_words.append(t)
                    else:
                        school_words.append(t)
            
            school_raw = ' '.join(school_words).strip()
            
        else:
            # === TIMED-FINAL FORMAT: School YR Name ... Times ... ===
            school_raw = before_yr
            all_tokens = after_yr.split()
            
            name_words = []
            time_part_tokens = []
            in_times = False
            for t in all_tokens:
                if in_times:
                    time_part_tokens.append(t)
                else:
                    t_clean = t.lstrip('Xx*#')
                    if is_time(t_clean) or t_clean.upper() in ['NT', 'DQ', 'DFS', 'SCR', 'NS', 'NP']:
                        in_times = True
                        time_part_tokens.append(t)
                    else:
                        name_words.append(t)
            
            name_raw = ' '.join(name_words)
            marker_match = re.match(r'^([\*xX#%])\s*(.*)', name_raw)
            if marker_match:
                marker = marker_match.group(1).upper()
                if marker == 'X':
                    is_exhibition = True
                name_raw = marker_match.group(2).strip()

            name = normalize_name(name_raw)
            if not name:
                continue
        
        # Match school
        school = match_abbrev_team(school_raw)
        if not school:
            school = _fuzzy_match_team(school_raw)
        if not school:
            continue
        
        pdf_points = None
        if meet_has_pdf_points:
            pdf_points = extract_pdf_points_from_tokens(time_part_tokens)

        # Parse times from time_part_tokens (after points tail stripped)
        time_values = []
        for t in time_part_tokens:
            t_stripped = t.strip()
            # Handle X prefix
            if t_stripped.upper().startswith('X'):
                is_exhibition = True
                t_stripped = t_stripped[1:].strip()
            # Strip qualifier codes attached to times
            t_stripped = re.sub(r'[#\*&$%^!@~\']', '', t_stripped)
            if is_time(t_stripped):
                time_values.append(t_stripped)
            elif t_stripped.upper() in ['NT', 'DQ', 'DFS', 'SCR', 'NS']:
                time_values.append(t_stripped.upper())
        
        if not time_values:
            continue
        
        if is_timed_final_event:
            # Timed final: [SeedTime, FinalsTime] or just [FinalsTime]
            if len(time_values) >= 2:
                finals_time = time_values[-1]  # Last is finals time
            elif len(time_values) == 1:
                finals_time = time_values[0]
        elif current_round == "Preliminaries":
            # Prelims only
            prelims_time = time_values[-1] if time_values else None
        else:
            # Finals (A/B/C): could have [PrelimTime, FinalsTime] or just [FinalsTime]
            if len(time_values) >= 2:
                prelims_time = time_values[0]
                finals_time = time_values[-1]
            elif len(time_values) == 1:
                finals_time = time_values[0]
        
        key = (name, current_event, current_gender)
        if key not in athletes:
            athletes[key] = {
                "name": name, "event": current_event, "gender": current_gender,
                "team": school, "year": yr, "is_relay": False,
                "prelims_time": prelims_time, "finals_time": finals_time,
                "round_swam": current_round, "is_exhibition": is_exhibition,
                "is_time_trial": current_event_is_time_trial,
                "rank": rank,
                "conference": conference,
                "pdf_points": pdf_points,
            }
        else:
            ath = athletes[key]
            if prelims_time and not ath.get("prelims_time"):
                ath["prelims_time"] = prelims_time
            if finals_time:
                ath["finals_time"] = finals_time
            if is_exhibition:
                ath["is_exhibition"] = True
            if rank and not ath.get("rank"):
                ath["rank"] = rank
            if current_round != "Preliminaries":
                ath["round_swam"] = current_round
            if pdf_points is not None:
                ath["pdf_points"] = pdf_points
    
    return athletes


def _extract_relay_leg_splits_from_line(stripped):
    """HyTek relay split line: cumulative clock with leg times in parentheses, e.g. '54.20 (54.20) 1:58.50 (1:04.30)'."""
    return re.findall(r'\(([\d:\.]+\d)\)', stripped)


def _relay_time_to_seconds(time_str):
    if not time_str or time_str in ('NT', 'DQ', 'SCR'):
        return None
    try:
        parts = str(time_str).split(':')
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    except (ValueError, TypeError):
        return None
    return None


def _parse_relay_distance_yards(event_name):
    ev = (event_name or '').lower()
    m = re.search(r'4\s*[x×]\s*(\d+)', ev)
    if m:
        return int(m.group(1)) * 4
    m = re.search(r'\b(\d{3,4})\b', ev)
    if m:
        return int(m.group(1))
    if re.search(r'\b200\b', ev):
        return 200
    if re.search(r'\b400\b', ev):
        return 400
    return 200


def _parse_relay_split_column(cell):
    cell = (cell or '').strip()
    if not cell:
        return {'outer': None, 'inner': None, 'has_parens': False}
    inner_m = re.search(r'\(([\d:\.]+\d)\)', cell)
    inner = inner_m.group(1) if inner_m else None
    outer_m = re.search(r'([\d:\.]+\d)', cell.split('(')[0] if '(' in cell else cell)
    outer = outer_m.group(1) if outer_m else None
    has_parens = '(' in cell
    return {'outer': outer, 'inner': inner, 'has_parens': has_parens}


def _parse_relay_split_line_cells(stripped):
    """Parse split cells on one relay line in pdf text order (left-to-right)."""
    stripped = re.sub(r'^r:[^\s]+\s*', '', (stripped or '').strip())
    if not stripped:
        return []
    if '\t' in stripped:
        raw_cols = [c.strip() for c in stripped.split('\t') if c.strip()]
    else:
        raw_cols = re.findall(r'[\d:\.]+\d(?:\s*\([\d:\.]+\d\))?', stripped)
    return [_parse_relay_split_column(c) for c in raw_cols]


def _split_relay_line_columns(stripped):
    """Legacy column helper — pads to four cells for older callers."""
    cols = _parse_relay_split_line_cells(stripped)[:4]
    while len(cols) < 4:
        cols.append({'outer': None, 'inner': None})
    return cols[:4]


def _collect_relay_split_lines(lines, start_idx, max_lines=4):
    split_lines = []
    j = start_idx
    end = min(len(lines), start_idx + 16)
    while j < end and len(split_lines) < max_lines:
        nxt = lines[j].strip()
        j += 1
        if not nxt:
            continue
        if nxt.startswith('r:') or re.match(r'^[\d:\.]+\s', nxt):
            if '(' in nxt or nxt.startswith('r:'):
                split_lines.append(nxt)
                continue
        if split_lines:
            break
        break
    return split_lines


def _relay_split_cells_race_order(cells):
    """Order 4x200 marks by increasing team cumulative (outer) clock."""
    def sort_key(cell):
        sec = _relay_time_to_seconds(cell.get('outer'))
        return sec if sec is not None else float('inf')

    return sorted(cells, key=sort_key)


def _swimmer_cumulative_seconds(cell):
    """
    Swimmer cumulative within the leg at each 50 yd mark.
    The race's first 50 is bare (no parens) — use outer only for that mark.
    All other marks use the parenthesized swimmer cumulative.
    """
    if cell.get('has_parens'):
        return _relay_time_to_seconds(cell.get('inner'))
    return _relay_time_to_seconds(cell.get('outer'))


def _build_leg_segments_from_row_cells(cells_race_order):
    """
    One 4x200 split line = one leg (row 1 = leadoff, row 2 = second swimmer, …).
    Outer = team cumulative; bare first 50 or inner (parens) = swimmer cumulative.
    Each 50 split is the delta between successive swimmer cumulatives.
    """
    if not cells_race_order:
        return [], None

    cumulatives = []
    team_cums = []
    for cell in cells_race_order:
        sec = _swimmer_cumulative_seconds(cell)
        if sec is None:
            continue
        cumulatives.append(sec)
        team_cums.append(cell.get('outer') or cell.get('inner'))

    if not cumulatives:
        return [], None

    leg_total = _format_seconds_to_relay_time(cumulatives[-1])
    segments = []
    prev = 0.0
    for i, cum in enumerate(cumulatives):
        lap = cum - prev
        if lap <= 0:
            continue
        prev = cum
        segments.append({
            'yards': 50,
            'segment_time': _format_seconds_to_relay_time(lap),
            'cumulative_leg': team_cums[i] if i < len(team_cums) else leg_total,
        })
    return segments, leg_total


def _build_4x100_split_payload(event_name, relay_names, split_lines, team_time):
    """
    NSISC 4x100: two split lines, four cells each.
    Line 1 = legs 1–2 (two cells per leg); line 2 = legs 3–4.
    Within each leg pair, order by team cumulative and diff swimmer cumulatives.
    """
    n_legs = len(relay_names) or 4
    leg_dist = 100
    rows = [_parse_relay_split_line_cells(ln) for ln in split_lines[:2]]
    leg_pairs = [(0, 0), (0, 2), (1, 0), (1, 2)]

    leg_details = []
    leg_totals = []
    for leg_idx, (row_idx, col_start) in enumerate(leg_pairs):
        stroke = _relay_leg_stroke_for_event(event_name, leg_idx)
        pair = rows[row_idx][col_start:col_start + 2] if row_idx < len(rows) else []
        segments, leg_total = _build_leg_segments_from_row_cells(
            _relay_split_cells_race_order(pair)
        )
        leg_totals.append(leg_total)
        leg_details.append({
            'leg_index': leg_idx,
            'stroke': stroke,
            'leg_distance_yards': leg_dist,
            'segments': segments,
            'leg_total': leg_total,
        })

    team_total = team_time
    if not team_total and rows:
        last_row = rows[-1]
        for cell in reversed(last_row):
            outer = cell.get('outer')
            if outer and (_relay_time_to_seconds(outer) or 0) >= 120:
                team_total = outer
                break

    first_half = None
    second_half = None
    if len(leg_totals) >= 4 and all(leg_totals[:4]):
        secs = [_relay_time_to_seconds(t) for t in leg_totals[:4]]
        if None not in secs:
            first_half = _format_seconds_to_relay_time(secs[0] + secs[1])
            second_half = _format_seconds_to_relay_time(secs[2] + secs[3])

    return {
        'leg_details': leg_details,
        'team_splits': {
            'leg_totals': leg_totals,
            'first_half': first_half,
            'second_half': second_half,
            'team_total': team_total,
        },
        'legacy_leg_splits': leg_totals,
    }


def _pick_leg_total(leg_index, leg_dist, parsed_rows):
    """Leg total from row-per-leg layout (split line = one swimmer)."""
    if leg_index < len(parsed_rows):
        cells = _relay_split_cells_race_order(parsed_rows[leg_index])
        _, leg_total = _build_leg_segments_from_row_cells(cells)
        if leg_total:
            return leg_total
    return None


def _build_short_relay_split_payload(event_name, relay_names, split_line, team_time):
    n_legs = len(relay_names) or 4
    leg_dist = _parse_relay_distance_yards(event_name) // 4
    raw_line = split_line or ''
    cells = _parse_relay_split_line_cells(raw_line)
    team_total = team_time or None
    if not team_total and cells:
        team_total = cells[-1].get('outer') or cells[-1].get('inner')

    leg_times = [None] * n_legs
    if 'r:' in raw_line:
        parens = re.findall(r'\(([\d:\.]+\d)\)', raw_line)
        if len(parens) >= n_legs:
            for i in range(n_legs):
                leg_times[i] = parens[i]
        elif len(parens) >= 2:
            for i in range(min(n_legs - 1, len(parens) - 1)):
                leg_times[i] = parens[i]
            leg_times[n_legs - 1] = parens[-1]
        elif len(parens) == 1:
            leg_times[0] = parens[0]
    elif len(cells) >= n_legs:
        for i in range(n_legs):
            leg_times[i] = cells[i].get('inner') or cells[i].get('outer')

    leg_details = []
    leg_totals = []
    for i in range(n_legs):
        stroke = _relay_leg_stroke_for_event(event_name, i)
        seg_time = leg_times[i]
        cell = cells[i] if i < len(cells) else {'outer': None, 'inner': None}
        segments = []
        if seg_time:
            segments.append({
                'yards': leg_dist,
                'segment_time': seg_time,
                'cumulative_leg': cell.get('outer') or seg_time,
            })
        leg_total = seg_time
        leg_totals.append(leg_total)
        leg_details.append({
            'leg_index': i,
            'stroke': stroke,
            'leg_distance_yards': leg_dist,
            'segments': segments,
            'leg_total': leg_total,
        })

    first_half = None
    second_half = None
    if len(leg_totals) >= 4 and all(leg_totals[:4]):
        s0 = _relay_time_to_seconds(leg_totals[0])
        s1 = _relay_time_to_seconds(leg_totals[1])
        s2 = _relay_time_to_seconds(leg_totals[2])
        s3 = _relay_time_to_seconds(leg_totals[3])
        if None not in (s0, s1, s2, s3):
            first_half = _format_seconds_to_relay_time(s0 + s1)
            second_half = _format_seconds_to_relay_time(s2 + s3)

    return {
        'leg_details': leg_details,
        'team_splits': {
            'leg_totals': leg_totals,
            'first_half': first_half,
            'second_half': second_half,
            'team_total': team_total,
        },
        'legacy_leg_splits': leg_totals,
    }


def _format_seconds_to_relay_time(seconds):
    if seconds is None:
        return None
    if seconds >= 60:
        mins = int(seconds // 60)
        secs = seconds - mins * 60
        return f'{mins}:{secs:05.2f}'
    return f'{seconds:.2f}'


def _infer_segment_yards(time_str, leg_dist):
    sec = _relay_time_to_seconds(time_str)
    if not sec:
        return leg_dist
    if sec >= leg_dist * 0.4:
        return leg_dist
    if sec >= 40:
        return min(100, leg_dist)
    if sec >= 18:
        return 50
    return 25


def _segment_plausible(yards, time_str, leg_dist):
    sec = _relay_time_to_seconds(time_str)
    if not sec:
        return False
    if yards >= leg_dist:
        return sec >= leg_dist * 0.25
    if yards >= 100:
        return 35 <= sec <= 95
    if yards >= 50:
        return 18 <= sec <= 55
    if yards >= 25:
        return 8 <= sec <= 30
    return True


def _build_distance_relay_split_payload(event_name, relay_names, split_lines, team_time):
    n_legs = len(relay_names) or 4
    leg_dist = _parse_relay_distance_yards(event_name) // 4
    parsed_rows = [_parse_relay_split_line_cells(ln) for ln in split_lines[:n_legs]]

    leg_details = []
    leg_totals = []
    for i in range(n_legs):
        stroke = _relay_leg_stroke_for_event(event_name, i)
        cells_race_order = (
            _relay_split_cells_race_order(parsed_rows[i])
            if i < len(parsed_rows) else []
        )
        segments, leg_total = _build_leg_segments_from_row_cells(cells_race_order)
        leg_totals.append(leg_total)
        leg_details.append({
            'leg_index': i,
            'stroke': stroke,
            'leg_distance_yards': leg_dist,
            'segments': segments,
            'leg_total': leg_total,
        })

    last_row = parsed_rows[-1] if parsed_rows else []
    team_cums = [c.get('outer') for c in reversed(last_row) if c.get('outer')]
    first_half = None
    second_half = None
    if len(leg_totals) >= 4 and all(leg_totals[:4]):
        secs = [_relay_time_to_seconds(t) for t in leg_totals[:4]]
        if None not in secs:
            first_half = _format_seconds_to_relay_time(secs[0] + secs[1])
            second_half = _format_seconds_to_relay_time(secs[2] + secs[3])

    return {
        'leg_details': leg_details,
        'team_splits': {
            'leg_totals': leg_totals,
            'first_half': first_half,
            'second_half': second_half,
            'team_total': team_time or (team_cums[0] if team_cums else None),
        },
        'legacy_leg_splits': leg_totals,
    }


def _build_relay_split_payload(event_name, relay_names, split_lines, team_time):
    if not split_lines:
        return None
    relay_dist = _parse_relay_distance_yards(event_name)
    leg_dist = relay_dist // 4
    try:
        if leg_dist == 100 and len(split_lines) == 2:
            return _build_4x100_split_payload(event_name, relay_names, split_lines, team_time)
        if len(split_lines) >= 2 and relay_dist >= 400:
            return _build_distance_relay_split_payload(event_name, relay_names, split_lines, team_time)
        if len(split_lines) >= 4:
            return _build_distance_relay_split_payload(event_name, relay_names, split_lines, team_time)
        return _build_short_relay_split_payload(event_name, relay_names, split_lines[0], team_time)
    except (IndexError, ValueError, TypeError):
        legacy = _extract_relay_leg_splits_from_line(split_lines[0])
        return {
            'leg_details': [],
            'team_splits': {
                'leg_totals': legacy + [None] * max(0, (len(relay_names) or 4) - len(legacy)),
                'team_total': team_time,
            },
            'legacy_leg_splits': legacy,
        }


def _relay_leg_stroke_for_event(event_name, leg_index):
    """Medley order: back, breast, fly, free. Freestyle relays: every leg is free."""
    ev = (event_name or '').lower()
    if 'medley' in ev and leg_index < 4:
        return ('back', 'breast', 'fly', 'free')[leg_index]
    return 'free'


# A leg marker opens the segment: "1)", "2)" ... It follows the line start, a
# space, or a letter — pdfplumber runs the marker onto the previous class year
# often enough ("... Tanish SR4) r:0.18 Nunez, Javier FR") that requiring
# whitespace loses the leg. A digit, "(" or "." before it means the ")" closes a
# split time such as "(20.63)", not a leg.
_RELAY_LEG_MARKER = re.compile(r'(?<![(\d.:\-])(\d+)\)')
# HyTek prints a reaction time before the name on every leg but the first.
_RELAY_LEG_REACTION = re.compile(r'^r:[\+\-]?\d*\.\d+\s+')
_RELAY_LEG_NAME_YEAR = re.compile(
    r'^([A-Za-z\-\',\.\s\*#xX%]+?)\s+(FR|SO|JR|SR|5Y|FY|GS|GR)\b'
)
# Yearless leg: take the leading run of name characters and stop where the name
# plainly ends — the end of the segment, a clock, a bracketed split, or the next
# reaction time. GLVC prints "1) Briley Larcom 2) r:0.35 Kayden Cooper r:+0.77
# 27.57 58.53", so a leg's own splits can share the segment with its swimmer.
_RELAY_LEG_NAME_ONLY = re.compile(r'^([A-Za-z][A-Za-z\-\',\.\s\*#xX%]*?)\s*(?=$|[\d(]|r:)')


def _looks_like_lost_relay_leg(segment):
    """True when a leg segment plainly carries a swimmer name yet did not parse."""
    return sum(
        1 for t in segment.split() if re.match(r"^[A-Za-z][A-Za-z\-\'\.,]*$", t)
    ) >= 2


def _parse_relay_leg_line(nxt):
    """
    Read "1) Name YR 2) Name YR 3) Name YR 4) Name YR" into one entry per leg.

    The class year is optional. This line had the same defect as the individual
    result row: the old regex required a trailing year token, so a swimmer with
    no class year on file was not merely missing a year, he was missing from the
    relay. In `2026_NSISC_Championships_Final_Results.pdf` that dropped
    Alessandro Giustolisi (Delta State) from three relays; in the 2026 ACC
    results it dropped Claire Curzan from four.

    A dropped leg also shifts the legs after it. `_build_relay_split_payload`
    pairs `relay_names[i]` with split i, so a three-name list against four splits
    credits leg 4's swim to leg 3's swimmer.

    Each leg runs from its marker to the next marker, or to the end of the line.
    That boundary — not the year token — separates one leg from the next. When no
    year is printed the year is UNKNOWN. It is never guessed: a class year is
    competition data that drives senior-removal projections.

    Returns [] for a line that carries no legs, so the caller keeps its "not a
    swimmer line" branch.

    A leg that still cannot be read on a line whose other legs parsed raises.
    An earlier revision printed a warning to stderr and returned the shorter
    relay. That is the silent-gap-filling this parser exists to refuse: stderr
    is invisible to a coach reading the app, so a relay short one swimmer looks
    exactly like a complete, correctly-parsed relay. The segments that reach
    this branch are pdfplumber column bleed, e.g. the 2026 Big 12 line
    "3) r:0.37 *Sheikhalizadehkhangh, M4a) rry:0am.17 J RWozniak, Julia SR".
    Neither answer is available: the name cannot be read, and guessing it from
    the wreckage would invent competition data. So the parse stops and says so,
    the same as the yearless individual row above. Refuse rather than silently
    short a meet.
    """
    markers = list(_RELAY_LEG_MARKER.finditer(nxt))
    if not markers:
        return []

    legs = []
    lost = []
    for idx, marker in enumerate(markers):
        end = markers[idx + 1].start() if idx + 1 < len(markers) else len(nxt)
        segment = _RELAY_LEG_REACTION.sub('', nxt[marker.end():end].lstrip(), count=1)

        year_match = _RELAY_LEG_NAME_YEAR.match(segment)
        if year_match:
            name_raw, year = year_match.group(1), year_match.group(2).upper()
        else:
            name_match = _RELAY_LEG_NAME_ONLY.match(segment)
            # Two words minimum: HyTek prints "First Last" or "Last, First", and
            # a lone token is stray furniture rather than a swimmer.
            #
            # The name must also end where a word ends. A run that stops inside
            # one is a mangled name, not a shorter name: the GLVC ligature
            # "Kadence Grif(cid:976)in SR" would otherwise enter the roster as
            # "Kadence Grif", which reads as a real swimmer and is not one.
            # Report the leg lost instead of inventing a name for it.
            if (
                not name_match
                or len(name_match.group(1).split()) < 2
                or segment[name_match.end(1):name_match.end(1) + 1].strip()
            ):
                if _looks_like_lost_relay_leg(segment):
                    lost.append(segment.strip())
                continue
            name_raw, year = name_match.group(1), 'UNKNOWN'

        name = normalize_name(re.sub(r'^[\*xX#%]\s*', '', name_raw.strip()))
        if name:
            legs.append({"name": name, "year": year})

    if legs and lost:
        raise ValueError(
            f'unreadable relay leg on swimmer line {nxt!r}: {lost!r}. The other '
            'legs on this line parsed, so this relay would be short a swimmer. '
            'The name cannot be read and will not be guessed.'
        )
    return legs


def _parse_nsisc_relay(
    stripped,
    lines,
    line_idx,
    current_event,
    current_gender,
    current_round,
    current_event_is_time_trial,
    athletes,
    conference="NSISC",
    meet_has_pdf_points=False,
):
    """Parse NSISC relay line"""
    # Example: "University of West Florida 7:25.38 D2 B	7:29.39	1"
    # In pdfplumber text: "University of West Florida 7:25.38 D2 B 7:29.39 1"
    # B Final: "B Delta State University 7:35.90 NT 9"
    
    is_exhibition = False
    rest = stripped
    
    # Check for B-final relay marker or exhibition marker at the start
    if rest.startswith('B ') or rest.startswith('B\t'):
        rest = rest[2:].strip()
    if rest.startswith('---'):
        is_exhibition = True
        rest = rest[3:].strip()

    # Extract optional leading rank/lane number
    rank = None
    leading_rank_match = re.match(r'^(\d+)\s+(.*)$', rest)
    if leading_rank_match:
        rank = leading_rank_match.group(1)
        rest = leading_rank_match.group(2).strip()
    
    # Find all time-like tokens
    time_positions = [(m.start(), m.end()) for m in re.finditer(r'\d*:?\d{1,2}\.\d{2}', rest)]
    if not time_positions:
        return
    
    first_time_pos = time_positions[0][0]
    school_raw = rest[:first_time_pos].strip()
    
    # Clean trailing qualifier codes like A/B, NT, SCR, DQ, etc from school name
    school_raw = re.sub(r'\s+(?:A|B|NT|SCR|DQ|NS|DFS|NP)(?:\s+(?:A|B|NT|SCR|DQ|NS|DFS|NP))*\s*$', '', school_raw, flags=re.IGNORECASE).strip()
    
    school = match_abbrev_team(school_raw)
    if not school:
        school = _fuzzy_match_team(school_raw)
    if not school:
        return
    
    times = [rest[s:e] for s, e in time_positions]
    finals_time = times[-1] if len(times) >= 2 else (times[0] if times else None)
    
    after_times = rest[time_positions[-1][1]:].strip()
    pdf_team_points = None
    if meet_has_pdf_points:
        tail_tokens = after_times.split()
        pdf_team_points = extract_pdf_points_from_tokens(tail_tokens)
        after_times = ' '.join(tail_tokens).strip()

    # Try to extract rank from the end; fall back to leading lane/rank if needed
    rank_match = re.search(r'(\d+)\s*$', after_times)
    if rank_match:
        rank = rank_match.group(1)
    
    # Relay swimmers + split lines (leg times in parentheses).
    relay_names = []
    relay_leg_splits = []
    relay_split_payload = None
    j = line_idx + 1
    end_scan = min(len(lines), line_idx + 12)
    split_lines = []
    while j < end_scan:
        nxt = lines[j].strip()
        j += 1
        if not nxt:
            continue
        # Swimmer line: "1) Shannah Dillman SR 2) Tori Johnston SR ..."
        # Optional reaction times (r:0.12, r:+0.55) and optional class years.
        swimmers = _parse_relay_leg_line(nxt)
        if swimmers:
            relay_names.extend(swimmers)
            continue
        if nxt.startswith('r:') or (re.match(r'^[\d:\.]+\s', nxt) and '(' in nxt):
            split_lines = _collect_relay_split_lines(lines, j - 1)
            break
        if nxt.startswith('DQ') or nxt.upper().startswith('EARLY TAKE-OFF'):
            continue
        break

    if split_lines:
        try:
            relay_split_payload = _build_relay_split_payload(
                current_event, relay_names, split_lines, finals_time
            )
        except Exception:
            relay_split_payload = None
            relay_leg_splits = _extract_relay_leg_splits_from_line(split_lines[0])
        if relay_split_payload:
            relay_leg_splits = relay_split_payload.get('legacy_leg_splits') or []

    if relay_names:
        key = (school, current_event, current_gender, current_round, finals_time, rank)
        if key not in athletes:
            leg_pdf_pts = None
            if pdf_team_points is not None and len(relay_names) > 0:
                leg_pdf_pts = pdf_team_points / len(relay_names)
            athletes[key] = {
                "name": school, "event": current_event, "gender": current_gender,
                "team": school, "year": "UNKNOWN", "is_relay": True,
                "prelims_time": None, "finals_time": finals_time,
                "round_swam": current_round, "is_exhibition": is_exhibition,
                "is_time_trial": current_event_is_time_trial,
                "rank": rank,
                "relay_names": relay_names,
                "relay_leg_splits": relay_leg_splits,
                "relay_split_payload": relay_split_payload,
                "conference": conference,
                "pdf_team_points": pdf_team_points,
                "pdf_points": leg_pdf_pts,
            }


_team_cache = None

# School-ish phrases (HyTek school column); avoids caching "First Last" name fragments.
_INSTITUTION_HINT = re.compile(
    r'(?i)\b(university|college|colleges|institute|seminary|baptist|methodist|lutheran|'
    r'catholic|christian|technological|polytechnic|academy|'
    r'\bstate\b|\bstates\b|st\.|\'\s*s\b|a&m|a & m|'
    r'\btech\b|\btech\.|national|international)\b'
)


def _looks_like_institution(text):
    if not text or len(text.strip()) < 3:
        return False
    if _INSTITUTION_HINT.search(text):
        return True
    for w in text.split():
        if match_abbrev_team(w):
            return True
    return False


def _two_title_case_words_only(text):
    """e.g. 'Lamar Taylor' — typical swimmer name, not a school."""
    t = text.strip()
    return bool(re.match(r'^[A-Z][a-z]+\s+[A-Z][a-z]+$', t))


def _school_guess_after_year(after_yr):
    """Tokens after class year until first time / scratch code (matches individual parse)."""
    if not after_yr:
        return ''
    school_words = []
    for t in after_yr.split():
        t_clean = t.lstrip('Xx*#')
        if is_time(t_clean) or t_clean.upper() in ['NT', 'DQ', 'DFS', 'SCR', 'NS', 'NP'] or t_clean.startswith('---'):
            break
        if t in YEAR_TOKENS:
            school_words.append(t)
        elif re.match(r'^\d{1,3}$', t) and int(t) <= 40:
            school_words.append(t)
        else:
            school_words.append(t)
    return ' '.join(school_words).strip()


# A HyTek team code as the school column prints it: "SBU", "DRUR", "MS&T".
# All caps in the source, which is what separates a code from a swimmer's name.
_TEAM_CODE_TOKEN = re.compile(r'^[A-Z][A-Z0-9&\.\-]{1,9}$')
# HyTek labels a school's entries A, B, C, D in entry order.
_RELAY_SQUAD_LETTER = re.compile(r'^[A-D]$')
# A title-case word that can be part of a printed swimmer name.
_NAME_WORD = re.compile(r"^[A-Z][a-z][A-Za-z\-\'\.]*$")
# A bare place number. "4." (the team score table) is deliberately excluded.
_PLACE_NUMBER = re.compile(r'^\d{1,3}$')


def _resolve_team_code(token):
    """
    Expand one HyTek team code through the archived abbreviation table,
    `packages/core/src/data/teamAbbreviations.json`.

    Strict where `match_abbrev_team` is loose. That one accepts a code as a
    suffix of any word, so a swimmer named Baker can resolve as a school. Here
    the whole token must BE the code, and the code must already be in the table:
    an unrecorded code returns None and the caller refuses the row, which is how
    a new conference's abbreviation gets added with a source instead of guessed.
    """
    t = (token or '').strip()
    if not _TEAM_CODE_TOKEN.match(t):
        return None
    return ABBREV_TEAMS.get(t.upper())


def _is_school_column_boundary(token):
    """The school column ends at the first clock or scratch code."""
    t = (token or '').lstrip('Xx*#')
    return is_time(t) or t.upper() in ('NT', 'DQ', 'DFS', 'SCR', 'NS', 'NP')


def _looks_like_relay_entry_row(rest_line):
    """
    True for a relay entry row: "<place> <TEAM> <A|B|C|D> <clock>", e.g.
    "16 UMSL B 6:53.13".

    These are not individual results and must never be parsed as one. They reach
    the individual branch only through column bleed: the source PDF prints two
    result columns, pdfplumber reads them into one line stream, and a relay row
    can land while an individual event header is the one in hand.

    `_looks_like_lost_result_row` used to call them lost results, because its
    two-name-word test counted the team code and the squad letter as names. In
    `glvc_results26.pdf` that made eleven relay rows raise, and the first one
    aborted the whole meet.
    """
    tokens = rest_line.strip().split()
    if len(tokens) < 4:
        return False
    if not re.match(r'^\*?\d+$', tokens[0]):
        return False
    if not _RELAY_SQUAD_LETTER.match(tokens[2]):
        return False
    if not is_time(tokens[3].lstrip('Xx*#')):
        return False
    return _resolve_team_code(tokens[1]) is not None


def _looks_like_lost_result_row(rest_line):
    """
    True when a line carries the unmistakable shape of an individual result row
    — a leading place, at least one clock, and a name — yet could not be parsed.

    Deliberately narrow. Page furniture ("2026 New South Intercollegiate
    Swimming Conference") leads with a number too, but carries no time token, so
    it never reaches the raise. A relay entry row is excluded outright: it is a
    real row, but it is not an individual result and forcing it through this
    branch would file a relay squad as a swimmer.
    """
    if _looks_like_relay_entry_row(rest_line):
        return False
    if not re.match(r'^(\*?\d+)\s+[A-Za-z]', rest_line.strip()):
        return False
    tokens = rest_line.split()
    if not any(is_time(t.lstrip('Xx*#')) for t in tokens):
        return False
    return sum(1 for t in tokens if re.match(r'^[A-Za-z][A-Za-z\-\'\.]*$', t)) >= 2


def _split_yearless_individual_line(rest_line):
    """
    Split "<place> <Name> <School> <times...>" when HyTek printed no class year.

    The standard layout is "<place> <Name> <YR> <School> <times...>" and the
    whole downstream parse pivots on the year token. A roster entry with no
    class year on file prints without one, and every row for that athlete was
    silently dropped — in the 2026 NSISC results, all 11 rows for Alessandro
    Giustolisi (Delta State), including four scoring finishes worth 21 points.

    Recovery pivots on the school instead. Returns
    (year, before_school, school_and_times) shaped exactly like the year-token
    split so the caller is unchanged, with the year reported as UNKNOWN. The
    class year is never guessed: it is competition data that drives
    senior-removal projections, and this PDF does not carry one.

    Two pivots, in order:

    1. The team cache built out of this same PDF, which holds the school names
       the PDF spells out in full.
    2. A HyTek team code — the school column prints an abbreviation. GLVC does
       this throughout: "52 Drew E Baker SBU 2:00.60". The cache cannot hold
       SBU, because it harvests school names from rows that carry a class year
       and Southwest Baptist prints none, so every SBU row was unrecoverable and
       the first one aborted the meet.

    The code is expanded through `ABBREV_TEAMS`, the same archived table
    `match_abbrev_team` already uses to resolve the school on every year-bearing
    row in this PDF. No second table, and no code is invented here: an
    unrecorded code returns None and the caller raises.
    """
    hit = _split_yearless_on_cached_team(rest_line)
    if hit is None:
        hit = _split_yearless_on_team_code(rest_line)
    return hit


def _split_yearless_on_cached_team(rest_line):
    """Pivot on a school name the PDF spells out in full."""
    if not _team_cache:
        return None
    for team in _team_cache:  # longest first, so the fullest school name wins
        idx = rest_line.find(team)
        if idx <= 0:
            continue
        before = rest_line[:idx].strip()
        after = rest_line[idx:].strip()
        if not before or not after:
            continue
        if not _is_recoverable_name(before):
            continue
        return 'UNKNOWN', before, _trim_recovered_tail(after)
    return None


def _split_yearless_on_team_code(rest_line):
    """Pivot on an abbreviated school column, e.g. the SBU in "52 Drew E Baker SBU 2:00.60"."""
    tokens = rest_line.split()
    for i in range(1, len(tokens) - 1):  # never token 0, which is the place
        if _resolve_team_code(tokens[i]) is None:
            continue
        # The school column sits directly before the clock. Requiring that keeps
        # a code out of the middle of a name and off the qualifying-standard
        # tail ("... 20.31 B"), where a bare letter is a cut tag, not a school.
        if not _is_school_column_boundary(tokens[i + 1]):
            continue
        before = ' '.join(tokens[:i])
        if not _is_recoverable_name(before):
            continue
        return 'UNKNOWN', before, _trim_recovered_tail(' '.join(tokens[i:]))
    return None


def _is_recoverable_name(before):
    """
    True when what precedes the school is a place and a real athlete name.

    Guards the team score table ("1 University of West Florida University of
    West Florida 1,239"), where nothing but the place precedes the school.

    The comma is not optional in practice: HyTek prints "Last, First" in every
    conference PDF archived here bar NSISC. Without it the ACC's
    "4 Clark, Kayleigh Florida State University 296.85 300.15 26" is not
    recovered, and the caller raises on it — one yearless diver aborting the
    whole meet.
    """
    name_part = re.sub(r'^(\*?\d+)\s+', '', before.strip()).strip()
    if len(name_part.split()) < 2:
        return False
    return bool(re.match(r"^[A-Za-z][A-Za-z\-\',\.\s]*$", name_part))


def _trim_recovered_tail(after):
    """
    Cut a recovered row where the next result column starts on the same line.

    pdfplumber reads this PDF's two result columns into one line often enough
    that a recovered row would otherwise take the next column's clock as its
    own finals time. "41 Eliana Barone SBU 1:18.26 18 Marco Flores MS&T 55.88"
    is one line holding two swims, and Barone's 100 breaststroke would come out
    55.88 — Marco Flores's time, in another event.

    A HyTek result tail carries clocks, qualifying tags and a points column. It
    never prints "<place> <Name>", so that pair is where the next column begins.
    The row keeps its own clock and the rest is dropped: the second swim has no
    event header of its own here, and inventing one would file a real time
    against the wrong race.
    """
    tokens = after.split()
    for i in range(1, len(tokens) - 1):
        if _PLACE_NUMBER.match(tokens[i]) and _NAME_WORD.match(tokens[i + 1]):
            return ' '.join(tokens[:i])
    return after  # unchanged: keep the original spacing byte for byte


def _build_team_cache(lines):
    """Build a comprehensive team name list from the PDF text"""
    global _team_cache
    if _team_cache is not None:
        return _team_cache
    
    team_candidates = set()
    
    # Add known abbreviations
    for v in ABBREV_TEAMS.values():
        team_candidates.add(v)
    
    for line in lines:
        stripped = line.strip()
        if not stripped or len(stripped) < 8:
            continue
        if not is_data_line_text(stripped):
            continue
        
        # Strip exhibition markers and rank digits for accurate team caching
        stripped_clean = re.sub(r'^---\s*', '', stripped)
        stripped_clean = re.sub(r'^\d+\)\s*', '', stripped_clean)
        stripped_clean = re.sub(r'^(\d+|\*?\d+)\s+', '', stripped_clean)
        
        yr_match = re.search(YEAR_PATTERN, stripped_clean)
        if not yr_match:
            continue
        
        before_yr = stripped_clean[:yr_match.start()].strip()
        after_yr = stripped_clean[yr_match.end():].strip()
        
        # Standard HyTek: school is after class year (before times). Never use name-side prefixes.
        school_after = _school_guess_after_year(after_yr)
        if len(school_after) > 2 and not is_time(school_after):
            team_candidates.add(school_after)
            # Progressive prefixes help fuzzy match truncated PDF tokens
            sw = school_after.split()
            for i in range(1, len(sw)):
                frag = ' '.join(sw[:i])
                if len(frag) > 3:
                    team_candidates.add(frag)
        
        # Timed-final / alternate layouts: full school name may appear before the year
        if _looks_like_institution(before_yr):
            team_candidates.add(before_yr.strip())
            bw = before_yr.split()
            for i in range(1, len(bw)):
                frag = ' '.join(bw[:i])
                if len(frag) > 3 and _looks_like_institution(frag):
                    team_candidates.add(frag)
    
    # Normalize
    canon_map = {}
    def norm_key(s):
        return re.sub(r'[^a-z0-9]', '', s.lower())
    
    for t in team_candidates:
        if not t: continue
        nk = norm_key(t)
        if nk not in canon_map or len(t) > len(canon_map[nk]):
            canon_map[nk] = t
    
    _team_cache = sorted(list(canon_map.values()), key=len, reverse=True)
    return _team_cache


def _fuzzy_match_team(candidate):
    """Match a candidate team name against known teams"""
    if not candidate or len(candidate) < 2:
        return None
    
    # First check abbreviation
    full = match_abbrev_team(candidate)
    if full:
        return full
    
    candidate_clean = re.sub(r'\s+', ' ', candidate).strip()
    
    # Check known abbreviations at word level
    words = candidate_clean.split()
    for w in words:
        f = match_abbrev_team(w)
        if f:
            return f
    
    # Dynamic matching from cache
    if _team_cache is None:
        return None
    
    # Exact match
    for t in _team_cache:
        if candidate_clean.lower() == t.lower():
            return t
    
    # Prefix/suffix
    for t in _team_cache:
        if candidate_clean.lower().startswith(t.lower()) or t.lower().startswith(candidate_clean.lower()):
            return t
    
    # Substring
    for t in _team_cache:
        if candidate_clean.lower() in t.lower() or t.lower() in candidate_clean.lower():
            return t
    
    # Fuzzy — reject cache entries that are just "First Last" person names (poisoned rows)
    matches = difflib.get_close_matches(candidate_clean, _team_cache, n=1, cutoff=0.6)
    if matches:
        hit = matches[0]
        if _two_title_case_words_only(hit) and not _looks_like_institution(hit):
            matches_hi = difflib.get_close_matches(candidate_clean, _team_cache, n=1, cutoff=0.88)
            return matches_hi[0] if matches_hi else None
        return hit
    
    return None


def extract_page_text(args):
    path, i, format_type = args
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        page = pdf.pages[i]
        if format_type == 'divided':
            width = page.width
            height = page.height
            left_bbox = (0, 0, width / 2, height)
            right_bbox = (width / 2, 0, width, height)
            
            left_text = page.within_bbox(left_bbox).extract_text() or ""
            right_text = page.within_bbox(right_bbox).extract_text() or ""
            return left_text + "\n" + right_text
        return page.extract_text() or ""

def parse_pdf(file_path, format_type='auto'):
    from concurrent.futures import ProcessPoolExecutor
    
    with pdfplumber.open(file_path) as pdf:
        num_pages = len(pdf.pages)
    
    page_texts = []
    with ProcessPoolExecutor() as executor:
        results = executor.map(extract_page_text, [(file_path, i, format_type) for i in range(num_pages)])
        page_texts = list(results)
        
    full_text = "\n".join([pt for pt in page_texts if pt])
    lines = full_text.split('\n')
    
    # Build team cache first (reset so consecutive parses in one process do not reuse stale names)
    global _team_cache
    _team_cache = None
    _build_team_cache(lines)
    
    # Detect conference/format
    conference = None
    if 'NSISC' in full_text.upper():
        conference = 'NSISC'
    elif re.search(r'\bACC\b', full_text.upper()) or 'ATLANTIC COAST' in full_text.upper():
        conference = 'ACC'
    elif re.search(r'\bSEC\b', full_text.upper()) or 'SOUTHEASTERN CONFERENCE' in full_text.upper():
        conference = 'SEC'
    elif 'BIG 12' in full_text.upper() or 'BIG12' in full_text.upper():
        conference = 'Big 12'
    
    meet_type = detect_meet_type(full_text)
    
    # Parse based on format
    athletes = parse_meet_data(lines, conference=conference or "NSISC")
    
    # Build results
    results = []
    for key, data in athletes.items():
        if data["is_relay"] and data.get("relay_names"):
            relay_names = data["relay_names"]
            splits = data.get("relay_leg_splits") or []
            team_time = data["finals_time"]
            payload = data.get("relay_split_payload") or {}
            leg_details = payload.get("leg_details") or []
            team_splits = payload.get("team_splits")
            for idx, r in enumerate(relay_names):
                detail = leg_details[idx] if idx < len(leg_details) else None
                leg_split = None
                if detail and detail.get("leg_total"):
                    leg_split = detail["leg_total"]
                elif idx < len(splits):
                    leg_split = splits[idx]
                leg_pts = data.get("pdf_points")
                results.append({
                    "name": r["name"], "event": data["event"], "gender": data["gender"],
                    "team": data["team"], "year": r["year"], "is_relay": True,
                    "prelims_time": data["prelims_time"], "finals_time": data["finals_time"],
                    "round_swam": data["round_swam"], "is_exhibition": data["is_exhibition"],
                    "is_time_trial": data.get("is_time_trial", False),
                    "rank": data.get("rank"),
                    "conference": data.get("conference"),
                    "relay_names": relay_names,
                    "relay_leg_index": idx,
                    "relay_leg_stroke": _relay_leg_stroke_for_event(data["event"], idx),
                    "relay_leg_split": leg_split,
                    "relay_leg_split_detail": detail,
                    "relay_team_splits": team_splits,
                    "relay_team_time": team_time,
                    "pdf_points": leg_pts,
                })
        else:
            results.append({
                "name": data["name"], "event": data["event"], "gender": data["gender"],
                "team": data["team"], "year": data["year"], "is_relay": False,
                "prelims_time": data["prelims_time"], "finals_time": data["finals_time"],
                "round_swam": data["round_swam"], "is_exhibition": data["is_exhibition"],
                "is_time_trial": data.get("is_time_trial", False),
                "rank": data.get("rank"),
                "conference": data.get("conference"),
                "pdf_points": data.get("pdf_points"),
            })
    
    return results

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)
    format_type = sys.argv[2] if len(sys.argv) > 2 else 'auto'
    print(json.dumps(parse_pdf(sys.argv[1], format_type)))
