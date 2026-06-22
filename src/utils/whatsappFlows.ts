/**
 * Programmatic client for the WhatsApp Flows API.
 *
 * Wraps every management endpoint documented at
 * https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi so
 * flows can be created, updated, published, deprecated and deleted from code
 * instead of the Flow Builder UI. The flow contents themselves are supplied as
 * Flow JSON (see `src/constants/orderFlow.ts` for an example).
 *
 * Auth uses the system token as a Bearer header. Create/list operations are
 * WhatsApp Business Account-scoped: the WABA id is read from the active tenant
 * (`Tenant.whatsappBusinessId`) resolved from the AsyncLocalStorage tenant
 * context, so these must run inside `runWithTenant()`.
 */
import axios from 'axios';
import type { Method } from 'axios';

import { CONFIG } from '../config.js';
import { getTenantId } from '../context/tenantContext.js';
import Tenant from '../models/Tenant.js';
import { logger } from '../services/logger.js';
import UTILS from './index.js';

const TAG = '[WHATSAPP-FLOWS]';

// Graph API version used for Flows endpoints. Kept in step with the messaging
// controller (`outgoingMessages.ts`).
const FLOWS_API_VERSION = 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${FLOWS_API_VERSION}`;

/**
 * Valid flow categories. At least one is required when creating a flow.
 * @see https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
 */
export const FLOW_CATEGORIES = [
  'SIGN_UP',
  'SIGN_IN',
  'APPOINTMENT_BOOKING',
  'LEAD_GENERATION',
  'CONTACT_US',
  'CUSTOMER_SUPPORT',
  'SURVEY',
  'OTHER',
] as const;

export type FlowCategory = (typeof FLOW_CATEGORIES)[number];

export type FlowStatus = 'DRAFT' | 'PUBLISHED' | 'DEPRECATED' | 'BLOCKED' | 'THROTTLED';

/**
 * Flow JSON input: any object (e.g. a readonly `as const` template like
 * `ORDER_FLOW_JSON`) or a pre-stringified document.
 */
export type FlowJsonInput = object | string;

const toFlowJsonString = (flowJson: FlowJsonInput): string =>
  typeof flowJson === 'string' ? flowJson : JSON.stringify(flowJson);

/** A single validation error returned by Meta when validating Flow JSON. */
export interface FlowValidationError {
  error: string;
  error_type: string;
  message: string;
  line_start?: number;
  line_end?: number;
  column_start?: number;
  column_end?: number;
  pointers?: Array<{ line_start?: number; line_end?: number; path?: string }>;
}

export interface CreateFlowParams {
  /** Human-readable name for the flow. */
  name: string;
  /** One or more flow categories. */
  categories: FlowCategory[];
  /** Flow JSON contents. Passed as an object or a pre-stringified document. */
  flowJson?: FlowJsonInput;
  /** Publish the flow immediately on creation (requires valid `flowJson`). */
  publish?: boolean;
  /** Clone an existing flow instead of starting from `flowJson`. */
  cloneFlowId?: string;
  /** Endpoint URI for flows that use a data-exchange endpoint. */
  endpointUri?: string;
}

export interface CreateFlowResponse {
  id: string;
  success?: boolean;
  validation_errors?: FlowValidationError[];
}

export interface UpdateFlowMetadataParams {
  name?: string;
  categories?: FlowCategory[];
  endpointUri?: string;
  applicationId?: string;
}

export interface FlowDetails {
  id: string;
  name: string;
  status: FlowStatus;
  categories: FlowCategory[];
  validation_errors?: FlowValidationError[];
  json_version?: string;
  data_api_version?: string;
  endpoint_uri?: string;
  preview?: { preview_url: string; expires_at: string };
  health_status?: unknown;
  [key: string]: unknown;
}

export interface ListFlowsResponse {
  data: FlowDetails[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string };
}

/** Discriminated result so callers never have to wrap calls in try/catch. */
export type FlowApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; validationErrors?: FlowValidationError[] };

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${CONFIG.WHATSAPP_SYSTEM_TOKEN}`,
});

