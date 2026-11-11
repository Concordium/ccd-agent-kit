import { IdentityWorkflowError, workflowFailure } from '../workflowErrors.js';
import { safeHttpUrl } from '../workflowValidation.js';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Fetch and decode one bounded JSON response without following redirects. */
export async function boundedResponseJson(
  fetcher: typeof fetch,
  urlValue: string,
  options: { method?: 'GET' | 'POST'; body?: string; recovery?: boolean; requiredStatus?: number } = {},
): Promise<unknown> {
  const url = safeHttpUrl(urlValue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: options.method ?? 'GET', redirect: 'manual', signal: controller.signal,
      ...(options.body === undefined ? {} : {
        body: options.body, headers: { 'content-type': 'application/json' },
      }),
    });
    if (options.recovery === true && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
    }
    if (options.requiredStatus !== undefined && response.status !== options.requiredStatus) {
      await response.body?.cancel().catch(() => undefined);
      throw new IdentityWorkflowError('PROVIDER_FAILED');
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new IdentityWorkflowError('PROVIDER_FAILED');
    const reader = response.body?.getReader();
    if (!reader) throw new IdentityWorkflowError('PROVIDER_FAILED');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new IdentityWorkflowError('PROVIDER_FAILED');
      }
      chunks.push(chunk.value);
    }
    const body = JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
    if (!response.ok) {
      throw new IdentityWorkflowError('PROVIDER_FAILED');
    }
    return body;
  } catch (error) {
    throw workflowFailure(error, 'PROVIDER_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
