export default function ImageGallery({ images }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mt-4">
      {images.map((img) => (
        <div key={img.id} className="border rounded overflow-hidden">
          <img
            src={img.url}
            alt={img.title}
            loading="lazy"
            className="w-full h-48 object-cover"
          />
          <div className="p-2">
            <div className="text-xs break-all">{img.title}</div>
            {img.score !== null && img.score !== undefined && (
              <div className="text-xs text-gray-500">
                score: {Number(img.score).toFixed(4)}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
