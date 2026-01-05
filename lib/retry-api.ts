/**
 * Helper function to retry API calls with exponential backoff for 404 errors.
 * This is useful for serverless environments where database writes might be eventually consistent.
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
  }
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (isRetryable(error) && attempt < maxRetries - 1) {
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

