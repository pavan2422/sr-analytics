/**
 * Checks if an upload session is ready (status === 'completed' and has storedFileId).
 * This prevents 404 errors by ensuring the session exists before making API calls.
 */
async function checkSessionReady(uploadId: string, maxWaitRetries: number = 20): Promise<boolean> {
  for (let attempt = 0; attempt < maxWaitRetries; attempt++) {
    try {
      const res = await fetch(`/api/uploads/${uploadId}`, { method: 'GET' });
      if (res.ok) {
        const session = await res.json();
        if (session?.status === 'completed' && session?.storedFileId) {
          return true;
        }
      }
    } catch {
      // Continue retrying
    }
    // Wait before next check (exponential backoff: 200ms, 300ms, 400ms, etc.)
    await new Promise(resolve => setTimeout(resolve, 200 + (attempt * 100)));
  }
  return false;
}

/**
 * Helper function to retry API calls with exponential backoff for 404 errors.
 * This is useful for serverless environments where database writes might be eventually consistent.
 * 
 * For upload-related endpoints, it will first wait for the session to be ready before making the call.
 */
export async function retryApiCall<T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  isRetryable: (error: any) => boolean = (e) => {
    const msg = String(e?.message || '');
    return msg.includes('404') || 
           msg.includes('not found') || 
           msg.includes('Upload session not found') ||
           msg.includes('(404)');
  },
  uploadId?: string // If provided, wait for session to be ready first
): Promise<T> {
  // If uploadId is provided, wait for session to be ready before making the call
  if (uploadId) {
    const sessionReady = await checkSessionReady(uploadId);
    if (!sessionReady) {
      console.warn(`Session ${uploadId} not ready after waiting, proceeding anyway...`);
    }
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (isRetryable(error) && attempt < maxRetries - 1) {
        // If it's a 404 and we have an uploadId, check session readiness again
        if (uploadId && attempt === 0) {
          const sessionReady = await checkSessionReady(uploadId, 10);
          if (sessionReady) {
            // Session is now ready, retry immediately
            continue;
          }
        }
        // Exponential backoff: 1s, 2s, 3s, 4s, 5s
        const delay = 1000 * (attempt + 1);
        console.warn(`API call failed (404), retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('Failed after retries');
}

