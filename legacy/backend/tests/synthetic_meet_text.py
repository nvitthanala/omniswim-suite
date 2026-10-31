"""SYNTHETIC meet text for the parser tests. Nothing here is a real result.

Every swimmer name is a placeholder ("Alice Synthetic"), and every time is a
round number chosen so the expected splits can be read off by eye. The school
names are only strings the team matcher already knows; no real meet, athlete
or published time is reproduced. The lines mimic the shape pdfplumber hands
`pdf_parser.parse_pdf` for a HyTek relay page.
"""

SYNTHETIC_RELAY_TEXT = "\n".join([
    # 4x50 relay, one split line: the "short" builder.
    "Event 5 Women 4x50 Yard Freestyle Relay",
    "A - Final",
    "Henderson State University A NT 1:40.00 1",
    "1) Alice Synthetic SR 2) Bea Synthetic JR 3) Cara Synthetic SO 4) Dana Synthetic FR",
    "r:0.60 25.00 (25.00) r:0.30 50.00 (25.00) r:0.30 1:15.00 (25.00) r:0.30 1:40.00 (25.00)",
    # 4x100 relay, two split lines: the "4x100" builder.
    "Event 6 Men 4x100 Yard Freestyle Relay",
    "A - Final",
    "Delta State University A NT 3:20.00 1",
    "1) Eli Synthetic SR 2) Finn Synthetic JR 3) Gus Synthetic SO 4) Hal Synthetic FR",
    "25.00 50.00 (50.00) 1:15.00 1:40.00 (50.00)",
    "2:05.00 2:30.00 (50.00) 2:55.00 3:20.00 (50.00)",
    # A relay whose PDF printed swimmers but no split lines at all.
    "Event 7 Men 4x50 Yard Medley Relay",
    "A - Final",
    "Ouachita Baptist University A NT 1:50.00 1",
    "1) Ian Synthetic SR 2) Jon Synthetic JR 3) Kai Synthetic SO 4) Leo Synthetic FR",
])
