/** Read HiGHS primal columns only after it proves an optimum. */
export function optimalColumns(status: string, readColumns: () => Readonly<Record<string, { readonly Primal?: number }>>): Record<string, number> {
  if (status !== 'Optimal') return {};
  const columns: Record<string, number> = {};
  for (const [name, column] of Object.entries(readColumns())) if (typeof column.Primal === 'number') columns[name] = column.Primal;
  return columns;
}
