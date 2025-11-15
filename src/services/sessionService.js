const redisService = require('./redisService');
const { SessionState } = require('./states');

/**
 * SessionService - Manages session state persistence across Redis and in-memory
 * 
 * STATE FLOW:
 * 1. SEEKING_HANDOFF (default) - AI tries to connect user with human
 * 2a. If user declines handoff → LEAD_CAPTURE - conversational lead capture
 * 2b. If user accepts to give details → CALLBACK_REQUEST - direct lead collection
 * 3a. Once lead captured → NORMAL_CHAT - regular AI assistance
 * 3b. If handoff successful and ended → NORMAL_CHAT - regular AI assistance
 * 
 * PERSISTENCE: All states and cooldown timers stored by persistentUserId in Redis (1h TTL)
 * FALLBACK: In-memory storage when Redis unavailable
 */
class SessionService {
    constructor() {
        // Track session states with cleanup for non-Redis environments
        this.sessions = new Map(); // sessionId -> {state, lastActivity, handoffOffered, lastHandoffTime}
        
        // Start cleanup timer
        this.startCleanupTimer();
    }
    
    /**
     * Start periodic cleanup of old sessions
     */
    startCleanupTimer() {
        setInterval(() => {
            this.cleanupOldSessions();
        }, 60 * 60 * 1000); // 1 hour
        
        console.log('SessionService cleanup timer started');
    }
    
    /**
     * Clean up sessions older than 1 hour
     */
    cleanupOldSessions() {
        const cutoffTime = Date.now() - (60 * 60 * 1000); // 1 hour ago
        let cleanedCount = 0;
        
        for (const [sessionId, sessionData] of this.sessions.entries()) {
            if (sessionData.lastActivity < cutoffTime) {
                this.sessions.delete(sessionId);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`Cleaned up ${cleanedCount} old sessions. Remaining: ${this.sessions.size}`);
        }
        
        if (this.sessions.size > 10000) {
            console.warn(`High session count: ${this.sessions.size}`);
        }
    }
    
    /**
     * Get session data from Redis first, fallback to in-memory, creating if doesn't exist
     */
    async getSession(sessionId, persistentUserId = null) {
        // Try Redis first if we have persistentUserId
        if (persistentUserId && redisService.isConnected) {
            const redisSession = await this.getSessionFromRedis(persistentUserId);
            if (redisSession) {
                // Update in-memory cache
                this.sessions.set(sessionId, redisSession);
                return redisSession;
            }
        }

        // Fallback to in-memory
        if (!this.sessions.has(sessionId)) {
            const defaultSession = {
                state: SessionState.SEEKING_HANDOFF, // Default: try to connect with human
                lastActivity: Date.now(),
                handoffOffered: false,
                lastHandoffTime: null
            };
            this.sessions.set(sessionId, defaultSession);
            
            // Also store in Redis if available
            if (persistentUserId && redisService.isConnected) {
                await this.saveSessionToRedis(persistentUserId, defaultSession);
            }
        }
        return this.sessions.get(sessionId);
    }

    /**
     * Get session data from Redis by persistentUserId
     */
    async getSessionFromRedis(persistentUserId) {
        if (!redisService.isConnected) return null;
        
        try {
            const key = `session_state:${persistentUserId}`;
            const sessionData = await redisService.client.get(key);
            return sessionData ? JSON.parse(sessionData) : null;
        } catch (error) {
            console.error('Error getting session from Redis:', error);
            return null;
        }
    }

    /**
     * Save session data to Redis by persistentUserId with 1h TTL
     */
    async saveSessionToRedis(persistentUserId, sessionData) {
        if (!redisService.isConnected) return false;
        
        try {
            const key = `session_state:${persistentUserId}`;
            await redisService.client.setEx(key, 60 * 60, JSON.stringify(sessionData)); // 1 hour TTL
            return true;
        } catch (error) {
            console.error('Error saving session to Redis:', error);
            return false;
        }
    }
    
    /**
     * Get the current state for a session
     * Also checks Redis for persistent user agent connections
     */
    async getSessionState(sessionId, persistentUserId = null) {
        // First check if persistent user has active agent connection
        if (persistentUserId && redisService.isConnected) {
            const activeSession = await redisService.getActiveSession(persistentUserId);
            if (activeSession) {
                // Update local session state to reflect human connection
                const session = await this.getSession(sessionId, persistentUserId);
                session.state = SessionState.HUMAN_CONNECTED;
                session.persistentUserId = persistentUserId;
                
                // Save updated state to Redis
                await this.saveSessionToRedis(persistentUserId, session);
                return SessionState.HUMAN_CONNECTED;
            }
        }
        
        const session = await this.getSession(sessionId, persistentUserId);
        return session.state;
    }
    
