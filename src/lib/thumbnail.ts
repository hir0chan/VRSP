export function resolveThumbnailUrl(path: string, baseUrl: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${baseUrl}${path}`;
}
