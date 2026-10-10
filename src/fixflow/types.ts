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

/** Body of `POST /manufacturer-api/v1/work-orders`. */
export interface CreateWorkOrderRequest {
  /** Your own claim or case number. It is the idempotency key. */
  externalReference: string;
  /** The END customer who has the unit on site — not your company. */
  customer: {
    name: string;
    /** Your id for this customer. Once mapped, it always leads to the same FixFlow customer. */
    reference?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  serviceLocation: {
    addressLine1: string;
    city: string;
    state: string;
    zip: string;
    name?: string | null;
    addressLine2?: string | null;
    phone?: string | null;
  };
  equipment: {
    modelNumber: string;
    serialNumber?: string | null;
    name?: string | null;
  };
  description: string;
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
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  equipment: { id: number; serialNumber: string | null; modelNumber: string | null } | null;
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
