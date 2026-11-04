export class BookingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BookingError';
  }
}

// Inspect known adapter fields only; never return/log its message, SQL or parameters.
export function databaseErrorFacts(error: unknown) {
  const codes = new Set<string>();
  const constraints = new Set<string>();
  const seen = new Set<object>();
  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['code', 'originalCode', 'sqlState', 'kind']) {
      if (typeof record[key] === 'string') codes.add(record[key]);
    }
    for (const key of ['constraint', 'constraintName', 'index']) {
      if (typeof record[key] === 'string') constraints.add(record[key]);
    }
    // PostgreSQL's generic adapter path preserves the originalMessage but not constraint.
    for (const key of ['originalMessage', 'message']) {
      if (typeof record[key] !== 'string') continue;
      for (const name of ['appointments_no_overlap', 'availability_no_overlap']) {
        if (record[key].includes(`"${name}"`)) constraints.add(name);
      }
    }
    for (const key of ['meta', 'cause', 'driverAdapterError', 'constraint'])
      visit(record[key], depth + 1);
  }
  visit(error, 0);
  return { codes, constraints };
}

export function translateDatabaseError(error: unknown): unknown {
  const { codes, constraints } = databaseErrorFacts(error);
  if (codes.has('23P01') && constraints.has('appointments_no_overlap')) {
    return new BookingError('SLOT_UNAVAILABLE');
  }
  if (codes.has('23P01') && constraints.has('availability_no_overlap')) {
    return new BookingError('SCHEDULE_OVERLAP');
  }
  if (codes.has('P2002') || codes.has('23505') || codes.has('UniqueConstraintViolation')) {
    return new BookingError('DUPLICATE_RESOURCE');
  }
  return error;
}
