const { SessionState } = require('../states');
const BasePromptBuilder = require('./BasePromptBuilder');
const SeekingHandoffPrompt = require('./SeekingHandoffPrompt');
const CallbackRequestPrompt = require('./CallbackRequestPrompt');
const LeadCapturePrompt = require('./LeadCapturePrompt');
const NormalChatPrompt = require('./NormalChatPrompt');

/**
 * Factory class to create appropriate prompt builders based on session state
 */
class PromptFactory {
    /**
     * Get the appropriate prompt builder for the given session state
     * @param {string} sessionState - Current session state
     * @param {Object} searchResult - Knowledge base search results
     * @param {string} sessionId - Session ID for conversation history
     * @returns {BasePromptBuilder} - State-specific prompt builder instance
     */
    static getPromptBuilder(sessionState, searchResult, sessionId) {
        // Calculate context weights using the static method from BasePromptBuilder
        const contextWeights = BasePromptBuilder.calculateContextWeights(
            searchResult, 
            sessionState, 
            sessionId
        );

        // Create appropriate prompt builder based on session state
        switch (sessionState) {
            case SessionState.SEEKING_HANDOFF:
                return new SeekingHandoffPrompt(contextWeights);
                
            case SessionState.CALLBACK_REQUEST:
                return new CallbackRequestPrompt(contextWeights);
                
            case SessionState.LEAD_CAPTURE:
                return new LeadCapturePrompt(contextWeights);
                
            case SessionState.NORMAL_CHAT:
                return new NormalChatPrompt(contextWeights);
                
            default:
                console.warn(`Unexpected session state in PromptFactory: ${sessionState}`);
                // Fallback to normal chat prompt for unexpected states
                return new NormalChatPrompt(contextWeights);
        }
    }

    /**
     * Build a complete prompt for the given session state
     * @param {string} sessionState - Current session state
     * @param {Object} searchResult - Knowledge base search results
     * @param {string} sessionId - Session ID for conversation history
     * @param {Object} leadStatus - Lead capture status (optional, for CALLBACK_REQUEST)
     * @param {Array} collected - Collected lead data (optional, for CALLBACK_REQUEST)
     * @returns {string} - Complete prompt string
     */
    static buildPrompt(sessionState, searchResult, sessionId, leadStatus = null, collected = []) {
        const promptBuilder = this.getPromptBuilder(sessionState, searchResult, sessionId);
        
        // CallbackRequestPrompt needs additional parameters
        if (sessionState === SessionState.CALLBACK_REQUEST) {
            return promptBuilder.buildPrompt(searchResult, leadStatus, collected);
        }
        
        // All other prompt builders use the standard buildPrompt method
        return promptBuilder.buildPrompt(searchResult);
    }
}

module.exports = PromptFactory;