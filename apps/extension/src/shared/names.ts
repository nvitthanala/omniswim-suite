/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What to show for a swimmer or team whose display name is not in the data. A bare id reads like a name, so the label says the name is
 * absent (CLAUDE.md, data provenance: absent is said, not guessed). The id stays in the label so the coach can still tell rows apart.
 */

/** "Swimmer 148001 (name not loaded)" when there is no name. */
export const swimmerLabel = (id: string, name: string | undefined): string => (name === undefined || name.trim() === '' ? `Swimmer ${id} (name not loaded)` : name);

/** "Team 58 (name not loaded)" when there is no name. */
export const teamLabel = (id: string, name: string | undefined): string => (name === undefined || name.trim() === '' ? `Team ${id} (name not loaded)` : name);
