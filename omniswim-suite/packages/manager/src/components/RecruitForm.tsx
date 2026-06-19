/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Play } from 'lucide-react';
import { Gender, ClassYear, Recruit } from '@omniswim/core/types';
import { v4 as uuidv4 } from 'uuid';

interface Props {
  gender: Gender;
  teams: string[];
  onSubmit: (recruit: Recruit) => void;
  disabled?: boolean;
  /** Tighter layout (~half vertical footprint) for Team Management panel */
  compact?: boolean;
  /** Pre-select team when user picks a team in the roster sidebar */
  defaultTeam?: string;
  /** Autofill identity fields when a roster athlete is selected (event/time left for new entry) */
  athletePrefill?: RecruitAthletePrefill | null;
}

export type RecruitAthletePrefill = {
  name: string;
  team: string;
  classYear: string;
};

function parseAthleteName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  if (trimmed.includes(',')) {
    const [last, ...rest] = trimmed.split(',');
    return { firstName: rest.join(',').trim(), lastName: last.trim() };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }
  return { firstName: trimmed, lastName: '' };
}

function parseClassYear(raw: string | undefined): ClassYear {
  const u = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (u === 'FR' || u === 'FRESHMAN') return ClassYear.FR;
  if (u === 'SO' || u === 'SOPHOMORE') return ClassYear.SO;
  if (u === 'JR' || u === 'JUNIOR') return ClassYear.JR;
  if (u === 'SR' || u === 'SENIOR') return ClassYear.SR;
  if (u === 'HS') return ClassYear.HS;
  return ClassYear.FR;
}

const EVENTS = [
  '50 Freestyle', '100 Freestyle', '200 Freestyle', '500 Freestyle', '1000 Freestyle', '1650 Freestyle',
  '100 Backstroke', '200 Backstroke', '100 Breaststroke', '200 Breaststroke',
  '100 Butterfly', '200 Butterfly', '200 IM', '400 IM',
  '50 Freestyle (Relay split)', '100 Freestyle (Relay split)',
  '50 Breaststroke (Relay split)', '100 Breaststroke (Relay split)',
  '50 Butterfly (Relay split)', '100 Butterfly (Relay split)',
];

