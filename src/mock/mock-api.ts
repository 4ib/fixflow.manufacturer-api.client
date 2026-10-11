import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  Address,
  ChangePage,
  CreateWorkOrderRequest,
  Customer,
  Equipment,
  KeyInfo,
  Problem,
  ProblemDetails,
  ProblemPage,
  RegisterCustomerRequest,
  RegisterEquipmentRequest,
  RegisterServiceLocationRequest,
  ServiceLocation,
  Urgency,
  WorkOrder,
  WorkOrderStatus,
} from '../fixflow/types.js';
import { URGENCIES } from '../fixflow/types.js';

/**
 * An in-memory mock of the FixFlow Manufacturer API v1, so the demo runs without a key.
 *
 * It follows the published contract (`contract/openapi.v1.json`, checked by `test/contract.test.ts`)
 * and its documented behaviour:
 * - `X-Api-Key` auth (`401`), a per-key rate limit (`429` + `Retry-After`);
 * - your directory under YOUR keys: customers and service locations by `reference`, units by serial
 *   number. Registration is find-or-create, idempotent on the key (`201`, then `200` +
 *   `Idempotent-Replayed: true`), and never updates a stored row; a serial already at another site
 *   is a `409`;
 * - work-order create resolves KEY FIRST: a known key wins, the other fields are needed only for a
 *   new key; `externalReference` idempotency; `422` with field errors; an optional `problemId`;
 * - the problem catalogue, paged with an opaque cursor;
 * - single, by-reference and batch reads (`notFound`);
 * - the change feed: opaque cursor, current snapshots coalesced per work order, a 5 s lag,
 *   `since`. Creating a work order is not a feed event — its later changes are.
 *
 * The mock knows one manufacturer (the key's), so every unit in it is of the key's brand. A
 * simulator moves every open work order one status forward every `stepSeconds`.
 */
export interface MockApiOptions {
  apiKey: string;
  stepSeconds?: number;
  lagSeconds?: number;
  rateLimitPerMinute?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Start the status simulator (default true). Tests drive it with `advanceAll()`. */
  simulate?: boolean;
  /**
   * Seed a customer, a site and a unit a dispatcher "already created" in FixFlow (default true), so
   * registering the demo's sample customer shows how FixFlow finds an existing row.
   */
  seedDirectory?: boolean;
}

export interface MockApi {
  app: FastifyInstance;
  /** Moves every open work order one status forward (what the simulator does on each step). */
  advanceAll(): void;
}

const ROUTE = '/fixflow/manufacturer-api/v1';
const LIFECYCLE: WorkOrderStatus[] = ['New', 'Dispatched', 'Assigned', 'EnRoute', 'OnSite', 'Working', 'Done'];
const MANUFACTURER = { id: 7, name: 'Demo Manufacturer' };

/** A small slice of a service company's problem catalogue. */
const PROBLEMS: Problem[] = [
  { id: 101, name: "Won't power on", code: 'E-PWR', description: 'No response from the control panel.', equipmentType: 'Ice Machine' },
  { id: 102, name: 'Not making ice', code: 'IM-01', description: 'Runs but produces no ice.', equipmentType: 'Ice Machine' },
  { id: 103, name: 'Water leak', code: 'IM-02', description: 'Water under or around the unit.', equipmentType: 'Ice Machine' },
  { id: 104, name: 'Overheating', code: 'OV-01', description: 'Trips the thermal cut-off.', equipmentType: 'Commercial Oven' },
  { id: 105, name: 'Uneven heating', code: 'OV-02', description: 'Hot and cold spots in the cavity.', equipmentType: 'Commercial Oven' },
  { id: 106, name: 'Door seal damaged', code: 'OV-03', description: 'Heat escapes around the door.', equipmentType: 'Commercial Oven' },
  { id: 107, name: 'Not cooling', code: 'RF-01', description: 'Cabinet temperature above set point.', equipmentType: 'Refrigeration' },
  { id: 108, name: 'Compressor noise', code: 'RF-02', description: 'Loud or abnormal compressor noise.', equipmentType: 'Refrigeration' },
  { id: 109, name: 'Error code on display', code: 'E-CODE', description: 'Unit shows an error code and stops.', equipmentType: 'Refrigeration' },
  { id: 110, name: 'No airflow', code: 'HV-01', description: 'Blower runs but no air reaches the vents.', equipmentType: 'HVAC' },
  { id: 111, name: 'Thermostat fault', code: 'HV-02', description: 'Does not hold the set temperature.', equipmentType: 'HVAC' },
  { id: 112, name: 'Abnormal noise or vibration', code: 'GEN-01', description: 'Noise from bearings, fans or mounts.', equipmentType: null },
  { id: 113, name: 'Preventive maintenance', code: 'PM', description: 'Scheduled service, no fault.', equipmentType: null },
];

