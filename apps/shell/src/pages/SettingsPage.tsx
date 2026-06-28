import { useMemo, useState } from 'react';
import {
  THEME_PRESETS,
  type TextScale,
  type ThemeMode,
  type ThemePreset,
  useSuitePreferences,
} from '@omniswim/core';
import { Badge, Button, SegmentedControl, SettingsSection } from '@omniswim/ui';

const ACCENT_SWATCHES = ['#f87171', '#fb7185', '#fbbf24', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6'];

const TEXT_SCALE_OPTIONS: Array<{ id: TextScale; label: string; description: string }> = [
  { id: 'compact', label: 'Compact', description: 'Fits more roster detail on screen.' },
  { id: 'default', label: 'Default', description: 'Balanced for everyday use.' },
  { id: 'comfortable', label: 'Comfortable', description: 'Adds breathing room for reviews.' },
  { id: 'large', label: 'Large', description: 'Best for presentations and accessibility.' },
];

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl border border-theme-soft bg-[var(--surface-muted)] p-4">
      <span>
        <span className="block font-bold text-[var(--text-primary)]">{label}</span>
        <span className="block text-ui-caption text-theme-secondary mt-1">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.currentTarget.checked)}
        className="h-5 w-5 accent-[var(--text-accent)]"
      />
    </label>
  );
}

