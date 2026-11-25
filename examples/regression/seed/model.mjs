export function train(rows) {
  const average = rows.reduce((sum, row) => sum + row.y, 0) / rows.length;
  return () => average;
}
