type AppletSkeletonKind = 'manager' | 'matrix' | 'metrics' | 'suite';

type AppletSkeletonProps = {
  kind?: AppletSkeletonKind;
  label?: string;
};

const LABELS: Record<AppletSkeletonKind, string> = {
  manager: 'Preparing roster workspace...',
  matrix: 'Building scoring board...',
  metrics: 'Opening video metrics...',
  suite: 'Loading suite...',
};

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={['skeleton-block', className].filter(Boolean).join(' ')} />;
}

export function AppletSkeleton({ kind = 'suite', label }: AppletSkeletonProps) {
  if (kind === 'manager') {
    return (
      <div className="space-y-4 p-4 lg:p-6" role="status" aria-label={label ?? LABELS.manager}>
        <div className="flex items-center justify-between">
          <SkeletonBlock className="h-8 w-56" />
          <SkeletonBlock className="h-10 w-36 rounded-xl" />
        </div>
        <div className="surface-card rounded-3xl p-4">
          <div className="grid gap-2">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="grid grid-cols-[2fr_1fr_1fr_5rem] gap-3">
                <SkeletonBlock className="h-10" />
                <SkeletonBlock className="h-10" />
                <SkeletonBlock className="h-10" />
                <SkeletonBlock className="h-10" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (kind === 'matrix') {
    return (
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-6" role="status" aria-label={label ?? LABELS.matrix}>
        <div className="space-y-4">
          <SkeletonBlock className="h-10 w-64" />
          <div className="grid gap-4 md:grid-cols-2">
            <SkeletonBlock className="h-64 rounded-3xl" />
            <SkeletonBlock className="h-64 rounded-3xl" />
          </div>
          <SkeletonBlock className="h-36 rounded-3xl" />
        </div>
        <SkeletonBlock className="h-full min-h-[24rem] rounded-3xl" />
      </div>
    );
  }

  if (kind === 'metrics') {
    return (
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:p-6" role="status" aria-label={label ?? LABELS.metrics}>
        <SkeletonBlock className="aspect-video rounded-3xl" />
        <div className="space-y-3">
          <SkeletonBlock className="h-10" />
          <SkeletonBlock className="h-24 rounded-2xl" />
          <SkeletonBlock className="h-24 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[16rem] flex-col items-center justify-center gap-4 p-8" role="status" aria-label={label ?? LABELS.suite}>
      <SkeletonBlock className="h-14 w-14 rounded-2xl" />
      <SkeletonBlock className="h-4 w-52" />
    </div>
  );
}
