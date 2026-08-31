import React from 'react';
import { Trash2, X } from 'lucide-react';
import type { SessionSummary } from '../lib/sessionStore';

interface SessionsPanelProps {
  sessions: SessionSummary[];
  onClose: () => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * The collapsible "Saved Sessions" list shown under the header when the
 * Sessions button is toggled on. Empty-state and populated-list are two
 * distinct branches; kept as one small component so MetricsApp's render
 * doesn't carry this branching itself.
 */
export function SessionsPanel({ sessions, onClose, onLoad, onDelete }: SessionsPanelProps) {
  return (
    <div className="mx-4 mt-4 border border-theme-soft rounded-lg overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface-strong)]">
        <span className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">Saved Sessions</span>
        <button type="button" onClick={onClose} className="p-1 theme-hover-row rounded" aria-label="Close">
          <X size={14} />
        </button>
      </div>
      {sessions.length === 0 ? (
        <div className="p-4 text-ui-caption text-theme-muted">No saved sessions yet.</div>
      ) : (
        <ul className="max-h-48 overflow-y-auto custom-scrollbar divide-y divide-[var(--border-soft)]">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} onLoad={onLoad} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onLoad,
  onDelete,
}: {
  session: SessionSummary;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-ui-caption">
      <button type="button" onClick={() => onLoad(session.id)} className="flex-1 text-left hover:text-[var(--text-accent)]">
        <span className="font-bold">{session.label}</span>
        {session.legacy ? (
          <span className="ml-2 px-1.5 py-0.5 rounded text-ui-micro uppercase tracking-widest bg-[var(--surface-muted)] text-theme-muted">
            Legacy
          </span>
        ) : null}
        <span className="text-theme-muted ml-2">{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''}</span>
      </button>
      <button
        type="button"
        onClick={() => onDelete(session.id)}
        className="p-1 theme-hover-row rounded text-theme-muted hover:text-red-400"
        aria-label="Delete session"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}
