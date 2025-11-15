const OpenAI = require('openai');
const sessionService = require('./sessionService');
const { SessionState } = require('./states');
const openaiRetryService = require('./openaiRetryService');

class HandoffService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    /**
     * Analyze conversation for handoff triggers
     */
    async analyzeResponseForHandoff(userMessage, aiResponse, sessionId, hasKnowledgeMatch = true, persistentUserId = null) {
        const currentState = await sessionService.getSessionState(sessionId, persistentUserId);
        
        // Fast state-based early returns - skip expensive OpenAI calls
        switch (currentState) {
            case SessionState.CALLBACK_REQUEST:
                return { action: 'continue_ai', reason: 'CALLBACK_REQUEST state - focusing on lead collection' };
            
            case SessionState.LEAD_CAPTURE:
                return { action: 'continue_ai', reason: 'LEAD_CAPTURE state - conversational lead capture mode' };
            
            case SessionState.HUMAN_CONNECTED:
                return { action: 'continue_ai', reason: 'HUMAN_CONNECTED state - agent handling conversation' };
            
            case SessionState.NORMAL_CHAT:
                // Check if 24 hours have passed since last handoff
                const canRequestHandoff = await sessionService.canRequestHandoffAgain(sessionId, persistentUserId);
                if (!canRequestHandoff) {
                    return { action: 'continue_ai', reason: 'NORMAL_CHAT state - handoff cooldown active' };
                }
                // If cooldown expired, reset to SEEKING_HANDOFF and continue analysis
                await sessionService.setSessionState(sessionId, SessionState.SEEKING_HANDOFF, persistentUserId);
                console.log(`Session ${sessionId} cooldown expired - reset to SEEKING_HANDOFF state`);
                break;
                
            case SessionState.SEEKING_HANDOFF:
                // Continue with handoff analysis below
                break;
                
            default:
                console.warn(`Unknown session state: ${currentState}`);
                return { action: 'continue_ai', reason: `Unknown session state: ${currentState}` };
        }
        
        // Only reach here if in SEEKING_HANDOFF state or cooldown expired
        
        // Check if handoff has already been offered this session
        if (await sessionService.hasHandoffBeenOffered(sessionId, persistentUserId)) {
            return { 
                action: 'continue_ai', 
                reason: 'Human handoff already offered' 
            };
        }
        
        // Regex removed - let AI handle ALL detection for better accuracy
        
        // Skip casual interaction check - let full AI analysis handle everything for better accuracy
        
        // Use OpenAI to analyze the conversation for handoff triggers
        const shouldOfferHandoff = await this.analyzeConversationForHandoff(userMessage, aiResponse, hasKnowledgeMatch, sessionId, persistentUserId);
        
        if (shouldOfferHandoff.shouldOffer) {
            // Don't mark handoff offered yet - wait for user response
            return { 
                action: 'human_handoff', 
                reason: shouldOfferHandoff.reason 
            };
        }
        
        return { action: 'continue_ai', reason: 'No handoff triggers detected' };
    }

    /**
     * Quick GPT check for simple casual interactions that don't need handoff analysis
     */
    async isSimpleCasualInteraction(userMessage, aiResponse) {
        try {
            const check = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: [{
                    role: "system", 
                    content: `Is this a simple casual interaction that doesn't need human handoff? Reply only "YES" or "NO".

YES for: greetings, thanks, basic pleasantries, simple acknowledgments like "hey", "hi", "thanks", "ok"
NO for: questions about services, complex requests, problems, anything needing help`
                }, {
                    role: "user",
                    content: `User message: "${userMessage}"`
                }],
                max_tokens: 3,
                temperature: 0
            });

            const result = check.choices[0]?.message?.content?.trim() || 'NO';
            return result.includes('YES');

        } catch (error) {
            console.error('Simple interaction check failed:', error.message);
            // If check fails, proceed with full handoff analysis for safety
            return false;
        }
    }

    /**
     * Use OpenAI to analyze if the conversation should trigger a handoff offer
     */
    async analyzeConversationForHandoff(userMessage, aiResponse, hasKnowledgeMatch, sessionId = null, persistentUserId = null) {
        // Get conversation history to check for previous connection offers
        const memoryService = require('./memoryService');
        const conversationHistory = await memoryService.getConversationHistory(persistentUserId || sessionId) || [];

        // Look for the last bot message (previous response) to check if it offered connection
        const lastBotMessage = conversationHistory
            .filter(msg => msg.role === 'assistant')
            .slice(-1)[0]; // Most recent bot message

        const previousBotResponse = lastBotMessage ? lastBotMessage.content : '';

        const analysisPrompt = `You're analyzing a chat for Achora (NDIS provider) to decide when to connect users with our team.

BUSINESS GOAL: Connect engaged users with our team when there's a real opportunity to help them.

USER MESSAGE: "${userMessage}"
CURRENT BOT RESPONSE: "${aiResponse}"
PREVIOUS BOT RESPONSE: "${previousBotResponse}"
KNOWLEDGE BASE HAD MATCH: ${hasKnowledgeMatch ? 'Yes' : 'No'}

CRITICAL PRIORITY 1: If the PREVIOUS BOT RESPONSE offered to connect the user with the team, and the user responds positively ("yeah", "yes", "sure", "go for it", "sounds good", "yes please", "okay", "ok"), ALWAYS return shouldOffer: true. This overrides ALL other considerations.

CRITICAL PRIORITY 2: If the user directly agrees to a connection offer from the previous bot response, IGNORE response quality - they want human help regardless.

IMPORTANT: Only evaluate BOT'S RESPONSE QUALITY if there was NO connection offer:
- If the bot provided specific, helpful information with relevant links/details, DON'T offer handoff
- If the bot gave vague, unhelpful, or incomplete answers, DO offer handoff
- If the knowledge base had NO MATCH and the user's message is NOT a simple greeting/casual conversation, offer handoff

Look for these triggers:

1. CONVERSATION ENDING: User expressing satisfaction/gratitude after receiving help (thanks, cheers, goodbye, that's awesome, that's great, perfect, brilliant, wonderful, amazing, excellent, fantastic, appreciate it, helpful) - ALWAYS offer for future support
2. NO KNOWLEDGE MATCH: Knowledge base couldn't answer AND it's not just casual chat - ALWAYS offer
3. EXPLICIT REQUESTS: User directly asks to speak to someone - ALWAYS offer
4. STRONG ENGAGEMENT SIGNALS: Detailed questions about specific NDIS services, "I need help with", "how do I get started"
5. COMPLEXITY INDICATORS: Plan management, support coordination, funding applications, personal assessments
6. FRUSTRATION/URGENCY: Clear frustration, confusion, or urgency
7. AI LIMITATION: Bot response indicates human assistance would be better
8. HANDOFF ACCEPTANCE: User agrees when AI offers connection

CONVERSATION CONTEXT:
Consider the conversation flow and user intent. When a user shows satisfaction or gratitude after receiving helpful information (saying things like "thanks", "that's awesome", "perfect", "great", etc.), this signals they're satisfied but is a PRIME opportunity to offer human connection for any future personalized assistance.

AVOID HANDOFF FOR:
- Opening pleasantries or initial greetings
- Mid-conversation acknowledgments  
- Questions where the bot provided comprehensive, helpful answers with specific information and links
- General NDIS questions that were answered well by the knowledge base

Respond with JSON only:
{
    "shouldOffer": true/false,
    "reason": "Brief explanation",
    "triggerType": "conversation_ending|no_knowledge|explicit|engagement|complexity|frustration|acceptance|ai_limitation"
}`;

        try {
            const apiCall = async () => {
                return await this.openai.chat.completions.create({
                    model: "gpt-4o", // Much faster and cheaper for classification
                    messages: [
                        { role: "system", content: "You are analyzing customer service conversations for handoff decisions. Respond with JSON only." },
                        { role: "user", content: analysisPrompt }
                    ],
                    max_tokens: 80, // Reduced tokens for faster response
                    temperature: 0 // Deterministic for classification
                });
            };

            const completion = await openaiRetryService.retryWithBackoff(apiCall);

            let analysisText = completion.choices[0].message.content.trim();
            console.log('OpenAI Handoff Analysis:', analysisText);
            
            // Remove markdown code blocks if present
            if (analysisText.startsWith('```json')) {
                analysisText = analysisText.replace(/```json\s*/, '').replace(/\s*```$/, '').trim();
            } else if (analysisText.startsWith('```')) {
                analysisText = analysisText.replace(/```\s*/, '').replace(/\s*```$/, '').trim();
            }
            
            const analysis = JSON.parse(analysisText);
            
            // Trust OpenAI's decision directly
            return {
                shouldOffer: analysis.shouldOffer,
                reason: analysis.reason,
                triggerType: analysis.triggerType
            };
            
        } catch (error) {
            console.error('Error in OpenAI handoff analysis:', error);
            
            // Enhanced fallback with sophisticated NLP analysis
            return this.enhancedFallbackAnalysis(userMessage, aiResponse, hasKnowledgeMatch);
        }
    }

    /**
     * Enhanced fallback analysis with sophisticated NLP patterns
     */
    enhancedFallbackAnalysis(userMessage, aiResponse, hasKnowledgeMatch) {
        const userLower = userMessage.toLowerCase();
        const aiLower = aiResponse.toLowerCase();
        
        // Sophisticated pattern analysis
        const patterns = {
            // Direct human requests with context awareness
            explicitRequests: {
                patterns: [
                    /\b(speak|talk|connect|put me through)\s+(to|with)\s+(someone|human|person|agent|staff|team|specialist)\b/i,
                    /\b(can|could|would)\s+(i|you)\s+(speak|talk|connect)\s+(to|with)\s+(someone|human|agent)\b/i,
                    /\b(need|want)\s+(to\s+)?(speak|talk|connect)\s+(to|with)\s+(someone|human|agent)\b/i,
                    /\b(human|person|agent|representative|specialist)\s+(please|help|contact|call)\b/i
                ],
                weight: 10,
                reason: 'Direct human connection request detected'
            },
            
            // Conversation ending with gratitude (prime handoff opportunity)
            conversationEnding: {
                patterns: [
                    /\b(thanks?|thank you|cheers|brilliant|awesome|great|perfect|wonderful|amazing|excellent|fantastic|appreciate)\b.*\b(help|information|info)\b/i,
                    /\bthat'?s?\s+(great|awesome|perfect|brilliant|wonderful|helpful|exactly what i needed)\b/i,
                    /\b(perfect|great|awesome|brilliant|thanks?)\s*[.!]*\s*$/i
                ],
                weight: 9,
                reason: 'User expressing satisfaction - prime opportunity for future support offer'
            },
            
            // No knowledge match with specific questions
            knowledgeGap: {
                condition: () => !hasKnowledgeMatch,
                patterns: [
                    /\b(how do i|how can i|what do i need|where do i|when do i)\b/i,
                    /\b(specific|detail|step|process|application|apply|eligibility|qualify)\b/i,
                    /\b(my situation|my case|my circumstances|personal|individual)\b/i
                ],
                weight: 8,
                reason: 'Specific question without knowledge base match'
            },
            
            // Strong engagement indicators
            strongEngagement: {
                patterns: [
                    /\bi'?m?\s+(interested|looking|considering|thinking about|wanting)\b/i,
                    /\b(help|assist|support)\s+me\s+(with|to|understand)\b/i,
                    /\b(get started|begin|start)\s+(with|the process)\b/i,
                    /\bwhat'?s?\s+(next|the process|involved|required)\b/i
                ],
                weight: 7,
                reason: 'Strong engagement and interest signals'
            },
            
            // Complexity indicators
            complexity: {
                patterns: [
                    /\b(plan management|support coordination|core supports|capacity building)\b/i,
                    /\b(funding|budget|allocation|review|assessment)\b/i,
                    /\b(complex|complicated|confusing|overwhelming|difficult)\b/i,
                    /\b(ndis plan|support plan|goals|outcomes)\b/i
                ],
                weight: 7,
                reason: 'Complex NDIS topics requiring personalized guidance'
            },
            
            // Emotional indicators (frustration/urgency)
            emotionalTriggers: {
                patterns: [
                    /\b(frustrated|stuck|confused|lost|overwhelmed|stressed|worried|anxious)\b/i,
                    /\b(urgent|asap|quickly|soon|time sensitive|deadline)\b/i,
                    /\b(don'?t understand|makes no sense|unclear|vague)\b/i,
                    /\b(struggling|difficulty|trouble|problem|issue)\b/i
                ],
                weight: 8,
                reason: 'Emotional indicators suggest need for human support'
            },
            
            // AI limitation indicators
            aiLimitation: {
                patterns: [
                    /\b(still not clear|still confused|doesn'?t help|not specific enough)\b/i,
                    /\b(need more|want details|be more specific|tell me more)\b/i
                ],
                aiPatterns: [
                    /\b(recommend|suggest|might want to)\s+(speaking|talking|contacting)\b/i,
                    /\b(human|specialist|team member)\s+(would|could|can)\s+(help|assist|provide)\b/i,
                    /\bi\s+(don'?t|can'?t)\s+(have|provide)\s+(specific|detailed)\b/i
                ],
                weight: 6,
                reason: 'AI acknowledging limitations or suggesting human help'
            },
            
            // Handoff acceptance patterns
            handoffAcceptance: {
                patterns: [
                    /\b(yes|yeah|yep|sure|okay|ok|absolutely|definitely|of course|please)\b/i,
                    /\b(sounds? good|that would be great|i'?d like that|yes please)\b/i,
                    /\b(go ahead|let'?s do it|that works|perfect)\b/i
                ],
                condition: () => aiLower.includes('connect') || aiLower.includes('speak') || aiLower.includes('team'),
                weight: 10,
                reason: 'User accepted AI offer to connect with team'
            }
        };
        
        let maxWeight = 0;
        let bestReason = 'No clear triggers detected';
        let triggerType = null;
        
        // Analyze each pattern category
        for (const [category, config] of Object.entries(patterns)) {
            let categoryTriggered = false;
            
            // Check condition if exists
            if (config.condition && !config.condition()) {
                continue;
            }
            
            // Check user message patterns
            if (config.patterns) {
                categoryTriggered = config.patterns.some(pattern => pattern.test(userMessage));
            }
            
            // Check AI response patterns if they exist
            if (config.aiPatterns && !categoryTriggered) {
                categoryTriggered = config.aiPatterns.some(pattern => pattern.test(aiResponse));
            }
            
            // Update best match
            if (categoryTriggered && config.weight > maxWeight) {
                maxWeight = config.weight;
                bestReason = config.reason;
                triggerType = category;
            }
        }
        
        // Decision threshold
        const shouldOffer = maxWeight >= 7;
        
        console.log(`Enhanced fallback analysis: weight=${maxWeight}, trigger=${triggerType}, reason=${bestReason}`);
        
        return {
            shouldOffer,
            reason: `Enhanced: ${bestReason}`,
            triggerType,
            confidence: maxWeight / 10
        };
    }
}

module.exports = new HandoffService();