/**
 * Resolve the active tenant's WhatsApp Business Account id (the WABA id used by
 * WABA-scoped Flows endpoints). Reads `whatsappBusinessId` off the tenant in the
 * current context — throws if there is no tenant context or it isn't set.
 */
const resolveWabaId = async (): Promise<string> => {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new Error(
      'No tenant context — flow create/list must run inside runWithTenant().',
    );
  }
  const tenant = await Tenant.findById(tenantId).select('whatsappBusinessId').lean();
  if (!tenant?.whatsappBusinessId) {
    throw new Error(
      `Tenant ${tenantId} has no whatsappBusinessId (WABA id) configured.`,
    );
  }
  return tenant.whatsappBusinessId;
};

/**
 * Performs a Flows API request and normalises success/error handling so every
 * public method can simply `return request(...)`.
 */
interface RequestOptions {
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
}

const request = async <T>(
  method: Method,
  path: string,
  options: RequestOptions = {},
): Promise<FlowApiResult<T>> => {
  try {
    const response = await axios({
      method,
      url: `${GRAPH_BASE_URL}/${path}`,
      headers: { ...authHeaders(), ...options.headers },
      params: options.params,
      data: options.data,
    });

    const body = response.data;
    // Meta returns 200 with a `validation_errors` array when Flow JSON is
    // syntactically accepted but semantically invalid; surface that as failure.
    if (Array.isArray(body?.validation_errors) && body.validation_errors.length > 0) {
      logger.warn(`${TAG}: ${method} ${path} returned validation errors`, body.validation_errors);
      return {
        success: false,
        error: 'Flow JSON validation failed',
        validationErrors: body.validation_errors,
      };
    }

    return { success: true, data: body as T };
  } catch (err: unknown) {
    if (UTILS.isFacebookAPIError(err)) {
      const fbError = err.response.data.error;
      logger.error(`${TAG}: ${method} ${path} failed:`, fbError.message);
      return { success: false, error: fbError.message };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`${TAG}: ${method} ${path} failed:`, message);
    return { success: false, error: message };
  }
};

/**
 * Create a new flow. Returns the new flow id (and any validation errors when
 * `publish` is requested with invalid Flow JSON).
 * POST /{WABA_ID}/flows
 */
const createFlow = async (
  params: CreateFlowParams,
): Promise<FlowApiResult<CreateFlowResponse>> => {
  let wabaId: string;
  try {
    wabaId = await resolveWabaId();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
  const data: Record<string, unknown> = {
    name: params.name,
    categories: params.categories,
  };
  if (params.flowJson !== undefined) {
    data.flow_json = toFlowJsonString(params.flowJson);
  }
  if (params.publish !== undefined) {
    data.publish = params.publish;
  }
  if (params.cloneFlowId) {
    data.clone_flow_id = params.cloneFlowId;
  }
  if (params.endpointUri) {
    data.endpoint_uri = params.endpointUri;
  }

  return request<CreateFlowResponse>('POST', `${wabaId}/flows`, { data });
};

/**
 * Update a flow's metadata (name, categories, endpoint, application).
 * Only allowed while the flow is in DRAFT status.
 * POST /{FLOW_ID}
 */
const updateFlowMetadata = async (
  flowId: string,
  params: UpdateFlowMetadataParams,
): Promise<FlowApiResult<{ success: boolean }>> => {
  const data: Record<string, unknown> = {};
  if (params.name !== undefined) {
    data.name = params.name;
  }
  if (params.categories !== undefined) {
    data.categories = params.categories;
  }
  if (params.endpointUri !== undefined) {
    data.endpoint_uri = params.endpointUri;
  }
  if (params.applicationId !== undefined) {
    data.application_id = params.applicationId;
  }

  return request<{ success: boolean }>('POST', flowId, { data });
};

/**
 * Upload/replace the flow's Flow JSON. Sent as multipart/form-data per the API
 * contract (name="flow.json", asset_type="FLOW_JSON", file=<json>).
 * POST /{FLOW_ID}/assets
 */
const updateFlowJson = async (
  flowId: string,
  flowJson: FlowJsonInput,
): Promise<FlowApiResult<{ success: boolean; validation_errors?: FlowValidationError[] }>> => {
  const json = toFlowJsonString(flowJson);

  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([json], { type: 'application/json' }), 'flow.json');

  // axios sets the multipart Content-Type (with boundary) from the FormData.
  return request('POST', `${flowId}/assets`, { data: form });
};

