export function PostCardSkeleton() {
  return (
    <div className="border border-border rounded-lg p-4 animate-pulse">
      <div className="flex gap-3">
        <div className="w-10 flex flex-col items-center gap-1">
          <div className="h-4 w-4 bg-card rounded" />
          <div className="h-4 w-6 bg-card rounded" />
          <div className="h-4 w-4 bg-card rounded" />
        </div>
        <div className="flex-1 space-y-2">
          <div className="h-5 bg-card rounded w-3/4" />
          <div className="h-3 bg-card rounded w-1/2" />
          <div className="h-3 bg-card rounded w-1/3" />
        </div>
      </div>
    </div>
  );
}

export function PostDetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 bg-card rounded w-3/4" />
      <div className="h-4 bg-card rounded w-1/3" />
      <div className="space-y-2">
        <div className="h-4 bg-card rounded w-full" />
        <div className="h-4 bg-card rounded w-full" />
        <div className="h-4 bg-card rounded w-2/3" />
      </div>
    </div>
  );
}

export function ProfileSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 bg-card rounded-full" />
        <div className="space-y-2">
          <div className="h-6 bg-card rounded w-48" />
          <div className="h-4 bg-card rounded w-32" />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 bg-card rounded" />
        ))}
      </div>
    </div>
  );
}
