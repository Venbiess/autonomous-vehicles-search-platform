export default function FilterPanel({ filters, onFilter }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {filters.map((f) => (
        <button
          key={f}
          onClick={() => onFilter(f)}
          className="border px-3 py-1 rounded hover:bg-gray-200"
        >
          {f}
        </button>
      ))}
    </div>
  );
}