function SettingsPreview() {
  return (
    <aside className="surface-card rounded-3xl p-5 lg:sticky lg:top-6 h-fit">
      <div className="flex items-center justify-between border-b border-theme-soft pb-4">
        <div>
          <p className="text-ui-micro uppercase tracking-[0.22em] text-theme-muted font-bold">Live preview</p>
          <h2 className="text-xl font-black tracking-tight mt-1">Meet Deck</h2>
        </div>
        <div className="h-8 w-8 rounded-full bg-[var(--text-accent)] shadow-[0_0_24px_color-mix(in_srgb,var(--text-accent)_42%,transparent)]" />
      </div>

      <div className="mt-5 space-y-4">
        <div className="surface-muted-bg rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-ui-caption font-bold text-[var(--text-primary)]">Championship Session</p>
              <p className="text-ui-caption text-theme-secondary">Projected score updates instantly.</p>
            </div>
            <Badge tone="accent">Ready</Badge>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2" aria-hidden="true">
            {[62, 84, 46, 72].map((height, index) => (
              <div key={height} className="flex h-24 items-end rounded-lg bg-[var(--surface)] p-1">
                <div
                  className="w-full rounded-md bg-[var(--text-accent)]"
                  style={{ height: `${height}%`, opacity: 1 - index * 0.12 }}
                />
              </div>
            ))}
          </div>
        </div>

        <Button className="w-full">
          Apply Lineup Change
        </Button>

        <div className="toast-item toast-info">
          <span className="toast-icon">*</span>
          <span className="toast-message">Settings save automatically on this device.</span>
        </div>
      </div>
    </aside>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'appearance' | 'accessibility'>('appearance');
  const { preferences, updatePreferences, resetPreferences } = useSuitePreferences();

  const selectedPreset = useMemo(
    () => THEME_PRESETS.find(preset => preset.id === preferences.themePreset) ?? THEME_PRESETS[0],
    [preferences.themePreset]
  );

  const setPreset = (themePreset: ThemePreset) => {
    const preset = THEME_PRESETS.find(item => item.id === themePreset);
    updatePreferences({
      themePreset,
      colorMode: themePreset === 'custom' ? preferences.colorMode : preset?.mode ?? preferences.colorMode,
      accentColor: themePreset === 'custom' ? preferences.accentColor : preset?.accentColor ?? preferences.accentColor,
    });
  };

  const setMode = (colorMode: ThemeMode) => {
    if (preferences.themePreset === 'custom') {
      updatePreferences({ colorMode });
      return;
    }
    const themePreset = colorMode === 'light' ? 'deck-light' : 'midnight';
    const preset = THEME_PRESETS.find(item => item.id === themePreset);
    updatePreferences({ colorMode, themePreset, accentColor: preset?.accentColor ?? preferences.accentColor });
  };

  return (
    <div className="min-h-full px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="label-caps">Suite settings</p>
            <h1 className="mt-2 text-3xl font-black tracking-tighter text-[var(--text-primary)]">Make OmniSwim yours</h1>
            <p className="mt-2 max-w-2xl text-ui-body text-theme-secondary">
              Choose a meet-day look, tune text size, and keep the interface comfortable for the way you coach.
            </p>
          </div>
          <Button type="button" onClick={resetPreferences} variant="outline">
            Reset to defaults
          </Button>
        </div>

        <SegmentedControl
          className="mb-6 max-w-md"
          ariaLabel="Settings sections"
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'appearance', label: 'Appearance' },
            { value: 'accessibility', label: 'Accessibility' },
          ]}
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-6">
            {activeTab === 'appearance' ? (
              <>
                <SettingsSection
                  title="Theme preset"
                  description="Start with a polished preset, then customize the highlight color if your team needs it."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    {THEME_PRESETS.map(preset => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setPreset(preset.id)}
                        className={`surface-interactive rounded-2xl border p-4 text-left transition-all ${
                          preferences.themePreset === preset.id
                            ? 'border-[var(--text-accent)] bg-[var(--text-accent)]/10'
                            : 'border-theme-soft bg-[var(--surface-muted)] hover:border-[var(--text-accent)]'
                        }`}
                      >
                        <span className="flex items-center gap-3">
                          <span
                            className="h-8 w-8 rounded-full border border-white/20"
                            style={{ background: preset.id === 'custom' ? preferences.accentColor : preset.accentColor }}
                          />
                          <span>
                            <span className="block font-black text-[var(--text-primary)]">{preset.name}</span>
                            <span className="text-ui-caption text-theme-secondary">{preset.mode === 'light' ? 'Light base' : 'Dark base'}</span>
                          </span>
                        </span>
                        <span className="mt-3 block text-ui-caption text-theme-secondary">{preset.description}</span>
                      </button>
                    ))}
                  </div>
                </SettingsSection>

                <SettingsSection
                  title="Highlight color"
                  description="Pick the accent used for buttons, active tabs, focus states, chart hints, and preview details."
                >
                  <div className="flex flex-wrap gap-2">
                    {ACCENT_SWATCHES.map(color => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => updatePreferences({ themePreset: 'custom', accentColor: color })}
                        className="h-10 w-10 rounded-full border-2 border-[var(--border)] focus:outline-none focus:ring-4 focus:ring-[var(--focus)]"
                        style={{ backgroundColor: color }}
                        aria-label={`Use accent ${color}`}
                      />
                    ))}
                  </div>
                  <label className="mt-4 flex flex-col gap-2 text-ui-label font-bold text-[var(--text-primary)]">
                    Custom team color
                    <input
                      type="color"
                      value={preferences.accentColor}
                      onChange={event => updatePreferences({ themePreset: 'custom', accentColor: event.currentTarget.value })}
                      className="h-12 w-28 cursor-pointer rounded-xl border border-theme-soft bg-[var(--surface-muted)] p-1"
                    />
                  </label>
                  <p className="text-ui-caption text-theme-secondary">Current preset: {selectedPreset.name}</p>
                </SettingsSection>

                <SettingsSection title="Light or dark base" description="Flip the suite between bright deck mode and a darker analytics board.">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(['dark', 'light'] as const).map(mode => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setMode(mode)}
                        className={`rounded-xl border px-4 py-3 text-left font-bold capitalize ${
                          preferences.colorMode === mode
                            ? 'border-[var(--text-accent)] bg-[var(--text-accent)]/10 text-[var(--text-accent)]'
                            : 'border-theme-soft bg-[var(--surface-muted)] text-theme-secondary'
                        }`}
                      >
                        {mode} base
                      </button>
                    ))}
                  </div>
                </SettingsSection>
              </>
            ) : (
              <>
                <SettingsSection title="Text size" description="Adjust the whole suite, from tabs to roster tables, without changing browser zoom.">
                  <SegmentedControl
                    ariaLabel="Text size"
                    value={preferences.textScale}
                    onChange={textScale => updatePreferences({ textScale })}
                    options={TEXT_SCALE_OPTIONS.map(option => ({
                      value: option.id,
                      label: option.label,
                      description: option.description,
                    }))}
                  />
                </SettingsSection>

                <SettingsSection title="Accessibility helpers" description="Tune motion, contrast, and focus visibility for a more comfortable deck view.">
                  <div className="space-y-3">
                    <ToggleRow
                      label="Reduce motion"
                      description="Minimizes page fades and hover movement."
                      checked={preferences.reducedMotion}
                      onChange={checked => updatePreferences({ reducedMotion: checked })}
                    />
                    <ToggleRow
                      label="High contrast"
                      description="Strengthens borders and secondary text."
                      checked={preferences.highContrast}
                      onChange={checked => updatePreferences({ highContrast: checked })}
                    />
                    <ToggleRow
                      label="Enhanced focus rings"
                      description="Makes keyboard focus easier to spot."
                      checked={preferences.focusRingEnhanced}
                      onChange={checked => updatePreferences({ focusRingEnhanced: checked })}
                    />
                  </div>
                </SettingsSection>
              </>
            )}
          </div>

          <SettingsPreview />
        </div>

        <p className="mt-6 text-ui-caption text-theme-muted">
          These settings save automatically on this device. AI tools remain disabled until a later phase.
        </p>
      </div>
    </div>
  );
}
