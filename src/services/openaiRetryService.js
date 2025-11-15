/**
 * Adds resilience to OpenAI calls with exponential backoff retry logic
 */
class OpenAIRetryService {
    constructor() {
        this.maxRetries = 3;
        this.baseDelay = 1000; // 1 second base delay
    }

    /**
     * Retry OpenAI API calls with exponential backoff
     */
    async retryWithBackoff(apiCall, retries = this.maxRetries) {
        try {
            return await apiCall();
        } catch (error) {
            if (retries === 0 || !this.isRetryableError(error)) {
                throw error;
            }

            const delay = this.baseDelay * Math.pow(2, this.maxRetries - retries);
            console.log(`OpenAI API error, retrying in ${delay}ms. Retries left: ${retries - 1}. Error: ${error.message}`);
            
            await this.sleep(delay);
            return this.retryWithBackoff(apiCall, retries - 1);
        }
    }

    /**
     * Check if error is retryable
     */
    isRetryableError(error) {
        // Retry on rate limiting, temporary server errors, and network issues
        const retryableCodes = [429, 500, 502, 503, 504];
        return retryableCodes.includes(error.status) || 
               error.code === 'ECONNRESET' || 
               error.code === 'ETIMEDOUT' ||
               error.message?.includes('timeout');
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new OpenAIRetryService();