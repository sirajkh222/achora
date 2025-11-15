const redisService = require('./redisService');

class MemoryService {
    constructor() {
        // Now using Redis for conversation history with 1-hour auto-cleanup
        this.contextWindowLength = 5; // Keep last 5 interactions
        this.conversationTTL = 3600; // 1 hour = 3600 seconds
        
        console.log('💬 MemoryService initialized with Redis (1-hour fresh start)');
    }
    
    /**
     * Start periodic cleanup of old conversations
     */
    startCleanupTimer() {
        // Clean up conversations older than 7 days every 6 hours
        setInterval(() => {
            this.cleanupOldConversations();
        }, 6 * 60 * 60 * 1000); // 6 hours
        
        console.log('🧹 MemoryService cleanup timer started');
    }
    
    /**
     * Clean up conversations older than 7 days
     */
    async cleanupOldConversations() {
        if (!redisService.isConnected) return;
        
        try {
            // Clean up old conversation keys
            const keys = await redisService.client.keys('conversation:*');
            console.log(`🧹 Found ${keys.length} conversation keys in Redis`);
            
            // Redis TTL handles cleanup automatically, but we can log status
            if (keys.length > 1000) {
                console.warn(`⚠️ High conversation count: ${keys.length}`);
            }
        } catch (error) {
            console.error('Error during conversation cleanup:', error);
        }
    }

    async getConversationHistory(identifier) {
        if (!redisService.isConnected) return [];
        
        try {
            // Try as persistentUserId first
            let key = `conversation:${identifier}`;
            let conversationData = await redisService.client.get(key);
            
            if (!conversationData) {
                // It might be a sessionId, try to find persistentUserId
                const persistentUserId = await redisService.getSessionMapping(identifier);
                if (persistentUserId) {
                    key = `conversation:${persistentUserId}`;
                    conversationData = await redisService.client.get(key);
                }
            }
            
            if (conversationData) {
                return JSON.parse(conversationData);
            }
            return [];
        } catch (error) {
            console.error('Error getting conversation history:', error);
            return [];
        }
    }

    async addMessage(sessionId, userMessage, botResponse, persistentUserId = null) {
        if (!redisService.isConnected) return;
        
        try {
            // Use persistentUserId if available, otherwise fall back to sessionId
            const identifier = persistentUserId || sessionId;
            
            // Get existing conversation history from dedicated conversation key
            const key = `conversation:${identifier}`;
            let history = [];
            
            const existingData = await redisService.client.get(key);
            if (existingData) {
                history = JSON.parse(existingData);
            }
            
            // Add the new interaction in OpenAI format
            history.push({
                role: 'user',
                content: userMessage
            });
            
            history.push({
                role: 'assistant',
                content: botResponse
            });
            
            // Keep only the last N interactions (context window = 5 interactions = 10 messages)
            if (history.length > this.contextWindowLength * 2) {
                history = history.slice(-this.contextWindowLength * 2);
            }
            
            // Store conversation history with TTL in dedicated key
            await redisService.client.setEx(key, this.conversationTTL, JSON.stringify(history));
            
            // Also create session mapping if persistentUserId provided
            if (persistentUserId) {
                await redisService.setSessionMapping(sessionId, persistentUserId, this.conversationTTL);
                console.log(`💬 Memory updated for user ${persistentUserId} (session ${sessionId}):`, history.length / 2, 'interactions stored [1hr TTL]');
            } else {
                console.log(`💬 Memory updated for session ${sessionId}:`, history.length / 2, 'interactions stored [1hr TTL]');
            }
        } catch (error) {
            console.error('Error adding message to memory:', error);
        }
    }

    async getMessagesForOpenAI(sessionId, newMessage, persistentUserId = null) {
        // Use persistentUserId if available for getting conversation history
        const identifier = persistentUserId || sessionId;
        const history = await this.getConversationHistory(identifier);
        
        // Build messages array for OpenAI (system prompt added by aiService)
        const messages = [];
        
        // Add conversation history
        messages.push(...history);
        
        // Add the new user message
        messages.push({
            role: 'user',
            content: newMessage
        });
        
        return messages;
    }

    async clearSession(sessionId, persistentUserId = null) {
        if (!redisService.isConnected) return;
        
        try {
            // Clear conversation history from dedicated key
            if (persistentUserId) {
                const key = `conversation:${persistentUserId}`;
                await redisService.client.del(key);
                console.log(`🗺️ User ${persistentUserId} memory cleared`);
            } else {
                // Try to find persistentUserId from sessionId mapping
                const mappedUserId = await redisService.getSessionMapping(sessionId);
                if (mappedUserId) {
                    const key = `conversation:${mappedUserId}`;
                    await redisService.client.del(key);
                    console.log(`🗺️ Session ${sessionId} memory cleared via persistentUserId ${mappedUserId}`);
                } else {
                    // Clear by sessionId as fallback
                    const key = `conversation:${sessionId}`;
                    await redisService.client.del(key);
                    console.log(`🗺️ Session ${sessionId} memory cleared directly`);
                }
            }
        } catch (error) {
            console.error('Error clearing session memory:', error);
        }
    }
}

module.exports = new MemoryService();