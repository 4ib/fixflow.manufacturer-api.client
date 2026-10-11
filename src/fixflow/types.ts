/**
 * Types of the FixFlow Manufacturer API v1 contract.
 *
 * They mirror the schemas of `contract/openapi.v1.json` (the published OpenAPI document). Within v1
 * FixFlow only ever ADDS fields, so treat unknown fields as normal and ignore them.
 */

/** The eight work-order statuses of v1. The set is part of the public contract. */
export const WORK_ORDER_STATUSES = [
  'New',
  'Dispatched',
  'Assigned',
  'EnRoute',
  'OnSite',
  'Working',
  'Done',
  'Rejected',
] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const URGENCIES = ['Low', 'Normal', 'Emergency'] as const;

export type Urgency = (typeof URGENCIES)[number];

/** `GET /manufacturer-api/v1/key` — who the key belongs to. */
export interface KeyInfo {
  manufacturer: { id: number; name: string };
  key: { name: string; prefix: string; createdAt: string; lastUsedAt: string | null };
}

/** A postal address. When an address is sent, all four required parts must be there. */
export interface Address {
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  addressLine2?: string | null;
}

// ── Your directory ───────────────────────────────────────────────────────────────────────────

/**
 * Body of `POST /manufacturer-api/v1/customers`. `reference` is YOUR id for the end customer; it is
 * the idempotency key and, from then on, the only thing you need to send to address this customer.
 */
export interface RegisterCustomerRequest {
  reference: string;
  name: string;
  /** Lets FixFlow find a customer it already has (name WITH address). Without it a new one is made. */
  address?: Address | null;
  phone?: string | null;
}

/** The customer resource: FixFlow's id, your reference, the name FixFlow keeps. */
export interface Customer {
  id: number;
  reference: string;
  name: string;
}

/** Body of `POST /manufacturer-api/v1/service-locations` — a site of a customer you registered. */
export interface RegisterServiceLocationRequest {
  /** YOUR id for the site. */
  reference: string;
  /** The reference of a customer you registered before. */
  customerReference: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  name?: string | null;
  addressLine2?: string | null;
  phone?: string | null;
}

/** The service-location resource. */
export interface ServiceLocation {
  id: number;
  reference: string;
  customer: { id: number; reference: string | null; name: string };
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** Body of `POST /manufacturer-api/v1/equipment` — one of your units at a registered site. */
export interface RegisterEquipmentRequest {
  serviceLocationReference: string;
  /** The unit's key: required here, it is how the unit is addressed on every later call. */
  serialNumber: string;
  modelNumber: string;
  name?: string | null;
}

/** The equipment resource. `serviceLocation.reference` is null for a site you never mapped. */
export interface Equipment {
  id: number;
  serialNumber: string | null;
  modelNumber: string | null;
  name: string;
  serviceLocation: { id: number; reference: string | null };
}

/** `GET /manufacturer-api/v1/equipment?serialNumber=…`. */
export interface EquipmentList {
  items: Equipment[];
}

/** One entry of FixFlow's problem catalogue. Send its `id` as `problemId` on a work order. */
export interface Problem {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  equipmentType: string | null;
}

/** `GET /manufacturer-api/v1/problems`. `nextCursor` is null on the last page. */
export interface ProblemPage {
  items: Problem[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ── Work orders ──────────────────────────────────────────────────────────────────────────────

/**
 * Body of `POST /manufacturer-api/v1/work-orders`.
 *
 * Resolution is KEY FIRST: `customer.reference` and `serviceLocation.reference` are always required,
 * and once FixFlow knows a key, the other fields of that part are not needed (and ignored if sent).
 * `customer.name` is needed only for a new customer key, the address only for a new site key, and
 * `equipment.modelNumber` only when no unit of yours with that serial number is at the site.
 */
export interface CreateWorkOrderRequest {
  /** Your own claim or case number. It is the idempotency key. */
  externalReference: string;
  /** The END customer who has the unit on site — not your company. */
  customer: {
    reference: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  serviceLocation: {
    reference: string;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    name?: string | null;
    addressLine2?: string | null;
    phone?: string | null;
  };
  equipment: {
    serialNumber?: string | null;
    modelNumber?: string | null;
    name?: string | null;
  };
  description: string;
  /** An entry of the problem catalogue (`GET /problems`). Optional. */
  problemId?: number | null;
  urgency?: Urgency | null;
  isWarranty?: boolean | null;
  warrantyReference?: string | null;
  purchaseOrder?: string | null;
  /** Date, `yyyy-MM-dd`. */
  deadline?: string | null;
  onSiteContact?: { name?: string | null; phone?: string | null } | null;
}

/** The work-order resource v1. All moments are UTC ISO-8601 with `Z`. */
export interface WorkOrder {
  id: number;
  number: string;
  externalReference: string | null;
  status: WorkOrderStatus;
  urgency: Urgency;
  customer: { id: number; name: string; reference: string | null };
  serviceLocation: {
    id: number;
    name: string;
    /** Your key for this site, or null if you never mapped it. */
    reference: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  equipment: { id: number; serialNumber: string | null; modelNumber: string | null } | null;
  problem: { id: number; name: string } | null;
  description: string | null;
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

/** One item of the change feed: the CURRENT snapshot of a work order plus when it last changed. */
export interface WorkOrderChange extends WorkOrder {
  changedAt: string;
}

/** `GET /manufacturer-api/v1/work-orders/changes`. */
export interface ChangePage {
  items: WorkOrderChange[];
  /** Pass it back verbatim on the next call. Opaque — do not parse it. */
  nextCursor: string;
  /** More changes are ready right now: call again without waiting. */
  hasMore: boolean;
}

/** `GET /manufacturer-api/v1/work-orders?ids=…&references=…`. */
export interface WorkOrderBatch {
  items: WorkOrder[];
  /** Requested ids/references that are unknown OR not visible to you — FixFlow does not tell them apart. */
  notFound: { ids: number[]; references: string[] };
}

/** RFC 9457 problem details, the body of every error response. */
export interface ProblemDetails {
  type?: string | null;
  title?: string | null;
  status?: number | null;
  detail?: string | null;
  instance?: string | null;
  /** Validation errors (`422`): JSON path of the field → messages. */
  errors?: Record<string, string[]>;
}
