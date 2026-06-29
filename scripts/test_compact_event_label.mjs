/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  compactEventTitleAttr,
  formatCompactEventLabel,
  formatEventChartAxisLabel,
  stripEventGenderMarker,
} from '../packages/core/src/lib/utils.ts';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL: ${label}\n  expected: ${expected}\n  got:      ${actual}`);
    process.exit(1);
  }
}

assertEq(
  formatCompactEventLabel('Event 6 Men 200 Yard Individual Medley'),
  'E6 200IM',
  '200 IM'
);
assertEq(
  formatCompactEventLabel('Event 1 Men 100 Yard Freestyle'),
  'E1 100FR',
  '100 free'
);
assertEq(
  formatCompactEventLabel('Event 5 Men 200 Yard Freestyle Relay'),
  'E5 200FR-R',
  '200 free relay'
);
assertEq(
  formatCompactEventLabel('Event 10 Men 200 Yard Medley Relay'),
  'E10 200MD-R',
  '200 medley relay'
);
assertEq(
  formatCompactEventLabel('Event 20 Men 1650 Yard Freestyle'),
  'E20 1650FR',
  '1650 free'
);
assertEq(
  formatCompactEventLabel('Event 3 Women 100 Yard Butterfly'),
  'E3 100FL',
  '100 fly'
);
assertEq(
  formatCompactEventLabel('Event 4 Women 100 Yard Backstroke'),
  'E4 100BK',
  '100 back'
);
assertEq(
  formatCompactEventLabel('Event 7 Women 200 Yard Breaststroke'),
  'E7 200BR',
  '200 breast'
);

// No event number (catalog / plan events)
assertEq(formatCompactEventLabel('100 Yard Freestyle'), '100FR', 'no event prefix');
assertEq(formatCompactEventLabel('200 Individual Medley'), '200IM', 'IM without yards');

// Gender stripped in compact label
assertEq(
  formatCompactEventLabel('Event 2 Boys 50 Meter Freestyle'),
  'E2 50FR',
  'boys meter course'
);

// Title attr keeps stripped full name
const full = compactEventTitleAttr('Event 6 Men 200 Yard Individual Medley');
assertEq(full, 'Event 6 200 Yard Individual Medley', 'title attr strips gender');
assertEq(
  stripEventGenderMarker('Event 6 Men 200 Yard Individual Medley'),
  full,
  'stripEventGenderMarker consistent'
);

// Chart axis delegates to compact + maxLength
assertEq(
  formatEventChartAxisLabel('Event 6 Men 200 Yard Individual Medley'),
  'E6 200IM',
  'chart axis compact'
);
assertEq(
  formatEventChartAxisLabel('Event 6 Men 200 Yard Individual Medley', { maxLength: 5 }),
  'E6 20',
  'chart axis maxLength'
);
assertEq(
  formatEventChartAxisLabel('Event 6 Men 200 Yard Individual Medley', { abbreviate: false }),
  'Event 6 200 Yard Individual Medley',
  'chart axis no abbrev'
);

console.log('OK compact event label tests');
