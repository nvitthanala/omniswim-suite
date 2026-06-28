import { getTeamColors } from '../packages/core/src/lib/utils.ts';

const cases = [
  ['NC State University', '#CC0000'],
  ['North Carolina State University', '#CC0000'],
  ['University of North Carolina at Chapel Hill', '#7BAFD4'],
  ['University of North Carolina', '#7BAFD4'],
  ['UNC', '#7BAFD4'],
  ['Michigan State University', '#18453B'],
  ['University of Michigan', '#00274C'],
  ['Ohio State University', '#CE0F3D'],
  ['Ohio University', '#00694E'],
  ['Indiana University', '#990000'],
  ['Indiana University of Pennsylvania', '#8C2131'],
  ['Florida State University', '#782F40'],
  ['University of Florida', '#0021A5'],
  ['Georgia Institute of Technology', '#B3A369'],
  ['University of Georgia', '#BA0C2F'],
  ['Virginia Tech', '#630031'],
  ['University of Virginia', '#E57200'],
  ['Penn State University', '#041E42'],
  ['University of Pennsylvania', '#990000'],
  ['University of Southern California', '#990000'],
  ['UCLA', '#2D68C4'],
];

let failed = 0;
for (const [name, expected] of cases) {
  const { primary } = getTeamColors(name);
  const ok = primary.toUpperCase() === expected.toUpperCase();
  if (!ok) {
    failed++;
    console.error(`FAIL: ${name} => ${primary} (expected ${expected})`);
  } else {
    console.log(`OK: ${name} => ${primary}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log(`All ${cases.length} team color lookups passed.`);
