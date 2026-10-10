import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { resolveServicePrice } from '../src/catalog.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { createPaidTestOrganization } from './paid-fixture.js';

const testUrl = assertLocalTestDatabase(process.env.TEST_DATABASE_URL);
const db = createDb(testUrl);
const config = { ...getConfig(), NODE_ENV: 'test' as const, devOtp: true, DEV_OTP_ENABLED: 'true' as const, DEV_OTP_FIXED_CODE: '123456', LOG_LEVEL: 'error' };
const slug = `catalog-${randomUUID()}`;
const employeeMobile = String(9000000000 + randomInt(900000000));
const employeeE164 = `+91${employeeMobile}`;
const origin = config.APP_ORIGIN;
let app: Awaited<ReturnType<typeof buildApp>>;
let organizationId: string;
let branchId: string;
let otherBranchId: string;
let ownerCookie: string;
let employeeCookie: string;
let customerId: string;
let vehicleId: string;
let serviceId: string;

function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, cookie?: string) {
  return app.inject({ method, url, headers: { origin, 'content-type': 'application/json', 'x-organization-slug': slug, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}

beforeAll(async () => {
  const org = await createPaidTestOrganization(db, { data: { slug, name: 'Catalog Test' } });
  organizationId = org.id;
  const branch = await db.branch.create({ data: { organizationId, name: 'Main' } });
  branchId = branch.id;
  otherBranchId = (await db.branch.create({ data: { organizationId, name: 'Second' } })).id;
  await db.user.create({ data: { organizationId, branchId, role: 'OWNER', name: 'Owner', username: 'owner', passwordHash: await hash('catalog-password') } });
  await db.user.create({ data: { organizationId, branchId, role: 'EMPLOYEE', name: 'Ravi', employee: { create: { mobile: employeeE164 } } } });
  app = await buildApp(config, db);
  await app.ready();
  const owner = await request('POST', '/api/auth/owner/login', { login: 'owner', password: 'catalog-password' });
  ownerCookie = `${owner.cookies[0]!.name}=${owner.cookies[0]!.value}`;
  await request('POST', '/api/auth/employee/request-otp', { mobile: employeeMobile });
  const employee = await request('POST', '/api/auth/employee/verify-otp', { mobile: employeeMobile, code: config.DEV_OTP_FIXED_CODE });
  employeeCookie = `${employee.cookies[0]!.name}=${employee.cookies[0]!.value}`;
});

afterAll(async () => { if (app) await app.close(); await db.$disconnect(); });

describe('M2 catalog and tenant boundaries', () => {
  it('creates and reuses a customer and searches by name and mobile', async () => {
    const created = await request('POST', '/api/customers', { name: 'Meera Nair', mobile: '9845612300', tags: ['regular'] }, ownerCookie);
    expect(created.statusCode).toBe(201);
    customerId = created.json().id;
    const duplicate = await request('POST', '/api/customers', { name: 'Meera Again', mobile: '+91 98456 12300' }, ownerCookie);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().id).toBe(customerId);
    const found = await request('GET', '/api/customers?q=Meera', undefined, employeeCookie);
    expect(found.json().some((customer: { id: string }) => customer.id === customerId)).toBe(true);
    expect(found.json()).toHaveLength(1);
    expect(await db.auditLog.count({ where: { organizationId, action: 'CUSTOMER_CREATED', entityId: customerId } })).toBe(1);
  });

  it('normalizes BH plates and reuses existing vehicles', async () => {
    const payload = { customerId, registrationNumber: '22 bh 1234 aa', make: 'Tata', model: 'Nexon', type: 'SUV' };
    const created = await request('POST', '/api/vehicles', payload, employeeCookie);
    expect(created.statusCode).toBe(201);
    expect(created.json().registrationNumber).toBe('22BH1234AA');
    vehicleId = created.json().id;
    const duplicate = await request('POST', '/api/vehicles', { ...payload, registrationNumber: '22BH1234AA' }, ownerCookie);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().id).toBe(vehicleId);
    const search = await request('GET', '/api/search?q=22%20BH%201234%20AA', undefined, employeeCookie);
    expect(search.json().vehicles[0].id).toBe(vehicleId);
    const other = await request('POST', '/api/customers', { name: 'Arjun Shah', mobile: '9845612301' }, ownerCookie);
    expect((await request('POST', '/api/vehicles', { ...payload, customerId: other.json().id }, ownerCookie)).statusCode).toBe(409);
  });

  it('rejects an invalid registration as a validation error without creating a vehicle', async () => {
    const before = await db.vehicle.count({ where: { organizationId } });
    const response = await request('POST', '/api/vehicles', { customerId, registrationNumber: 'invalid plate', make: 'Tata', model: 'Nexon', type: 'SUV' }, ownerCookie);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ path: 'registrationNumber', message: 'Enter a valid Indian registration number' }] });
    expect(await db.vehicle.count({ where: { organizationId } })).toBe(before);
  });

  it('scopes customer and vehicle access to the organization', async () => {
    const foreignOrg = await createPaidTestOrganization(db, { data: { slug: `foreign-${randomUUID()}`, name: 'Foreign Wash' } });
    const foreignCustomer = await db.customer.create({ data: { organizationId: foreignOrg.id, name: 'Foreign', mobile: '+919845612305' } });
    expect((await request('GET', `/api/customers/${foreignCustomer.id}`, undefined, ownerCookie)).statusCode).toBe(404);
    expect((await request('POST', '/api/vehicles', { customerId: foreignCustomer.id, registrationNumber: 'KA03MN4567', make: 'Honda', model: 'City', type: 'SEDAN' }, ownerCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/vehicles/${vehicleId}`, undefined, ownerCookie)).statusCode).toBe(200);
  });

  it('sets branch and vehicle prices and hides prices from employees', async () => {
    const created = await request('POST', '/api/services', { name: 'Premium Wash', category: 'Wash', basePricePaise: 59900, estimatedMinutes: 45 }, ownerCookie);
    expect(created.statusCode).toBe(201);
    serviceId = created.json().id;
    expect((await request('PUT', `/api/services/${serviceId}/prices`, { vehicleType: 'SUV', pricePaise: 69900 }, ownerCookie)).statusCode).toBe(200);
    expect((await request('PUT', `/api/services/${serviceId}/prices`, { branchId, vehicleType: 'SUV', pricePaise: 74900 }, ownerCookie)).statusCode).toBe(200);
    expect((await resolveServicePrice(db, organizationId, serviceId, branchId, 'SUV')).pricePaise).toBe(74900);
    expect((await resolveServicePrice(db, organizationId, serviceId, otherBranchId, 'SUV')).pricePaise).toBe(69900);
    expect((await request('PUT', `/api/services/${serviceId}/branches/${otherBranchId}`, { active: false }, ownerCookie)).statusCode).toBe(200);
    await expect(resolveServicePrice(db, organizationId, serviceId, otherBranchId, 'SUV')).rejects.toMatchObject({ statusCode: 404 });
    const employeeList = await request('GET', '/api/services', undefined, employeeCookie);
    expect(employeeList.json()[0].basePricePaise).toBeUndefined();
    expect(employeeList.json()[0].prices).toBeUndefined();
    expect(employeeList.json()[0].taxRateBps).toBeUndefined();
    expect((await request('POST', '/api/services', { name: 'Secret', category: 'Wash', basePricePaise: 100, estimatedMinutes: 20 }, employeeCookie)).statusCode).toBe(403);
    expect(await db.auditLog.count({ where: { organizationId, action: 'SERVICE_PRICE_SET' } })).toBe(2);
  });
});
