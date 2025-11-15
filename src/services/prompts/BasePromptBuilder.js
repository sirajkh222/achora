const memoryService = require('../memoryService');

/**
 * Base class for all prompt builders containing shared logic
 */
class BasePromptBuilder {
    constructor(contextWeights) {
        this.contextWeights = contextWeights;
    }

    /**
     * Build simplified role section
     */
    buildRoleSection() {
        return `You are a support specialist at Achora. You ONLY discuss Achora and our team.

CRITICAL RULES:
- NEVER mention NDIS directly
- NEVER recommend contacting anyone except Achora
- NEVER suggest other providers, services, or organizations
- ONLY talk about Achora's services and connecting with our team
- When you don't have specific information, offer to connect them with our team

Keep responses positive and solution-focused, focusing exclusively on Achora.`;
    }

    /**
     * Build knowledge context section
     */
    buildKnowledgeContext(searchResult) {
        if (!searchResult.context) {
            return ``;
        }

        let context = `KNOWLEDGE: ${searchResult.context}`;

        if (searchResult.urls?.length) {
            context += `\n\nAVAILABLE LINKS: ${searchResult.urls.join(', ')}`;
            context += `\nIMPORTANT: Include the most relevant link(s) from above in your response to help the user learn more. Always include at least one link when available.`;
        }

        return context;
    }

    /**
     * Build simplified output rules section
     */
    buildOutputRules() {
        return `Rules: Use bullet points (•), max 5 bullet points per response, Australian spelling, focus only on Achora services, ONLY include links if they were provided in the AVAILABLE LINKS section above - NEVER create or guess URLs, ask follow-up question. Keep tone positive and helpful.`;
    }

    /**
     * Static method to calculate context weights for creating prompt builder instances
     */
    static calculateContextWeights(searchResult, currentState, sessionId) {
        const conversationHistory = memoryService.getConversationHistory(sessionId) || [];
        
        // Knowledge base relevance (0-10)
        let knowledgeRelevance = 0;
        if (searchResult.context) {
            knowledgeRelevance = Math.min(10, Math.round((searchResult.bestScore || 0) * 10));
            if (searchResult.highPriorityCount > 0) knowledgeRelevance += 2;
            if (searchResult.categoryMatches > 0) knowledgeRelevance += 1;
            knowledgeRelevance = Math.min(10, knowledgeRelevance);
        }
        
        // Session state priority (0-10)
        const { SessionState } = require('../states');
        const statePriorities = {
            [SessionState.CALLBACK_REQUEST]: 10, // Highest - collecting contact details
            [SessionState.LEAD_CAPTURE]: 8,     // High - trying to capture lead
            [SessionState.SEEKING_HANDOFF]: 6,  // Medium - looking for handoff opportunities
            [SessionState.NORMAL_CHAT]: 4       // Lower - just general conversation
        };
        const statePriority = statePriorities[currentState] || 5;
        
        // Conversation depth (0-10)
        const messageCount = conversationHistory.length;
        let conversationDepth = Math.min(10, Math.round(messageCount / 2));
        
        return {
            knowledgeRelevance,
            statePriority,
            conversationDepth
        };
    }
}

module.exports = BasePromptBuilder;