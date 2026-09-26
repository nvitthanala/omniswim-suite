/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "Athletes / Individual swims / Relay leg rows / Relay events / Vacant
 * legs" stat tiles atop IndRelayManagementView — split out of the view's own
 * function body.
 */
type Stats = {
  athletes: number;
  individual: number;
  relayLegs: number;
  relayEvents: number;
  vacantLegs: number;
};

export default function RelayStatsCards({ stats }: { stats: Stats }) {
  const items = [
    { label: 'Athletes', value: stats.athletes },
    { label: 'Individual swims', value: stats.individual },
    { label: 'Relay leg rows', value: stats.relayLegs },
    { label: 'Relay events', value: stats.relayEvents },
    { label: 'Vacant legs', value: stats.vacantLegs },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
      {items.map(item => (
        <div key={item.label} className="surface-overlay border border-theme-soft rounded-lg px-3 py-2">
          <p className="text-ui-micro text-theme-secondary uppercase tracking-widest">{item.label}</p>
          <p className="text-lg font-semibold text-[var(--text-primary)] tabular-nums">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
