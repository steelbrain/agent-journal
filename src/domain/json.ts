export function jsonArray(value: string | null): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : null;
}

export function jsonStringifyArray(value: string[] | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function hasAllTags(stored: string | null, requested: string[] | undefined): boolean {
  if (!requested || requested.length === 0) {
    return true;
  }

  const tags = new Set(jsonArray(stored) ?? []);
  return requested.every((tag) => tags.has(tag));
}
