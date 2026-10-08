import { describe, expect, it } from 'vitest';
import { canMoveStage, checkInSchema, normalizeIndianMobile, normalizeRegistration, servicePriceSchema, vehicleSchema } from './index.js';

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

  it('reports invalid registration numbers through schemas without throwing', () => {
    const vehicle = vehicleSchema.safeParse({ customerId: 'customer', registrationNumber: 'invalid plate', make: 'Tata', model: 'Nexon', type: 'SUV' });
    const checkIn = checkInSchema.safeParse({ idempotencyKey: 'c2b69f76-6e6b-4aa4-917d-c928906ec1a0', mobile: '9845612399', customerName: 'Test Driver', registrationNumber: 'invalid plate', make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId: 'service', expectedAt: '2026-10-08T16:00:00+05:30' });
    expect(vehicle.error?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['registrationNumber'], message: 'Enter a valid Indian registration number' })]));
    expect(checkIn.error?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['registrationNumber'], message: 'Enter a valid Indian registration number' })]));
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