interface CustomerRow {
  id: number;
  name: string;
  address: Address | null;
  phone: string | null;
}

interface LocationRow {
  id: number;
  customerId: number;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  zip: string;
}

interface UnitRow {
  id: number;
  locationId: number;
  serialNumber: string | null;
  modelNumber: string;
  name: string;
}

interface WorkOrderRow {
  id: number;
  number: string;
  externalReference: string;
  status: WorkOrderStatus;
  urgency: Urgency;
  customerId: number;
  locationId: number;
  unitId: number;
  problemId: number | null;
  description: string;
  isWarranty: boolean;
  warrantyNumber: string | null;
  createdAt: string;
  deadline: string | null;
  scheduledServiceAt: string | null;
  dispatchedAt: string | null;
  vendorAcceptedAt: string | null;
  assignedAt: string | null;
  enRouteAt: string | null;
  onSiteAt: string | null;
  workingAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

interface JournalEntry {
  id: number;
  workOrderId: number;
  changedAt: number;
}

type Errors = Record<string, string[]>;

export function createMockApi(options: MockApiOptions): MockApi {
  const now = options.now ?? Date.now;
  const lagMs = (options.lagSeconds ?? 5) * 1000;
  const rateLimit = options.rateLimitPerMinute ?? 120;
  const keyCreatedAt = new Date(now()).toISOString();

  // FixFlow's directory (shared with dispatchers in the real thing) + YOUR keys mapped onto it.
  const customers = new Map<number, CustomerRow>();
  const locations = new Map<number, LocationRow>();
  const units = new Map<number, UnitRow>();
  const customerRefs = new Map<string, number>();
  const locationRefs = new Map<string, number>();

  const workOrders = new Map<number, WorkOrderRow>();
  const byExternalReference = new Map<string, number>();
  const journal: JournalEntry[] = [];
  const hits: number[] = [];
  let nextWorkOrderId = 10_001;
  let nextEntityId = 501;
  let nextJournalId = 1;
  let lastUsedAt: string | null = null;

  if (options.seedDirectory ?? true) {
    // What a dispatcher entered by hand before the integration existed: no keys of yours point here yet.
    const customer: CustomerRow = { id: nextEntityId++, name: 'Riverside Dental', address: null, phone: null };
    customers.set(customer.id, customer);
    const site: LocationRow = {
      id: nextEntityId++,
      customerId: customer.id,
      name: 'Riverside Dental — Trenton',
      addressLine1: '125 West State Street',
      addressLine2: null,
      city: 'Trenton',
      state: 'NJ',
      zip: '08608',
    };
    locations.set(site.id, site);
    const unit: UnitRow = { id: nextEntityId++, locationId: site.id, serialNumber: 'SN-77421', modelNumber: 'AC-200', name: 'AC-200' };
    units.set(unit.id, unit);
  }

  const app = Fastify({ logger: false });

  // ── realm: key + rate limit ──────────────────────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(ROUTE)) return;
    if (request.headers['x-api-key'] !== options.apiKey) {
      return problem(reply, 401, 'Unauthorized', 'A valid API key is required.');
    }
    const t = now();
    while (hits.length > 0 && hits[0]! <= t - 60_000) hits.shift();
    if (hits.length >= rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((hits[0]! + 60_000 - t) / 1000));
      reply.header('Retry-After', String(retryAfter));
      return problem(reply, 429, 'Too many requests', `Rate limit of ${rateLimit} requests per minute exceeded.`);
    }
    hits.push(t);
    lastUsedAt = new Date(t).toISOString();
  });

  app.get(`${ROUTE}/key`, async (): Promise<KeyInfo> => ({
    manufacturer: MANUFACTURER,
    key: { name: 'Mock key', prefix: options.apiKey.slice(0, 12), createdAt: keyCreatedAt, lastUsedAt },
  }));

  // ── resources ────────────────────────────────────────────────────────────────────────────
  const refOf = (refs: Map<string, number>, id: number): string | null => {
    for (const [reference, target] of refs) if (target === id) return reference;
    return null;
  };

  const customerResource = (reference: string, id: number): Customer => ({
    id,
    reference,
    name: customers.get(id)!.name,
  });

  const locationResource = (reference: string, id: number): ServiceLocation => {
    const site = locations.get(id)!;
    return {
      id,
      reference,
      customer: { id: site.customerId, reference: refOf(customerRefs, site.customerId), name: customers.get(site.customerId)!.name },
      name: site.name,
      addressLine1: site.addressLine1,
      addressLine2: site.addressLine2,
      city: site.city,
      state: site.state,
      zip: site.zip,
    };
  };

  const unitResource = (unit: UnitRow): Equipment => ({
    id: unit.id,
    serialNumber: unit.serialNumber,
    modelNumber: unit.modelNumber,
    name: unit.name,
    serviceLocation: { id: unit.locationId, reference: refOf(locationRefs, unit.locationId) },
  });

  const workOrderResource = (row: WorkOrderRow): WorkOrder => {
    const site = locations.get(row.locationId)!;
    const unit = units.get(row.unitId)!;
    const problemEntry = row.problemId === null ? undefined : PROBLEMS.find((p) => p.id === row.problemId);
    return {
      id: row.id,
      number: row.number,
      externalReference: row.externalReference,
      status: row.status,
      urgency: row.urgency,
      customer: { id: row.customerId, name: customers.get(row.customerId)!.name, reference: refOf(customerRefs, row.customerId) },
      serviceLocation: {
        id: site.id,
        name: site.name,
        reference: refOf(locationRefs, site.id),
        addressLine1: site.addressLine1,
        addressLine2: site.addressLine2,
        city: site.city,
        state: site.state,
        zip: site.zip,
      },
      equipment: { id: unit.id, serialNumber: unit.serialNumber, modelNumber: unit.modelNumber },
      problem: problemEntry ? { id: problemEntry.id, name: problemEntry.name } : null,
      description: row.description,
      isWarranty: row.isWarranty,
      warrantyNumber: row.warrantyNumber,
      createdAt: row.createdAt,
      deadline: row.deadline,
      scheduledServiceAt: row.scheduledServiceAt,
      dispatchedAt: row.dispatchedAt,
      vendorAcceptedAt: row.vendorAcceptedAt,
      assignedAt: row.assignedAt,
      enRouteAt: row.enRouteAt,
      onSiteAt: row.onSiteAt,
      workingAt: row.workingAt,
      completedAt: row.completedAt,
      archivedAt: row.archivedAt,
    };
  };

  // ── matching (one copy of the rules, used by create and by registration) ─────────────────
  /** Sites at the same normalized street line + ZIP, across the WHOLE directory. */
  const sitesAt = (addressLine1: string | null | undefined, zip: string | null | undefined): LocationRow[] => {
    const street = key(addressLine1);
    const zipCode = zipKey(zip);
    if (street === null || zipCode === null) return [];
    return [...locations.values()].filter((l) => key(l.addressLine1) === street && zipKey(l.zip) === zipCode);
  };

  /** Name WITH address — never by name alone: two companies may share a name. */
  const findCustomer = (name: string | null | undefined, address: { addressLine1?: string | null; zip?: string | null } | null, includeOwnAddress: boolean): number | null => {
    const nameKey = key(name);
    if (nameKey === null || address === null) return null;
    const bySite = sitesAt(address.addressLine1, address.zip).find((l) => key(customers.get(l.customerId)!.name) === nameKey);
    if (bySite) return bySite.customerId;
    if (!includeOwnAddress) return null;
    const street = key(address.addressLine1);
    const zipCode = zipKey(address.zip);
    for (const customer of customers.values()) {
      if (key(customer.name) === nameKey && customer.address
        && key(customer.address.addressLine1) === street && zipKey(customer.address.zip) === zipCode) {
        return customer.id;
      }
    }
    return null;
  };

  const findSiteOfCustomer = (customerId: number, address: { addressLine1?: string | null; zip?: string | null }): LocationRow | undefined =>
    sitesAt(address.addressLine1, address.zip).find((l) => l.customerId === customerId);

  const newSite = (customerId: number, input: { name?: string | null; addressLine1: string; addressLine2?: string | null; city: string; state: string; zip: string }): LocationRow => {
    const desired = clean(input.name) ?? clean(input.addressLine1)!;
    const taken = new Set([...locations.values()].filter((l) => l.customerId === customerId).map((l) => key(l.name)));
    let name = desired;
    for (let n = 2; taken.has(key(name)); n++) name = n === 2 ? `${desired} (${clean(input.zip)})` : `${desired} (${n - 1})`;
    const site: LocationRow = {
      id: nextEntityId++,
      customerId,
      name,
      addressLine1: clean(input.addressLine1)!,
      addressLine2: clean(input.addressLine2),
      city: clean(input.city)!,
      state: clean(input.state)!,
      zip: clean(input.zip)!,
    };
    locations.set(site.id, site);
    return site;
  };

  const newUnit = (locationId: number, modelNumber: string, serialNumber: string | null, name: string | null | undefined): UnitRow => {
    const unit: UnitRow = {
      id: nextEntityId++,
      locationId,
      serialNumber,
      modelNumber,
      name: clean(name) ?? modelNumber,
    };
    units.set(unit.id, unit);
    return unit;
  };

  const unitsWithSerial = (serialNumber: string | null | undefined): UnitRow[] => {
    const serial = key(serialNumber);
    return serial === null ? [] : [...units.values()].filter((u) => key(u.serialNumber) === serial);
  };

  // ── registration ─────────────────────────────────────────────────────────────────────────
  app.post(`${ROUTE}/customers`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const body = (request.body ?? {}) as Partial<RegisterCustomerRequest>;
    const errors: Errors = {};
    required(errors, 'reference', body.reference, "A customer reference (the customer's id in your system) is required.");
    required(errors, 'name', body.name, 'Customer name is required.');
    if (body.address != null) {
      required(errors, 'address.addressLine1', body.address.addressLine1, 'Address line 1 is required when an address is sent.');
      required(errors, 'address.city', body.address.city, 'City is required when an address is sent.');
      required(errors, 'address.state', body.address.state, 'State is required when an address is sent.');
      required(errors, 'address.zip', body.address.zip, 'ZIP is required when an address is sent.');
    }
    if (hasErrors(errors)) return validationProblem(reply, errors);

    const reference = clean(body.reference)!;
    const mapped = customerRefs.get(reference);
    if (mapped !== undefined) return replayed(reply, customerResource(reference, mapped));

    let customerId = findCustomer(body.name, body.address ?? null, true);
    if (customerId === null) {
      const address = body.address ? trimAddress(body.address) : null;
      const created: CustomerRow = { id: nextEntityId++, name: clean(body.name)!, address, phone: clean(body.phone) };
      customers.set(created.id, created);
      customerId = created.id;
    }
    customerRefs.set(reference, customerId);
    return created(reply, `${ROUTE}/customers/${encodeURIComponent(reference)}`, customerResource(reference, customerId));
  });

  app.get(`${ROUTE}/customers/:reference`, async (request: FastifyRequest<{ Params: { reference: string } }>, reply) => {
    const id = customerRefs.get(request.params.reference);
    return id === undefined ? notFound(reply, 'customer') : customerResource(request.params.reference, id);
  });

  app.post(`${ROUTE}/service-locations`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const body = (request.body ?? {}) as Partial<RegisterServiceLocationRequest>;
    const errors: Errors = {};
    required(errors, 'reference', body.reference, "A service-location reference (the site's id in your system) is required.");
    required(errors, 'customerReference', body.customerReference, "A customer reference (the customer's id in your system) is required.");
    required(errors, 'addressLine1', body.addressLine1, 'Address line 1 is required.');
    required(errors, 'city', body.city, 'City is required.');
    required(errors, 'state', body.state, 'State is required.');
    required(errors, 'zip', body.zip, 'ZIP is required.');
    if (hasErrors(errors)) return validationProblem(reply, errors);

    const reference = clean(body.reference)!;
    const mapped = locationRefs.get(reference);
    if (mapped !== undefined) return replayed(reply, locationResource(reference, mapped));

    const customerId = customerRefs.get(clean(body.customerReference)!);
    if (customerId === undefined) {
      return validationProblem(reply, {
        customerReference: [
          'No customer of yours is registered under this reference. Register the customer first with POST /manufacturer-api/v1/customers.',
        ],
      });
    }
    const site = findSiteOfCustomer(customerId, body) ?? newSite(customerId, body as RegisterServiceLocationRequest);
    locationRefs.set(reference, site.id);
    return created(reply, `${ROUTE}/service-locations/${encodeURIComponent(reference)}`, locationResource(reference, site.id));
  });

  app.get(`${ROUTE}/service-locations/:reference`, async (request: FastifyRequest<{ Params: { reference: string } }>, reply) => {
    const id = locationRefs.get(request.params.reference);
    return id === undefined ? notFound(reply, 'service location') : locationResource(request.params.reference, id);
  });

  app.post(`${ROUTE}/equipment`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const body = (request.body ?? {}) as Partial<RegisterEquipmentRequest>;
    const errors: Errors = {};
    required(errors, 'serviceLocationReference', body.serviceLocationReference, "A service-location reference (the site's id in your system) is required.");
    required(errors, 'serialNumber', body.serialNumber, 'A serial number is required: it is how this unit is addressed on every later call.');
    required(errors, 'modelNumber', body.modelNumber, 'A model number is required.');
    if (hasErrors(errors)) return validationProblem(reply, errors);

    const siteId = locationRefs.get(clean(body.serviceLocationReference)!);
    if (siteId === undefined) {
      return validationProblem(reply, {
        serviceLocationReference: [
          'No service location of yours is registered under this reference. Register the site first with POST /manufacturer-api/v1/service-locations.',
        ],
      });
    }
    const serialNumber = clean(body.serialNumber)!;
    const same = unitsWithSerial(serialNumber);
    const here = same.find((u) => u.locationId === siteId);
    if (here) return replayed(reply, unitResource(here));
    if (same.length > 0) {
      return problem(reply, 409, 'Serial number already registered elsewhere', 'This serial number is already registered at another service location.');
    }
    const unit = newUnit(siteId, clean(body.modelNumber)!, serialNumber, body.name);
    return created(reply, `${ROUTE}/equipment?serialNumber=${encodeURIComponent(serialNumber)}`, unitResource(unit));
  });

  app.get(`${ROUTE}/equipment`, async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    if (clean(request.query.serialNumber) === null) {
      return validationProblem(reply, { serialNumber: ['A serial number is required.'] });
    }
    return { items: unitsWithSerial(request.query.serialNumber).map(unitResource) };
  });

  // ── problem catalogue ────────────────────────────────────────────────────────────────────
  app.get(`${ROUTE}/problems`, async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const { cursor, limit: rawLimit, equipmentType, search } = request.query;
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return validationProblem(reply, { limit: ['The limit must be between 1 and 500.'] });
    }
    let afterId = 0;
    if (cursor !== undefined) {
      const decoded = decodeCursor('p1', cursor);
      if (decoded === null) {
        return validationProblem(reply, { cursor: ['The cursor is not valid. Read the catalogue from the first page again.'] });
      }
      afterId = decoded;
    }
    const type = clean(equipmentType)?.toLowerCase();
    const term = clean(search)?.toLowerCase();
    const matching = PROBLEMS.filter((p) =>
      p.id > afterId
      && (type === undefined || p.equipmentType?.toLowerCase() === type)
      && (term === undefined || p.name.toLowerCase().includes(term) || (p.code?.toLowerCase().includes(term) ?? false)));
    const items = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    return { items, nextCursor: hasMore ? encodeCursor('p1', items.at(-1)!.id) : null, hasMore } satisfies ProblemPage;
  });

  // ── create ───────────────────────────────────────────────────────────────────────────────
  app.post(`${ROUTE}/work-orders`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const body = (request.body ?? {}) as Partial<CreateWorkOrderRequest>;

    // (1) What is required ALWAYS — reported before the keys are looked up.
    const structural = validateStructure(body);
    if (hasErrors(structural)) return validationProblem(reply, structural);

    // (2) Idempotency: a known externalReference returns the stored work order, unchanged.
    const externalReference = clean(body.externalReference)!;
    const existing = byExternalReference.get(externalReference);
    if (existing !== undefined) return replayed(reply, workOrderResource(workOrders.get(existing)!));

    // (3) Key first: what the body still has to carry depends on which keys are already mapped.
    const customerReference = clean(body.customer!.reference)!;
    const locationReference = clean(body.serviceLocation!.reference)!;
    const mappedCustomer = customerRefs.get(customerReference);
    const mappedSiteId = locationRefs.get(locationReference);
    const mappedSite = mappedSiteId === undefined ? undefined : locations.get(mappedSiteId)!;
    const input = body.serviceLocation!;

    const errors: Errors = {};
    if (mappedCustomer === undefined) {
      required(errors, 'customer.name', body.customer!.name, 'Customer name is required: this customer reference is not mapped yet.');
    }
    if (mappedSite === undefined) {
      const needed = (label: string) => `${label} is required: this service-location reference is not mapped yet.`;
      required(errors, 'serviceLocation.addressLine1', input.addressLine1, needed('Address line 1'));
      required(errors, 'serviceLocation.city', input.city, needed('City'));
      required(errors, 'serviceLocation.state', input.state, needed('State'));
      required(errors, 'serviceLocation.zip', input.zip, needed('ZIP'));
    }
    if (body.problemId != null && !PROBLEMS.some((p) => p.id === body.problemId)) {
      errors.problemId = ['No such problem in the catalogue. Read GET /manufacturer-api/v1/problems for the valid ids.'];
    }
    if (hasErrors(errors)) return validationProblem(reply, errors);

    // (4) Customer: mapped key → by name WITH address → new. A mapped site supplies the address.
    const matchAddress = mappedSite ?? input;
    const existingCustomer = mappedCustomer ?? findCustomer(body.customer!.name, matchAddress, false);
    if (mappedSite && mappedSite.customerId !== existingCustomer) {
      return validationProblem(reply, { 'serviceLocation.reference': ['This service location belongs to a different customer.'] });
    }

    // (5) Unit: serial first, else a single unit of that model at the site; a new unit needs a model.
    const serialNumber = clean(body.equipment?.serialNumber);
    const modelNumber = clean(body.equipment?.modelNumber);
    const candidateSite = mappedSite ?? (existingCustomer === null ? undefined : findSiteOfCustomer(existingCustomer, input));
    let unit: UnitRow | undefined;
    if (candidateSite) {
      const atSite = [...units.values()].filter((u) => u.locationId === candidateSite.id);
      if (serialNumber !== null) unit = atSite.find((u) => key(u.serialNumber) === key(serialNumber));
      else if (modelNumber !== null) {
        const sameModel = atSite.filter((u) => key(u.modelNumber) === key(modelNumber));
        if (sameModel.length === 1) unit = sameModel[0];
      }
    }
    if (!unit && modelNumber === null) {
      return validationProblem(reply, {
        'equipment.modelNumber': ['Model number is required: no unit of yours with this serial number exists at the site.'],
      });
    }

    // (6) Everything checks out: write the new rows and map the keys, then the work order.
    let customerId = existingCustomer;
    if (customerId === null) {
      // A new customer takes the request's address as its own, like in FixFlow.
      const fullAddress = clean(input.addressLine1) && clean(input.city) && clean(input.state) && clean(input.zip);
      const createdCustomer: CustomerRow = {
        id: nextEntityId++,
        name: clean(body.customer!.name)!,
        address: fullAddress ? trimAddress(input as Address) : null,
        phone: clean(body.customer!.phone),
      };
      customers.set(createdCustomer.id, createdCustomer);
      customerId = createdCustomer.id;
    }
    const site = candidateSite ?? newSite(customerId, input as Address & { name?: string | null });
    unit ??= newUnit(site.id, modelNumber!, serialNumber, body.equipment?.name);
    if (mappedCustomer === undefined) customerRefs.set(customerReference, customerId);
    if (mappedSiteId === undefined) locationRefs.set(locationReference, site.id);

    const id = nextWorkOrderId++;
    const row: WorkOrderRow = {
      id,
      number: `WO-${id}`,
      externalReference,
      status: 'New',
      urgency: (body.urgency as Urgency | null | undefined) ?? 'Normal',
      customerId,
      locationId: site.id,
      unitId: unit.id,
      problemId: body.problemId ?? null,
      description: clean(body.description)!,
      isWarranty: body.isWarranty ?? false,
      warrantyNumber: clean(body.warrantyReference),
      createdAt: new Date(now()).toISOString(),
      deadline: body.deadline ?? null,
      scheduledServiceAt: null,
      dispatchedAt: null,
      vendorAcceptedAt: null,
      assignedAt: null,
      enRouteAt: null,
      onSiteAt: null,
      workingAt: null,
      completedAt: null,
      archivedAt: null,
    };
    workOrders.set(id, row);
    byExternalReference.set(externalReference, id);
    return created(reply, `${ROUTE}/work-orders/${id}`, workOrderResource(row));
  });

  // ── reads ────────────────────────────────────────────────────────────────────────────────
  app.get(`${ROUTE}/work-orders/changes`, async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const { cursor, limit: rawLimit, since } = request.query;
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return validationProblem(reply, { limit: ['The limit must be between 1 and 500.'] });
    }

    const servable = servableEntries();
    const head = servable.at(-1)?.id ?? 0;

    let after: number;
    if (cursor !== undefined) {
      const decoded = decodeCursor('v1', cursor);
      if (decoded === null) return validationProblem(reply, { cursor: ['The cursor is not valid.'] });
      after = decoded;
    } else if (since !== undefined) {
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) return validationProblem(reply, { since: ['The since value is not a valid ISO 8601 time.'] });
      const first = servable.find((e) => e.changedAt >= sinceMs);
      after = first ? first.id - 1 : head;
    } else {
      return { items: [], nextCursor: encodeCursor('v1', head), hasMore: false } satisfies ChangePage;
    }

    const selected: number[] = [];
    const changedAt = new Map<number, number>();
    let position = after;
    let reachedLimit = false;
    for (const entry of servable) {
      if (entry.id <= after) continue;
      const known = changedAt.has(entry.workOrderId);
      if (!known && selected.length >= limit) {
        reachedLimit = true;
        break;
      }
      position = entry.id;
      if (!known) selected.push(entry.workOrderId);
      changedAt.set(entry.workOrderId, Math.max(entry.changedAt, changedAt.get(entry.workOrderId) ?? 0));
    }

    return {
      items: selected.map((id) => ({
        ...workOrderResource(workOrders.get(id)!),
        changedAt: new Date(changedAt.get(id)!).toISOString(),
      })),
      nextCursor: encodeCursor('v1', position),
      hasMore: reachedLimit || servable.some((e) => e.id > position),
    } satisfies ChangePage;
  });

  app.get(`${ROUTE}/work-orders/by-reference/:reference`, async (request: FastifyRequest<{ Params: { reference: string } }>, reply) => {
    const id = byExternalReference.get(request.params.reference);
    return id === undefined ? notFound(reply, 'work order') : workOrderResource(workOrders.get(id)!);
  });

  app.get(`${ROUTE}/work-orders/:id`, async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const row = workOrders.get(Number(request.params.id));
    return row ? workOrderResource(row) : notFound(reply, 'work order');
  });

  app.get(`${ROUTE}/work-orders`, async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const ids = splitList(request.query.ids).map(Number);
    const references = splitList(request.query.references);
    if (ids.some((id) => !Number.isInteger(id))) return validationProblem(reply, { ids: ['Every id must be an integer.'] });
    if (ids.length + references.length > 100) {
      return validationProblem(reply, { ids: ['At most 100 ids and references in total.'] });
    }
    const items: WorkOrder[] = [];
    const notFoundIds: number[] = [];
    const notFoundReferences: string[] = [];
    for (const id of new Set(ids)) {
      const row = workOrders.get(id);
      if (row) items.push(workOrderResource(row));
      else notFoundIds.push(id);
    }
    for (const reference of new Set(references)) {
      const id = byExternalReference.get(reference);
      if (id === undefined) notFoundReferences.push(reference);
      else if (!items.some((w) => w.id === id)) items.push(workOrderResource(workOrders.get(id)!));
    }
    return { items, notFound: { ids: notFoundIds, references: notFoundReferences } };
  });

  // ── simulator ────────────────────────────────────────────────────────────────────────────
  function advanceAll(): void {
    const t = now();
    const iso = new Date(t).toISOString();
    for (const row of workOrders.values()) {
      const index = LIFECYCLE.indexOf(row.status);
      if (index < 0 || index === LIFECYCLE.length - 1) continue;
      const next = LIFECYCLE[index + 1]!;
      row.status = next;
      if (next === 'Dispatched') row.dispatchedAt = iso;
      if (next === 'Assigned') {
        row.vendorAcceptedAt = iso;
        row.assignedAt = iso;
        row.scheduledServiceAt = new Date(t + 24 * 3600 * 1000).toISOString();
      }
      if (next === 'EnRoute') row.enRouteAt = iso;
      if (next === 'OnSite') row.onSiteAt = iso;
      if (next === 'Working') row.workingAt = iso;
      if (next === 'Done') row.completedAt = iso;
      journal.push({ id: nextJournalId++, workOrderId: row.id, changedAt: t });
    }
  }

  if (options.simulate ?? true) {
    const timer = setInterval(advanceAll, (options.stepSeconds ?? 15) * 1000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  /** Entries old enough to serve: older than the lag AND below the first entry still inside it. */
  function servableEntries(): JournalEntry[] {
    const ceiling = now() - lagMs;
    const firstYoung = journal.find((e) => e.changedAt > ceiling);
    return journal.filter((e) => e.changedAt <= ceiling && (firstYoung === undefined || e.id < firstYoung.id));
  }

  return { app, advanceAll };
}

/** The fields a work order needs ALWAYS, whatever is already mapped. */
function validateStructure(b: Partial<CreateWorkOrderRequest>): Errors {
  const errors: Errors = {};
  required(errors, 'externalReference', b.externalReference, 'An external reference is required.');
  required(errors, 'customer.reference', b.customer?.reference, "A customer reference (the customer's id in your system) is required.");
  required(errors, 'serviceLocation.reference', b.serviceLocation?.reference, "A service-location reference (the site's id in your system) is required.");
  required(errors, 'description', b.description, 'Description is required.');
  if (b.urgency != null && !(URGENCIES as readonly string[]).includes(b.urgency)) {
    errors.urgency = [`Urgency must be one of ${URGENCIES.join(', ')}.`];
  }
  if (b.deadline != null && !/^\d{4}-\d{2}-\d{2}$/.test(b.deadline)) {
    errors.deadline = ['Deadline must be a date in the yyyy-MM-dd format.'];
  }
  if (b.problemId != null && !Number.isInteger(b.problemId)) {
    errors.problemId = ['The problem id must be an integer.'];
  }
  return errors;
}

// ── normalization: trim, collapse inner whitespace, ignore case; ZIP by its first five digits ──
function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}

