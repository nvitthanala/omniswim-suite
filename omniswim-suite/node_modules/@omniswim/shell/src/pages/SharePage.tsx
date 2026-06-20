import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Workspace } from '@omniswim/core/types';

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [label, setLabel] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/share/${token}`)
      .then(async res => {
        if (!res.ok) throw new Error('Link not found');
        return res.json();
      })
      .then(data => {
        setLabel(data.label ?? 'Shared workspace');
        setWorkspace(data.workspace);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [token]);

  if (error) {
    return (
      <div className="max-w-lg mx-auto py-20 px-4 text-center text-theme-muted">{error}</div>
    );
  }

  if (!workspace) {
    return <div className="max-w-lg mx-auto py-20 px-4 text-center text-theme-muted">Loading…</div>;
  }

  const swimmerCount = new Set(
    [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])]
      .filter(r => !r.isRelay)
      .map(r => r.name)
  ).size;

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      <div className="panel p-6">
        <p className="text-ui-micro uppercase tracking-widest text-[var(--text-accent)] mb-2">Shared report</p>
        <h1 className="text-2xl font-black text-[var(--text-primary)]">{label}</h1>
        <p className="text-ui-caption text-theme-muted mt-2">
          {workspace.name} · {swimmerCount} athletes · read-only
        </p>
        <div className="mt-6 grid sm:grid-cols-2 gap-4 text-ui-caption">
          <div className="rounded-lg border border-theme-soft p-4">
            <div className="text-theme-muted">Men&apos;s results</div>
            <div className="text-2xl font-mono font-bold">{workspace.menResults?.length ?? 0}</div>
          </div>
          <div className="rounded-lg border border-theme-soft p-4">
            <div className="text-theme-muted">Women&apos;s results</div>
            <div className="text-2xl font-mono font-bold">{workspace.womenResults?.length ?? 0}</div>
          </div>
        </div>
        <a
          href={`/api/workspaces/${workspace.id}/report?format=html`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex mt-6 btn-primary px-4 py-2 rounded-lg text-ui-caption font-bold"
        >
          Open printable report
        </a>
      </div>
    </div>
  );
}
