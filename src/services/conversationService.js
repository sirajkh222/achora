const OpenAI = require('openai');
const memoryService = require('./memoryService');
const pineconeService = require('./pineconeServiceV2');
const PromptFactory = require('./prompts/PromptFactory');
const openaiRetryService = require('./openaiRetryService');
const { SessionState } = require('./states');

class ConversationService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    /**
     * Generate AI conversation response with RAG integration
     */
    async generateResponse(message, sessionId, currentState, persistentUserId = null) {
        try {
            // State-aware optimization: different processing based on session state
            switch (currentState) {
                case SessionState.CALLBACK_REQUEST:
                    return await this.generateCallbackRequestResponse(message, sessionId, persistentUserId);
                
                case SessionState.LEAD_CAPTURE:
                    return await this.generateLeadCaptureResponse(message, sessionId, persistentUserId);
                    
                case SessionState.HUMAN_CONNECTED:
                    // This shouldn't happen as humans handle these, but fallback
                    return await this.generateSimpleResponse(message, sessionId, persistentUserId);
                    
                case SessionState.NORMAL_CHAT:
                    return await this.generateNormalChatResponse(message, sessionId, persistentUserId);
                    
                case SessionState.SEEKING_HANDOFF:
                default:
                    // Full processing with handoff analysis
                    return await this.generateFullResponse(message, sessionId, currentState, persistentUserId);
            }
        } catch (error) {
            console.error('OpenAI API error in conversation service:', error);
            throw new Error('Failed to get AI response');
        }
    }

    /**
     * Full response generation with all features (for SEEKING_HANDOFF state)
     */
    async generateFullResponse(message, sessionId, currentState, persistentUserId = null) {
        // Run classification, Pinecone search, and memory retrieval in parallel
        const [shouldSearch, messages] = await Promise.all([
            // GPT classification to determine if we need knowledge search
            this.shouldSearchKnowledgeBase(message, currentState),
            
            // Get conversation history in parallel
            memoryService.getMessagesForOpenAI(sessionId, message, persistentUserId)
        ]);
        
        // Now run Pinecone search if needed (can't be fully parallel since it depends on shouldSearch result)
        const searchResult = shouldSearch ? 
            await pineconeService.searchKnowledge(message) : 
            { context: null, urls: [], bestScore: 0, totalMatches: 0 };

        if (shouldSearch) {
            console.log('Knowledge base search completed in parallel');
        } else {
            console.log('Skipped knowledge base search for simple interaction');
        }

        // Build system prompt using new PromptFactory
        const systemPrompt = PromptFactory.buildPrompt(currentState, searchResult, sessionId);
        
        // Prepend system message instead of overwriting first message
        messages.unshift({
            role: 'system',
            content: systemPrompt
        });

        console.log(`Search Results: ${searchResult.totalMatches || 0} total matches, ${searchResult.rankedResults || 0} ranked, ${searchResult.highPriorityCount || 0} high priority, ${searchResult.categoryMatches || 0} category matches. Best score: ${(searchResult.bestScore || 0).toFixed(3)}. Sending ${messages.length} messages to OpenAI for session ${sessionId}`);

        // Generate AI response using GPT-4o for better quality with retry logic
        const apiCall = async () => {
            return await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                max_completion_tokens: 500,
                temperature: 0.7
            });
        };

        const completion = await openaiRetryService.retryWithBackoff(apiCall);
        const botResponse = completion.choices[0].message.content;
        
        await memoryService.addMessage(sessionId, message, botResponse, persistentUserId);

        return {
            response: botResponse,
            searchResult: searchResult
        };
    }

    /**
     * CALLBACK_REQUEST state - progressive lead collection using new prompt system
     */
    async generateCallbackRequestResponse(message, sessionId, persistentUserId = null) {
        // Skip knowledge search for lead collection, get conversation history
        const messages = await memoryService.getMessagesForOpenAI(sessionId, message, persistentUserId);
        
        // Use simple PromptFactory for CALLBACK_REQUEST state
        const searchResult = { context: null, urls: [], bestScore: 0, totalMatches: 0 };
        const systemPrompt = PromptFactory.buildPrompt(SessionState.CALLBACK_REQUEST, searchResult, sessionId);

        messages.unshift({ role: 'system', content: systemPrompt });

        console.log(`CALLBACK_REQUEST state - simple progressive collection for session ${sessionId}`);

        const completion = await openaiRetryService.retryWithBackoff(async () => {
            return await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                max_completion_tokens: 400,
                temperature: 0.7
            });
        });

        const botResponse = completion.choices[0].message.content;
        await memoryService.addMessage(sessionId, message, botResponse, persistentUserId);

        return {
            response: botResponse,
            searchResult: { context: null, urls: [], bestScore: 0, totalMatches: 0 }
        };
    }

    /**
     * LEAD_CAPTURE state - build rapport and suggest callback (NO contact collection)
     */
    async generateLeadCaptureResponse(message, sessionId, persistentUserId = null) {
        // Use knowledge search for LEAD_CAPTURE since we're answering questions
        const [shouldSearch, messages] = await Promise.all([
            this.shouldSearchKnowledgeBase(message, SessionState.LEAD_CAPTURE),
            memoryService.getMessagesForOpenAI(sessionId, message, persistentUserId)
        ]);
        
        const searchResult = shouldSearch ? 
            await pineconeService.searchKnowledge(message) : 
            { context: null, urls: [], bestScore: 0, totalMatches: 0 };

        // Use proper PromptFactory for LEAD_CAPTURE state (rapport building, not collection)
        const systemPrompt = PromptFactory.buildPrompt(SessionState.LEAD_CAPTURE, searchResult, sessionId);

        messages.unshift({ role: 'system', content: systemPrompt });

        console.log(`LEAD_CAPTURE state - building rapport and suggesting callback for session ${sessionId}`);

        const completion = await openaiRetryService.retryWithBackoff(async () => {
            return await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                max_completion_tokens: 400,
                temperature: 0.7
            });
        });

        const botResponse = completion.choices[0].message.content;
        await memoryService.addMessage(sessionId, message, botResponse, persistentUserId);

        return {
            response: botResponse,
            searchResult: searchResult
        };
    }

    /**
     * Optimized response for NORMAL_CHAT state (regular chat, no handoff)
     */
    async generateNormalChatResponse(message, sessionId, persistentUserId = null) {
        // Fast classification and processing for normal chat
        const [shouldSearch, messages] = await Promise.all([
            this.shouldSearchKnowledgeBase(message, SessionState.NORMAL_CHAT),
            memoryService.getMessagesForOpenAI(sessionId, message, persistentUserId)
        ]);
        
        const searchResult = shouldSearch ? 
            await pineconeService.searchKnowledge(message) : 
            { context: null, urls: [], bestScore: 0, totalMatches: 0 };

        // Simplified prompt for normal chat (no handoff analysis needed)
        const systemPrompt = PromptFactory.buildPrompt(SessionState.NORMAL_CHAT, searchResult, sessionId);
        
        messages.unshift({ role: 'system', content: systemPrompt });

        console.log(`NORMAL_CHAT state - no handoff analysis needed for session ${sessionId}`);

        const completion = await openaiRetryService.retryWithBackoff(async () => {
            return await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                max_completion_tokens: 500,
                temperature: 0.7
            });
        });

        const botResponse = completion.choices[0].message.content;
        await memoryService.addMessage(sessionId, message, botResponse, persistentUserId);

        return {
            response: botResponse,
            searchResult: searchResult
        };
    }

    /**
     * Simple response for fallback cases
     */
    async generateSimpleResponse(message, sessionId, persistentUserId = null) {
        const messages = await memoryService.getMessagesForOpenAI(sessionId, message, persistentUserId);
        
        messages.unshift({
            role: 'system',
            content: 'You are a helpful assistant for Achora. Provide brief, helpful responses. Use Australian spelling.'
        });

        const completion = await openaiRetryService.retryWithBackoff(async () => {
            return await this.openai.chat.completions.create({
                model: "gpt-4o-mini", // Use faster model for simple cases
                messages: messages,
                max_completion_tokens: 200,
                temperature: 0.7
            });
        });

        const botResponse = completion.choices[0].message.content;
        await memoryService.addMessage(sessionId, message, botResponse, persistentUserId);

        return {
            response: botResponse,
            searchResult: { context: null, urls: [], bestScore: 0, totalMatches: 0 }
        };
    }

    /**
     * Determine if we should search the knowledge base for this message using optimized GPT classification
     */
    async shouldSearchKnowledgeBase(message, currentState) {
        // Skip knowledge base search for obvious contact details during lead capture
        if (currentState === SessionState.CALLBACK_REQUEST) {
            const isObviousContactDetail = this.isContactDetail(message.toLowerCase().trim());
            if (isObviousContactDetail) {
                console.log('Skipping knowledge base search for contact detail during lead capture');
                return false;
            }
        }

        // Use optimized GPT classification - faster model and simpler prompt
        try {
            const classification = await this.openai.chat.completions.create({
                model: "gpt-4o", // Fastest, cheapest model for classification
                messages: [{
                    role: "system",
                    content: `You are classifying messages for Achora (NDIS provider). Reply only "SKIP" or "SEARCH".

SKIP only for: "hi", "hello", "thanks", "bye", "yes", "no", "ok", "who are you"
SEARCH for everything else including:
- Any questions about services, supports, programs, activities
- Meal prep, cleaning, transport, therapy, accommodation
- NDIS plans, funding, eligibility, applications
- "What does X contain/include", "How does X work", "Tell me about X"

When in doubt, always SEARCH. Better to search unnecessarily than miss helping someone.`
                }, {
                    role: "user",
                    content: message
                }],
                max_tokens: 100, // Minimal tokens needed
                temperature: 0 // Consistent responses
            });

            const decision = classification.choices[0]?.message?.content?.trim() || 'SEARCH';
            
            if (decision.includes('SKIP')) {
                console.log('GPT classified as casual conversation - skipping knowledge base search');
                return false;
            } else {
                console.log('GPT classified as potential NDIS query - searching knowledge base');
                return true;
            }

        } catch (error) {
            console.error('GPT classification failed, defaulting to search:', error.message);
            // Safety fallback - always search if GPT fails
            return true;
        }
    }

    /**
     * Detect obvious contact details that don't need knowledge base search
     */
    isContactDetail(message) {
        const patterns = [
            // Email patterns
            /^\S+@\S+\.\S+$/,                    // Standard email format
            /^no\s+its?\s+\S+@\S+\.\S+$/,       // "no its email@domain.com"
            /^actually\s+its?\s+\S+@\S+\.\S+$/, // "actually it's email@domain.com"
            
            // Phone number patterns  
            /^04\d{8}$/,                         // Mobile: 0412345678
            /^0[2378]\d{8}$/,                    // Landline: 0298765432
            /^\d{8,12}$/,                        // General phone number
            /^\+61\d{9,10}$/,                    // International format
            
            // Name patterns (first or last name responses)
            /^[a-zA-Z]{2,20}$/,                  // Single name like "John" or "Smith"
            /^[a-zA-Z\s]{2,30}$/,                // Full name like "John Smith"
            
            // Simple confirmation responses during lead capture
            /^(yes|yeah|yep|no|nope|correct|wrong|right)$/,
            /^(ok|okay|sure|thanks?)$/,
            /^that'?s\s+(correct|right|wrong)$/
        ];
        
        return patterns.some(pattern => pattern.test(message.trim()));
    }
}

module.exports = new ConversationService();