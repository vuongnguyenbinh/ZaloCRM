/**
 * Prisma mock factory — used by unit tests that import the prisma client.
 * Each test imports this BEFORE the SUT and calls vi.mock() at module scope.
 */
import { vi } from 'vitest';

export function createPrismaMock() {
  return {
    message: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    contact: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    zaloAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
}

export type PrismaMock = ReturnType<typeof createPrismaMock>;