    /**
     * Update session state
     */
    async setSessionState(sessionId, state, persistentUserId = null) {
        const validStates = Object.values(SessionState);
        if (!validStates.includes(state)) {
            console.error(`Invalid state: ${state}. Must be one of: ${validStates.join(', ')}`);
            return;
        }
        
        const previousState = await this.getSessionState(sessionId, persistentUserId);
        const sessionData = await this.getSession(sessionId, persistentUserId);
        sessionData.state = state;
        sessionData.lastActivity = Date.now();
        
        // Save updated state to Redis for persistence across server restarts
        if (persistentUserId && redisService.isConnected) {
            await this.saveSessionToRedis(persistentUserId, sessionData);
        }
        
        console.log(`Session ${sessionId} (user: ${persistentUserId || 'anonymous'}) state changed: ${previousState} → ${state}`);
    }
    
    /**
     * Update last activity for a session
     */
    async updateSessionActivity(sessionId, persistentUserId = null) {
        const session = await this.getSession(sessionId, persistentUserId);
        session.lastActivity = Date.now();
        
        // Save updated activity to Redis for persistence
        if (persistentUserId && redisService.isConnected) {
            await this.saveSessionToRedis(persistentUserId, session);
        }
    }

    /**
     * Check if handoff has been offered for this session
     */
    async hasHandoffBeenOffered(sessionId, persistentUserId = null) {
        const session = await this.getSession(sessionId, persistentUserId);
        return session.handoffOffered;
    }
    
    /**
     * Mark that handoff has been offered for this session
     */
    async markHandoffOffered(sessionId, persistentUserId = null) {
        const session = await this.getSession(sessionId, persistentUserId);
        session.handoffOffered = true;
        
        // Save to Redis for persistence
        if (persistentUserId && redisService.isConnected) {
            await this.saveSessionToRedis(persistentUserId, session);
        }
    }

    /**
     * Check if user can request LIVE CHAT handoff again (1+ hour since last live chat)
     * Note: Callback requests are always allowed regardless of cooldown
     */
    async canRequestHandoffAgain(sessionId, persistentUserId = null) {
        const session = await this.getSession(sessionId, persistentUserId);
        
        // If no previous live chat handoff, can request
        if (!session.lastHandoffTime) {
            return true;
        }
        
        // Check if 1 hour has passed since last LIVE CHAT
        const now = Date.now();
        const oneHourMs = 60 * 60 * 1000;
        const timeSinceLastHandoff = now - session.lastHandoffTime;
        
        const canRequest = timeSinceLastHandoff >= oneHourMs;
        
        if (canRequest) {
            console.log(`Session ${sessionId} (user: ${persistentUserId || 'anonymous'}) can request live chat again (${Math.floor(timeSinceLastHandoff / (60 * 60 * 1000))} hours since last live chat)`);
        } else {
            const minutesLeft = Math.ceil((oneHourMs - timeSinceLastHandoff) / (60 * 1000));
            console.log(`Session ${sessionId} (user: ${persistentUserId || 'anonymous'}) live chat cooldown active (${minutesLeft} minutes remaining)`);
        }
        
        return canRequest;
    }
    
    /**
     * Check if current time is within business hours (9 AM - 5 PM AEST, Monday to Friday)
     * Saturday and Sunday are considered after hours
     */
    isWithinBusinessHours() {
        const now = new Date();
        const australianTime = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Sydney" }));
        const hours = australianTime.getHours();
        const day = australianTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

        // Check if it's a weekday (Monday to Friday) and within business hours
        // Weekends (Saturday=6, Sunday=0) are always considered after hours
        const isWeekday = day >= 1 && day <= 5;
        const isBusinessTime = hours >= 9 && hours < 17;

        return isWeekday && isBusinessTime;
    }

    // Public API methods for external use
    async markHumanHandoffDeclined(sessionId, persistentUserId = null) {
        await this.setSessionState(sessionId, SessionState.LEAD_CAPTURE, persistentUserId);
        console.log(`Session ${sessionId} declined human handoff - switching to LEAD_CAPTURE state`);
    }
    
    async markCallbackRequested(sessionId, persistentUserId = null) {
        await this.setSessionState(sessionId, SessionState.CALLBACK_REQUEST, persistentUserId);
        console.log(`Session ${sessionId} requested callback - switching to CALLBACK_REQUEST state`);
    }

    async markLeadCaptured(sessionId, persistentUserId = null) {
        await this.setSessionState(sessionId, SessionState.NORMAL_CHAT, persistentUserId);
        console.log(`Session ${sessionId} lead captured - switching to NORMAL_CHAT state`);
    }

    async markHumanHandoffAccepted(sessionId, persistentUserId = null) {
        // Record when LIVE CHAT handoff was accepted - blocks new live chats for 1 hour
        // (Callback requests are not blocked)
        const session = await this.getSession(sessionId, persistentUserId);
        session.lastHandoffTime = Date.now();
        
        // Save the handoff timestamp to Redis before state change
        if (persistentUserId && redisService.isConnected) {
            await this.saveSessionToRedis(persistentUserId, session);
        }
        
        await this.setSessionState(sessionId, SessionState.NORMAL_CHAT, persistentUserId);
        console.log(`Session ${sessionId} (user: ${persistentUserId || 'anonymous'}) accepted LIVE CHAT handoff - switching to NORMAL_CHAT state, live chat blocked for 1h`);
    }
}

module.exports = new SessionService();