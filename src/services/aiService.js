// Refactored as thin orchestrator
const sessionService = require('./sessionService');
const handoffService = require('./handoffService');
const conversationService = require('./conversationService');
const memoryService = require('./memoryService');
const { SessionState } = require('./states');

class AIService {
    constructor() {
        // Expose SessionState for backward compatibility
        this.SessionState = SessionState;
    }
    
    /**
     * Main chat response method - orchestrates the conversation flow
     */

    async getChatResponse(message, sessionId, persistentUserId = null) {
        try {
            await this.updateSessionActivity(sessionId, persistentUserId);
            
            // Check session state including Redis for persistent users
            const currentState = await this.getSessionState(sessionId, persistentUserId);
            
            // If human is connected, don't process through AI
            if (currentState === this.SessionState.HUMAN_CONNECTED) {
                return {
                    message: "You're currently connected to a human agent. They should respond shortly.",
                    shouldHandoff: false
                };
            }
            
            // Handle LEAD_CAPTURE state - user agreement transitions to CALLBACK_REQUEST
            if (currentState === this.SessionState.LEAD_CAPTURE) {
                const agreementPatterns = [
                    /\b(yes|yeah|yep|sure|okay|ok|absolutely|definitely|of course)\b/i,
                    /\b(i would like|i'd like|that sounds good|sounds good|please)\b/i,
                    /\b(go ahead|let's do it|let's do that)\b/i
                ];
                
                const userAgreed = agreementPatterns.some(pattern => pattern.test(message.toLowerCase()));
                
                if (userAgreed) {
                    console.log(`User agreed to provide details in LEAD_CAPTURE - transitioning to CALLBACK_REQUEST`);
                    
                    // Transition state and let AI generate natural response
                    await this.setSessionState(sessionId, this.SessionState.CALLBACK_REQUEST, persistentUserId);
                    // Continue to normal AI response generation below
                }
            }
            
            // Handle contact detail collection in CALLBACK_REQUEST state
            if (currentState === this.SessionState.CALLBACK_REQUEST) {
                // Skip processing the initial callback request message
                if (message === "I would like to request a callback. Can you please help me schedule a call?") {
                    // Let AI handle this naturally - continue to normal response generation
                } else {
                    // Let AI handle lead capture through normal conversation flow
                    // Lead capture is handled in chatController after AI response
                }
            }
            
            console.log(`Session ${sessionId} state: ${currentState}`);
            
            // Get current state once to avoid multiple calls
            const sessionState = await sessionService.getSessionState(sessionId, persistentUserId);
            
            // Generate conversation response
            const { response: botResponse, searchResult } = await conversationService.generateResponse(
                message, 
                sessionId, 
                sessionState,
                persistentUserId
            );

            // Analyze for handoff only in SEEKING_HANDOFF state
            let handoffAnalysis = { action: 'continue_ai', reason: 'Not in SEEKING_HANDOFF state' };
            
            if (sessionState === SessionState.SEEKING_HANDOFF) {
                // Pass whether knowledge base had any matching context
                handoffAnalysis = await handoffService.analyzeResponseForHandoff(
                    message, 
                    botResponse, 
                    sessionId, 
                    !!searchResult.context,
                    persistentUserId
                );
            }
            
            console.log(`Handoff analysis for session ${sessionId}: ${handoffAnalysis.action} - ${handoffAnalysis.reason}`);

            // Return handoff suggestion if triggered
            if (handoffAnalysis.action === 'human_handoff') {
                await this.markHandoffOffered(sessionId, persistentUserId);
                return {
                    type: 'human_handoff_suggestion',
                    message: botResponse,
                    suggestion: "It seems like you might benefit from speaking with one of our office. Would you like me to connect you with someone from our team?",
                    reason: handoffAnalysis.reason
                };
            }

            // Return normal AI response
            return botResponse;
            
        } catch (error) {
            console.error('OpenAI API error:', error);
            throw new Error('Failed to get AI response');
        }
    }
    
    // Delegate session management methods to sessionService
    async getSessionState(sessionId, persistentUserId = null) {
        return await sessionService.getSessionState(sessionId, persistentUserId);
    }
    
    async setSessionState(sessionId, state, persistentUserId = null) {
        return await sessionService.setSessionState(sessionId, state, persistentUserId);
    }
    
    async updateSessionActivity(sessionId, persistentUserId = null) {
        return await sessionService.updateSessionActivity(sessionId, persistentUserId);
    }
    
    async hasHandoffBeenOffered(sessionId, persistentUserId = null) {
        return await sessionService.hasHandoffBeenOffered(sessionId, persistentUserId);
    }
    
    async markHandoffOffered(sessionId, persistentUserId = null) {
        return await sessionService.markHandoffOffered(sessionId, persistentUserId);
    }
    
    async canRequestHandoffAgain(sessionId, persistentUserId = null) {
        return await sessionService.canRequestHandoffAgain(sessionId, persistentUserId);
    }
    
    isWithinBusinessHours() {
        return sessionService.isWithinBusinessHours();
    }
    
    async markHumanHandoffDeclined(sessionId, persistentUserId = null) {
        return await sessionService.markHumanHandoffDeclined(sessionId, persistentUserId);
    }
    
    async markCallbackRequested(sessionId, persistentUserId = null) {
        return await sessionService.markCallbackRequested(sessionId, persistentUserId);
    }
    
    async markLeadCaptured(sessionId, persistentUserId = null) {
        return await sessionService.markLeadCaptured(sessionId, persistentUserId);
    }
    
    async markHumanHandoffAccepted(sessionId, persistentUserId = null) {
        return await sessionService.markHumanHandoffAccepted(sessionId, persistentUserId);
    }
    
    // Expose internal methods for backward compatibility  
    async getSession(sessionId, persistentUserId = null) {
        return await sessionService.getSession(sessionId, persistentUserId);
    }
    
    // Keep cleanup timer methods for backward compatibility
    startCleanupTimer() {
        // Delegated to sessionService constructor
        console.log('AIService cleanup timer delegated to SessionService');
    }
    
    cleanupOldSessions() {
        return sessionService.cleanupOldSessions();
    }
}

module.exports = new AIService();
