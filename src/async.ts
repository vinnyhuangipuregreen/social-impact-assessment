export async function filterAsync<T>(rows: T[], predicate: (row: T) => Promise<unknown>): Promise<T[]> {
  const keep = await Promise.all(rows.map(predicate));
  return rows.filter((_, index) => keep[index]);
}
