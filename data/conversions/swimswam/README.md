# SwimSwam LCM to SCY converter captures

`lcm-to-scy-2026-10-26.json` holds 53 outputs of the SwimSwam Swimming Time
Conversion Tool (`https://swimswam.com/swimming-times-conversion-tool/`),
long course meters (LCM) to short course yards (SCY). The page says it uses
Colorado Timing's conversion factors. It publishes no factors, and no
published Colorado Timing table was found on 2026-10-26.

The user approved this method on 2026-10-26 (state file
`docs/reference/REDESIGN_2026-10-25_STATE.json`, `userAnswers`,
`Q-D2-swimswam`). Table D from the handwritten plan is not used for any
event: the user called it incorrect.

## What was captured

Each of the 17 events was converted at three LCM inputs: 1:00.00, 3:00.00
and 10:00.00. The 800 free relay was converted at 1:00.00 and 10:00.00.
Each capture records the request fields, the output, the response hash and
the time.

## What the outputs fit

Every one of the 51 individual-event outputs equals
`truncate((LCM - turn) / divisor)` to the hundredth of a second.

| Events | Divisor | Turn (seconds) |
| --- | --- | --- |
| 50, 100, 200 Free | 1.11 | 0.8, 1.6, 3.2 |
| 50, 100, 200 Fly | 1.11 | 0.7, 1.4, 2.8 |
| 50, 100, 200 Breast | 1.11 | 1.0, 2.0, 4.0 |
| 50, 100, 200 Back | 1.09361 | 2.5, 5.0, 10.0 |
| 200 IM | 1.11 | 3.2 |
| 400 IM | 1.11 | 6.4 |
| 400 to 500 Free, 800 to 1000 Free | 0.8925 | 0 |
| 1500 to 1650 Free | 1.02 | 0 |

These divisors and turns are **inferred**, not published. They are the
round values that reproduce every captured output. The backstroke divisor
is the least certain: any value from 1.0936095 to 1.0936130 reproduces all
nine backstroke outputs.

## Rules for using these values

- Provenance kind is tool-derived. Name the converter, the inputs and the
  outputs. Never label these values `published`.
- SwimCloud's own converted time comes first (README R10). These values
  apply only when SwimCloud shows no conversion.
- Give each converted time to the hundredth (README R59). Truncate, as the
  converter does: the result then equals SwimSwam's own output, and a test
  can replay every capture exactly. R59 permits rounding but does not
  require it.
- A converted time shows the "est." badge. It may earn an "estimated cut
  achieved" tag. When the swimmer swims the cut, the normal tag replaces it
  (README R61).
- Convert individual swims and relay splits (README R60). The converter does
  not convert the 800 free relay (it returns the input unchanged), and the
  full-relay conversion is not needed.
- To check the archive, rerun a capture's request fields against the
  converter and compare the output. The response hash will differ, because
  the page carries ads and per-request markup.