export default function RecruitForm({
  gender,
  teams,
  onSubmit,
  disabled = false,
  compact = false,
  defaultTeam,
  athletePrefill,
}: Props) {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    team: defaultTeam && teams.includes(defaultTeam) ? defaultTeam : teams[0] || 'Unassigned',
    event: EVENTS[0],
    time: '',
    timeType: 'SCY' as 'SCY' | 'LCM' | 'SCM',
    classYear: ClassYear.FR,
  });

  useEffect(() => {
    if (defaultTeam && teams.includes(defaultTeam)) {
      setFormData(prev => (prev.team === defaultTeam ? prev : { ...prev, team: defaultTeam }));
    }
  }, [defaultTeam, teams]);

  useEffect(() => {
    if (!athletePrefill) return;
    const { firstName, lastName } = parseAthleteName(athletePrefill.name);
    const team = teams.includes(athletePrefill.team)
      ? athletePrefill.team
      : teams[0] || 'Unassigned';
    setFormData(prev => ({
      ...prev,
      firstName,
      lastName,
      team,
      classYear: parseClassYear(athletePrefill.classYear),
      time: '',
    }));
  }, [athletePrefill, teams]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    if (!formData.firstName || !formData.lastName || !formData.time) return;

    onSubmit({
      id: uuidv4(),
      name: `${formData.lastName}, ${formData.firstName}`,
      team: formData.team,
      event: formData.event,
      time: formData.time,
      gender,
      classYear: formData.classYear,
      timeType: formData.timeType,
    });
    if (compact && athletePrefill) {
      setFormData(prev => ({ ...prev, time: '' }));
    } else {
      setFormData({ ...formData, firstName: '', lastName: '', time: '' });
    }
  };

  const inputClass = compact ? 'glass-input glass-input-compact w-full' : 'glass-input w-full';
  const labelClass = compact
    ? 'block text-[9px] uppercase text-theme-muted font-bold mb-1'
    : 'block text-[10px] uppercase text-theme-muted font-bold mb-1.5';
  const teamOptions =
    teams.length > 0 ? teams.map(t => ({ value: t, label: t })) : [{ value: 'Unassigned', label: 'Unassigned' }];

  if (compact) {
    return (
      <form
        onSubmit={handleSubmit}
        className={`space-y-2 ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
      >
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-2">
            <label className={labelClass}>First</label>
            <input
              type="text"
              value={formData.firstName}
              onChange={e => setFormData({ ...formData, firstName: e.target.value })}
              className={inputClass}
              placeholder="First"
            />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>Last</label>
            <input
              type="text"
              value={formData.lastName}
              onChange={e => setFormData({ ...formData, lastName: e.target.value })}
              className={inputClass}
              placeholder="Last"
            />
          </div>
          <div className="col-span-3">
            <label className={labelClass}>Team</label>
            <select
              value={formData.team}
              onChange={e => setFormData({ ...formData, team: e.target.value })}
              className={`${inputClass} appearance-none`}
            >
              {teamOptions.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-1">
            <label className={labelClass}>Crs</label>
            <select
              value={formData.timeType}
              onChange={e => setFormData({ ...formData, timeType: e.target.value as 'SCY' | 'LCM' | 'SCM' })}
              className={`${inputClass} appearance-none`}
            >
              <option value="SCY">SCY</option>
              <option value="LCM">LCM</option>
              <option value="SCM">SCM</option>
            </select>
          </div>
          <div className="col-span-3">
            <label className={labelClass}>Event</label>
            <select
              value={formData.event}
              onChange={e => setFormData({ ...formData, event: e.target.value })}
              className={`${inputClass} appearance-none`}
            >
              {EVENTS.map(ev => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-1">
            <label className={labelClass}>Yr</label>
            <select
              value={formData.classYear}
              onChange={e => setFormData({ ...formData, classYear: e.target.value as ClassYear })}
              className={`${inputClass} appearance-none`}
            >
              <option value={ClassYear.FR}>FR</option>
              <option value={ClassYear.SO}>SO</option>
              <option value={ClassYear.JR}>JR</option>
              <option value={ClassYear.SR}>SR</option>
              <option value={ClassYear.HS}>HS</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2 items-end">
          <div className="flex-1 max-w-[8rem]">
            <label className={labelClass}>Time</label>
            <input
              type="text"
              value={formData.time}
              onChange={e => setFormData({ ...formData, time: e.target.value })}
              className={`${inputClass} font-mono text-[var(--text-primary)]`}
              placeholder="00:00.00"
            />
          </div>
          <button
            type="submit"
            disabled={disabled}
            className="flex-1 py-2 btn-recruit font-black text-[9px] uppercase tracking-widest rounded transition-all flex items-center justify-center gap-1.5"
          >
            <Play size={10} fill="currentColor" />
            <span>Inject Recruit</span>
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={`space-y-4 ${disabled ? 'opacity-60 pointer-events-none' : ''}`}>
      <div>
        <label className={labelClass}>Athlete Name</label>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={formData.firstName}
            onChange={e => setFormData({ ...formData, firstName: e.target.value })}
            className={inputClass}
            placeholder="First"
          />
          <input
            type="text"
            value={formData.lastName}
            onChange={e => setFormData({ ...formData, lastName: e.target.value })}
            className={inputClass}
            placeholder="Last"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Committed Team</label>
          <select
            value={formData.team}
            onChange={e => setFormData({ ...formData, team: e.target.value })}
            className={`${inputClass} appearance-none`}
          >
            {teamOptions.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Course</label>
          <select
            value={formData.timeType}
            onChange={e => setFormData({ ...formData, timeType: e.target.value as 'SCY' | 'LCM' | 'SCM' })}
            className={`${inputClass} appearance-none`}
          >
            <option value="SCY">SCY (Yards)</option>
            <option value="LCM">LCM (Meters)</option>
            <option value="SCM">SCM (Meters)</option>
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass}>Event Selection</label>
        <div className="grid grid-cols-2 gap-3">
          <select
            value={formData.event}
            onChange={e => setFormData({ ...formData, event: e.target.value })}
            className={`${inputClass} appearance-none`}
          >
            {EVENTS.map(ev => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
          <select
            value={formData.classYear}
            onChange={e => setFormData({ ...formData, classYear: e.target.value as ClassYear })}
            className={`${inputClass} appearance-none`}
          >
            <option value={ClassYear.FR}>Freshman (FR)</option>
            <option value={ClassYear.SO}>Sophomore (SO)</option>
            <option value={ClassYear.JR}>Junior (JR)</option>
            <option value={ClassYear.SR}>Senior (SR)</option>
            <option value={ClassYear.HS}>High School (HS)</option>
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass}>Time Entry (Auto-Convert Enabled)</label>
        <input
          type="text"
          value={formData.time}
          onChange={e => setFormData({ ...formData, time: e.target.value })}
          className={`${inputClass} font-mono text-[var(--text-primary)]`}
          placeholder="00:00.00"
        />
      </div>

      <button
        type="submit"
        disabled={disabled}
        className="w-full py-3 mt-2 btn-recruit font-black text-[10px] uppercase tracking-[0.2em] rounded transition-all flex items-center justify-center gap-2"
      >
        <Play size={12} fill="currentColor" />
        <span>Inject Recruit Into Matrix</span>
      </button>
    </form>
  );
}
