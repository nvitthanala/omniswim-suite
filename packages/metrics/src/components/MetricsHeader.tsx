import React from 'react';
import { FolderOpen, Save, Download, Settings2, UploadCloud } from 'lucide-react';

const HEADER_BUTTON_CLASS =
  'px-3 py-2 rounded-lg text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)] transition-colors';

interface MetricsHeaderProps {
  sessionCount: number;
  showSessions: boolean;
  onToggleSessions: () => void;
  canSave: boolean;
  onSaveSession: () => void;
  canExport: boolean;
  onExportReport: () => void;
  canReconfigure: boolean;
  onReconfigure: () => void;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

/**
 * Top bar of the Metrics applet: title, sessions toggle, and the
 * save/export/reconfigure/open-video actions. Each action button is only
 * shown once its precondition is met (e.g. Save needs a confirmed setup).
 */
export function MetricsHeader({
  sessionCount,
  showSessions,
  onToggleSessions,
  canSave,
  onSaveSession,
  canExport,
  onExportReport,
  canReconfigure,
  onReconfigure,
  onFileChange,
}: MetricsHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-theme-soft shrink-0">
      <div>
        <h2 className="text-ui-label font-black uppercase tracking-widest text-[var(--text-primary)]">
          Swim Metrics
        </h2>
        <p className="text-ui-caption text-theme-muted">Frame-accurate race tagging & analysis</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleSessions}
          className={HEADER_BUTTON_CLASS}
          title="Saved sessions"
        >
          <FolderOpen size={14} />
          Sessions{sessionCount ? ` (${sessionCount})` : ''}
        </button>
        {canSave ? (
          <button
            type="button"
            onClick={onSaveSession}
            className={HEADER_BUTTON_CLASS}
            title="Save this analysis session"
          >
            <Save size={14} />
            Save
          </button>
        ) : null}
        {canExport ? (
          <button
            type="button"
            onClick={onExportReport}
            className={HEADER_BUTTON_CLASS}
            title="Export metrics report as CSV"
          >
            <Download size={14} />
            Report
          </button>
        ) : null}
        {canReconfigure ? (
          <button type="button" onClick={onReconfigure} className={HEADER_BUTTON_CLASS}>
            <Settings2 size={14} />
            Re-configure
          </button>
        ) : null}
        <input type="file" accept="video/*" className="hidden" id="metrics-file-input" onChange={onFileChange} />
        <label
          htmlFor="metrics-file-input"
          className="px-3 py-2 btn-primary rounded-lg text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 cursor-pointer"
        >
          <UploadCloud size={14} />
          Open Video
        </label>
      </div>
    </div>
  );
}