/**
 * Publish a flow. Once published the Flow JSON can no longer be changed.
 * POST /{FLOW_ID}/publish
 */
const publishFlow = async (flowId: string): Promise<FlowApiResult<{ success: boolean }>> =>
  request<{ success: boolean }>('POST', `${flowId}/publish`);

/**
 * Update a flow's Flow JSON and publish it in one step — the bare-minimum
 * "make this new JSON live" operation.
 *
 * Uploads the new JSON, then publishes only if the upload validated cleanly.
 * If validation fails the publish is skipped and the validation errors are
 * returned, so a broken document can never go live.
 */
const updateFlow = async (
  flowId: string,
  flowJson: FlowJsonInput,
): Promise<FlowApiResult<{ success: boolean }>> => {
  const updated = await updateFlowJson(flowId, flowJson);
  if (!updated.success) {
    return updated;
  }
  return publishFlow(flowId);
};

/**
 * Deprecate a published flow so it can no longer be sent or opened.
 * POST /{FLOW_ID}/deprecate
 */
const deprecateFlow = async (flowId: string): Promise<FlowApiResult<{ success: boolean }>> =>
  request<{ success: boolean }>('POST', `${flowId}/deprecate`);

/**
 * Delete a flow. Only flows in DRAFT status can be deleted.
 * DELETE /{FLOW_ID}
 */
const deleteFlow = async (flowId: string): Promise<FlowApiResult<{ success: boolean }>> =>
  request<{ success: boolean }>('DELETE', flowId);

/**
 * List all flows on the WhatsApp Business Account.
 * GET /{WABA_ID}/flows
 */
const listFlows = async (): Promise<FlowApiResult<ListFlowsResponse>> => {
  let wabaId: string;
  try {
    wabaId = await resolveWabaId();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
  return request<ListFlowsResponse>('GET', `${wabaId}/flows`);
};

/**
 * Fetch a flow's details. Defaults to the full documented field set.
 * GET /{FLOW_ID}?fields=...
 */
const getFlow = async (
  flowId: string,
  fields: string[] = [
    'id',
    'name',
    'status',
    'categories',
    'validation_errors',
    'json_version',
    'data_api_version',
    'endpoint_uri',
    'preview',
    'health_status',
  ],
): Promise<FlowApiResult<FlowDetails>> =>
  request<FlowDetails>('GET', flowId, { params: { fields: fields.join(',') } });

/**
 * List a flow's assets (e.g. the uploaded flow.json).
 * GET /{FLOW_ID}/assets
 */
interface FlowAsset {
  name: string;
  asset_type: string;
  download_url: string;
}

const getFlowAssets = async (
  flowId: string,
): Promise<FlowApiResult<{ data: FlowAsset[] }>> =>
  request('GET', `${flowId}/assets`);

/**
 * Get a web-preview URL for the flow. Pass `invalidate=true` to mint a fresh
 * URL and revoke the previous one.
 * GET /{FLOW_ID}?fields=preview.invalidate(<bool>)
 */
const getFlowPreview = async (
  flowId: string,
  invalidate = false,
): Promise<FlowApiResult<{ id: string; preview: { preview_url: string; expires_at: string } }>> =>
  request('GET', flowId, { params: { fields: `preview.invalidate(${invalidate})` } });

const whatsappFlows = {
  createFlow,
  updateFlowMetadata,
  updateFlowJson,
  updateFlow,
  publishFlow,
  deprecateFlow,
  deleteFlow,
  listFlows,
  getFlow,
  getFlowAssets,
  getFlowPreview,
};

export {
  createFlow,
  updateFlowMetadata,
  updateFlowJson,
  updateFlow,
  publishFlow,
  deprecateFlow,
  deleteFlow,
  listFlows,
  getFlow,
  getFlowAssets,
  getFlowPreview,
};

export default whatsappFlows;
