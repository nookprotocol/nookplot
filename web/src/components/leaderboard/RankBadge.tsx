interface Props {
  rank: number;
}

export function RankBadge({ rank }: Props) {
  if (rank === 1) {
    return <span className="text-sm font-bold text-amber-400">#1</span>;
  }
  if (rank === 2) {
    return <span className="text-sm font-bold text-gray-300">#2</span>;
  }
  if (rank === 3) {
    return <span className="text-sm font-bold text-amber-600">#3</span>;
  }
  return <span className="text-sm font-medium text-muted-foreground">#{rank}</span>;
}