function key(value: string | null | undefined): string | null {
  return clean(value)?.toLowerCase() ?? null;
}

function zipKey(value: string | null | undefined): string | null {
  const zip = clean(value);
  if (zip === null) return null;
  return /^\d{5}/.test(zip) ? zip.slice(0, 5) : zip.toLowerCase().replace(/ /g, '');
}

function trimAddress(address: Address): Address {
  return {
    addressLine1: clean(address.addressLine1)!,
    addressLine2: clean(address.addressLine2),
    city: clean(address.city)!,
    state: clean(address.state)!,
    zip: clean(address.zip)!,
  };
}

function required(errors: Errors, path: string, value: unknown, message: string): void {
  if (typeof value !== 'string' || value.trim() === '') errors[path] = [message];
}

function hasErrors(errors: Errors): boolean {
  return Object.keys(errors).length > 0;
}

function encodeCursor(version: string, value: number): string {
  return Buffer.from(`${version}:${value}`, 'utf8').toString('base64url');
}

function decodeCursor(version: string, cursor: string): number | null {
  const match = /^([a-z0-9]+):(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match && match[1] === version ? Number(match[2]) : null;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function created(reply: FastifyReply, location: string, body: unknown): FastifyReply {
  return reply.code(201).header('Location', location).send(body);
}

function replayed(reply: FastifyReply, body: unknown): FastifyReply {
  return reply.code(200).header('Idempotent-Replayed', 'true').send(body);
}

function problem(reply: FastifyReply, status: number, title: string, detail: string): FastifyReply {
  return reply.code(status).type('application/problem+json').send({ title, status, detail } satisfies ProblemDetails);
}

function notFound(reply: FastifyReply, what: string): FastifyReply {
  return problem(reply, 404, 'Not found', `No such ${what}.`);
}

function validationProblem(reply: FastifyReply, errors: Errors): FastifyReply {
  return reply
    .code(422)
    .type('application/problem+json')
    .send({ title: 'Validation failed', status: 422, errors } satisfies ProblemDetails);
}
