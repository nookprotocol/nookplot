interface PropsTableColumn {
  key: string;
  label: string;
  mono?: boolean;
}

interface PropsTableProps {
  columns: PropsTableColumn[];
  rows: Record<string, string>[];
}

export function PropsTable({ columns, rows }: PropsTableProps) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
        <thead>
          <tr className="bg-[var(--color-bg-surface)]">
            {columns.map((col) => (
              <th
                key={col.key}
                className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase tracking-wider border-b border-border"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-border last:border-0 hover:bg-[var(--color-bg-surface)]/50 transition-colors"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-4 py-2.5 ${col.mono ? "font-mono text-xs" : ""}`}
                >
                  {row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
