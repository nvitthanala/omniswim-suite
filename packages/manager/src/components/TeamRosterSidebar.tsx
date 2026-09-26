/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Left-hand "Teams (N)" picker column for TeamRosterPanel's sidebar layout.
 */
type Props = {
  teams: string[];
  memberCounts: Map<string, number>;
  projectedByTeam: Map<string, number>;
  officialLookup: Map<string, number | undefined>;
  selectedTeam: string;
  expanded: boolean;
  onSelectTeam: (team: string) => void;
};

export default function TeamRosterSidebar({
  teams,
  memberCounts,
  projectedByTeam,
  officialLookup,
  selectedTeam,
  expanded,
  onSelectTeam,
}: Props) {
  return (
    <div className={`lg:col-span-3 flex flex-col min-h-0 ${expanded ? 'lg:h-full' : ''}`}>
      <h4 className="text-ui-caption text-theme-muted mb-2 shrink-0">Teams ({teams.length})</h4>
      <div
        className={`overflow-y-auto space-y-1.5 pr-1 custom-scrollbar flex-1 min-h-0 ${
          expanded ? '' : 'max-h-[32rem]'
        }`}
      >
        {!teams.length ? (
          <p className="text-ui-caption text-theme-muted italic p-3">Upload a PDF to detect teams</p>
        ) : (
          teams.map(team => {
            const projected = projectedByTeam.get(team) ?? 0;
            const actual = officialLookup.get(team);
            const isActive = team === selectedTeam;
            return (
              <button
                key={team}
                type="button"
                onClick={() => onSelectTeam(team)}
                className={`w-full text-left p-3.5 rounded-lg border transition-all ${
                  isActive
                    ? 'border-[var(--text-accent)]/40 bg-[var(--text-accent)]/10'
                    : 'border-theme-soft surface-overlay theme-hover-row'
                }`}
              >
                <div className="text-ui-label font-medium text-[var(--text-primary)] truncate" title={team}>
                  {team}
                </div>
                <div className="text-ui-caption text-theme-secondary mt-1">
                  {memberCounts.get(team) ?? 0} athletes
                </div>
                <div className="flex gap-2 mt-2 text-ui-micro font-mono">
                  {actual != null ? <span className="text-theme-secondary">Act {actual.toFixed(0)}</span> : null}
                  <span className="text-[var(--text-accent)]">Proj {projected.toFixed(0)}</span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
