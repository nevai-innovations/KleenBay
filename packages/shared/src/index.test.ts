import { describe, expect, it } from 'vitest';
import { canMoveStage, normalizeIndianMobile, normalizeRegistration, servicePriceSchema } from './index.js';

describe('shared business rules', () => {
  it('normalizes Indian mobiles and rejects invalid numbers', () => {
    expect(normalizeIndianMobile('98765 43210')).toBe('+919876543210');
    expect(normalizeIndianMobile('+91 98765 43210')).toBe('+919876543210');
    expect(normalizeIndianMobile('0919876543210')).toBe('+919876543210');
    expect(normalizeIndianMobile('09876543210')).toBe('+919876543210');
    expect(() => normalizeIndianMobile('12345')).toThrow();
  });

  it('normalizes standard and BH registration numbers', () => {
    expect(normalizeRegistration('kl 07 ab 1234')).toBe('KL07AB1234');
    expect(normalizeRegistration('22 bh 1234 aa')).toBe('22BH1234AA');
    expect(() => normalizeRegistration('invalid plate')).toThrow();
  });

  it('allows only the next workflow stage', () => {
    expect(canMoveStage('RECEIVED', 'WASHING')).toBe(true);
    expect(canMoveStage('RECEIVED', 'READY')).toBe(false);
    expect(canMoveStage('HANDED_OVER', 'RECEIVED')).toBe(false);
  });

  it('rejects negative service prices', () => {
    expect(servicePriceSchema.safeParse({ vehicleType: 'SUV', pricePaise: -1 }).success).toBe(false);
    expect(servicePriceSchema.safeParse({ vehicleType: 'SUV', pricePaise: 69900 }).success).toBe(true);
  });
});
