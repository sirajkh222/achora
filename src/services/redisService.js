const redis = require('redis');

class RedisService {
    constructor() {
        this.client = null;
        this.publisher = null;
        this.subscriber = null;
        this.isConnected = false;
    }

    async connect() {
        try {
            const redisUrl = process.env.REDIS_URL;
            console.log('🔍 Debug - REDIS_URL:', redisUrl ? 'Found' : 'Missing');
            console.log('🔍 Debug - All Redis env vars:', {
                REDIS_URL: process.env.REDIS_URL ? 'Set' : 'Missing',
                REDISHOST: process.env.REDISHOST || 'Missing',
                REDISPORT: process.env.REDISPORT || 'Missing',
                REDISPASSWORD: process.env.REDISPASSWORD ? 'Set' : 'Missing'
            });
            
            // Try to build Redis URL from components if REDIS_URL is not properly resolved
            let finalRedisUrl = redisUrl;
            if (!redisUrl || redisUrl.includes('${{')) {
                const host = process.env.REDISHOST;
                const port = process.env.REDISPORT || '6379';
                const password = process.env.REDISPASSWORD;
                const user = process.env.REDISUSER || 'default';
                
                if (host && password) {
                    finalRedisUrl = `redis://${user}:${password}@${host}:${port}`;
                    console.log('🔧 Built Redis URL from components');
                } else {
                    console.log('⚠️  No Redis connection details found - Redis features disabled');
                    this.isConnected = false;
                    return false;
                }
            }
            
            // Main client for operations
            this.client = redis.createClient({ url: finalRedisUrl });
            this.client.on('error', (err) => console.error('Redis Client Error:', err));
            
            // Publisher for pub/sub
            this.publisher = redis.createClient({ url: finalRedisUrl });
            this.publisher.on('error', (err) => console.error('Redis Publisher Error:', err));
            
            // Subscriber for pub/sub
            this.subscriber = redis.createClient({ url: finalRedisUrl });
            this.subscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));

            await Promise.all([
                this.client.connect(),
                this.publisher.connect(),
                this.subscriber.connect()
            ]);

            this.isConnected = true;
            console.log('Redis connections established');
            return true;
        } catch (error) {
            console.error('Redis connection failed:', error);
            this.isConnected = false;
            return false;
        }
    }

    async disconnect() {
        try {
            if (this.client) await this.client.disconnect();
            if (this.publisher) await this.publisher.disconnect();
            if (this.subscriber) await this.subscriber.disconnect();
            this.isConnected = false;
            console.log('Redis connections closed');
        } catch (error) {
            console.error('Error disconnecting from Redis:', error);
        }
    }

    // User state management
    async setUserState(persistentUserId, data, ttl = null) {
        if (!this.isConnected) return false;
        
        try {
            const key = `user:${persistentUserId}`;
            if (ttl) {
                await this.client.hSet(key, data);
                await this.client.expire(key, ttl);
            } else {
                await this.client.hSet(key, data);
            }
            return true;
        } catch (error) {
            console.error('Error setting user state:', error);
            return false;
        }
    }

    async updateUserField(persistentUserId, field, value) {
        if (!this.isConnected) return false;
        
        try {
            const key = `user:${persistentUserId}`;
            await this.client.hSet(key, field, value);
            return true;
        } catch (error) {
            console.error('Error updating user field:', error);
            return false;
        }
    }

    async updateCurrentSession(persistentUserId, newSessionId) {
        return await this.updateUserField(persistentUserId, 'currentSessionId', newSessionId);
    }

    async getUserState(persistentUserId) {
        if (!this.isConnected) return null;
        
        try {
            const key = `user:${persistentUserId}`;
            const data = await this.client.hGetAll(key);
            return Object.keys(data).length ? data : null;
        } catch (error) {
            console.error('Error getting user state:', error);
            return null;
        }
    }

    async deleteUserState(persistentUserId) {
        if (!this.isConnected) return false;
        
        try {
            const key = `user:${persistentUserId}`;
            await this.client.del(key);
            return true;
        } catch (error) {
            console.error('Error deleting user state:', error);
            return false;
        }
    }

    // Session management
    async setSessionMapping(sessionId, persistentUserId, ttl = 86400) { // 24 hours default
        if (!this.isConnected) return false;
        
        try {
            const key = `session:${sessionId}`;
            await this.client.setEx(key, ttl, persistentUserId);
            return true;
        } catch (error) {
            console.error('Error setting session mapping:', error);
            return false;
        }
    }

    async getSessionMapping(sessionId) {
        if (!this.isConnected) return null;
        
        try {
            const key = `session:${sessionId}`;
            return await this.client.get(key);
        } catch (error) {
            console.error('Error getting session mapping:', error);
            return null;
        }
    }

    // Handoff state management
    async setHandoffState(persistentUserId, handoffData, ttl = 600) { // 10 minutes default
        if (!this.isConnected) return false;
        
        try {
            const key = `handoff:${persistentUserId}`;
            await this.client.setEx(key, ttl, JSON.stringify(handoffData));
            return true;
        } catch (error) {
            console.error('Error setting handoff state:', error);
            return false;
        }
    }

    async getHandoffState(persistentUserId) {
        if (!this.isConnected) return null;
        
        try {
            const key = `handoff:${persistentUserId}`;
            const data = await this.client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('Error getting handoff state:', error);
            return null;
        }
    }

    async deleteHandoffState(persistentUserId) {
        if (!this.isConnected) return false;
        
        try {
            const key = `handoff:${persistentUserId}`;
            await this.client.del(key);
            return true;
        } catch (error) {
            console.error('Error deleting handoff state:', error);
            return false;
        }
    }

    // Timer management
    async setTimerStart(persistentUserId, startTime = Date.now()) {
        if (!this.isConnected) return false;
        
        try {
            const key = `timer:${persistentUserId}`;
            await this.client.setEx(key, 600, startTime.toString()); // 10 minutes TTL
            return true;
        } catch (error) {
            console.error('Error setting timer start:', error);
            return false;
        }
    }

    async getTimerStart(persistentUserId) {
        if (!this.isConnected) return null;
        
        try {
            const key = `timer:${persistentUserId}`;
            const startTime = await this.client.get(key);
            return startTime ? parseInt(startTime) : null;
        } catch (error) {
            console.error('Error getting timer start:', error);
            return null;
        }
    }

    async deleteTimer(persistentUserId) {
        if (!this.isConnected) return false;
        
        try {
            const key = `timer:${persistentUserId}`;
            await this.client.del(key);
            return true;
        } catch (error) {
            console.error('Error deleting timer:', error);
            return false;
        }
    }

    // Pub/Sub for real-time updates
    async publish(channel, message) {
        if (!this.isConnected) return false;
        
        try {
            await this.publisher.publish(channel, JSON.stringify(message));
            return true;
        } catch (error) {
            console.error('Error publishing message:', error);
            return false;
        }
    }

    async subscribe(channel, callback) {
        if (!this.isConnected) return false;
        
        try {
            await this.subscriber.subscribe(channel, (message) => {
                try {
                    const data = JSON.parse(message);
                    callback(data);
                } catch (error) {
                    console.error('Error parsing subscribed message:', error);
                }
            });
            return true;
        } catch (error) {
            console.error('Error subscribing to channel:', error);
            return false;
        }
    }

    // Active session management - key by persistentUserId for reconnection support
    async setActiveSession(persistentUserId, sessionData, ttl = 3600) {
        if (!this.isConnected) return false;
        
        try {
            const pipeline = this.client.multi();
            pipeline.hSet('activeSessions', persistentUserId, JSON.stringify(sessionData));
            pipeline.setEx(`session:${persistentUserId}:ttl`, ttl, '1');
            await pipeline.exec();
            return true;
        } catch (error) {
            console.error('Error setting active session:', error);
            return false;
        }
    }

    async getActiveSession(persistentUserId) {
        if (!this.isConnected) return null;
        
        try {
            const [ttlExists, data] = await Promise.all([
                this.client.exists(`session:${persistentUserId}:ttl`),
                this.client.hGet('activeSessions', persistentUserId)
            ]);
            
            if (!ttlExists) {
                if (data) {
                    await this.client.hDel('activeSessions', persistentUserId);
                }
                return null;
            }
            
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('Error getting active session:', error);
            return null;
        }
    }

    async deleteActiveSession(persistentUserId) {
        if (!this.isConnected) return false;
        
        try {
            const pipeline = this.client.multi();
            pipeline.hDel('activeSessions', persistentUserId);
            pipeline.del(`session:${persistentUserId}:ttl`);
            await pipeline.exec();
            return true;
        } catch (error) {
            console.error('Error deleting active session:', error);
            return false;
        }
    }

    async getAllActiveSessions() {
        if (!this.isConnected) return {};
        
        try {
            console.log(`🔍 getAllActiveSessions: Starting retrieval`);
            const sessions = await this.client.hGetAll('activeSessions');
            console.log(`🔍 getAllActiveSessions: Found ${Object.keys(sessions).length} sessions in hash`);
            console.log(`🔍 getAllActiveSessions: Session keys:`, Object.keys(sessions));
            
            if (Object.keys(sessions).length === 0) return {};
            
            // Batch check all TTL keys to avoid N+1 queries
            const persistentUserIds = Object.keys(sessions);
            const ttlKeys = persistentUserIds.map(id => `session:${id}:ttl`);
            console.log(`🔍 getAllActiveSessions: Checking TTL keys:`, ttlKeys);
            
            // Use pipeline for batch TTL checks
            const pipeline = this.client.multi();
            ttlKeys.forEach(key => pipeline.exists(key));
            const results = await pipeline.exec();
            console.log(`🔍 getAllActiveSessions: Raw pipeline results:`, results);
            console.log(`🔍 getAllActiveSessions: TTL check results:`, results.map(r => r && r[1] !== undefined ? r[1] : r));
            
            // Build result and clean up expired sessions
            const parsed = {};
            const expiredSessions = [];
            
            persistentUserIds.forEach((persistentUserId, index) => {
                // Handle different pipeline result formats
                let ttlExists;
                if (results[index] && results[index][1] !== undefined) {
                    ttlExists = results[index][1]; // [error, result] format
                } else {
                    ttlExists = results[index]; // Direct result format
                }
                console.log(`🔍 getAllActiveSessions: User ${persistentUserId} - TTL exists: ${ttlExists} (type: ${typeof ttlExists})`);
                
                if (ttlExists) {
                    parsed[persistentUserId] = JSON.parse(sessions[persistentUserId]);
                    console.log(`🔍 getAllActiveSessions: Including user ${persistentUserId}`);
                } else {
                    expiredSessions.push(persistentUserId);
                    console.log(`🔍 getAllActiveSessions: Expiring user ${persistentUserId}`);
                }
            });
            
            console.log(`🔍 getAllActiveSessions: Final count: ${Object.keys(parsed).length}, expired: ${expiredSessions.length}`);
            
            // Clean up expired sessions if any
            if (expiredSessions.length > 0) {
                const cleanupPipeline = this.client.multi();
                expiredSessions.forEach(persistentUserId => {
                    cleanupPipeline.hDel('activeSessions', persistentUserId);
                });
                await cleanupPipeline.exec();
                console.log(`🔍 getAllActiveSessions: Cleaned up ${expiredSessions.length} expired sessions`);
            }
            
            return parsed;
        } catch (error) {
            console.error('Error getting all active sessions:', error);
            return {};
        }
    }

    // Update the current sessionId without losing other session data
    async updateActiveSessionId(persistentUserId, newSessionId) {
        if (!this.isConnected) return false;
        
        try {
            const session = await this.getActiveSession(persistentUserId);
            if (session) {
                session.currentSessionId = newSessionId;
                await this.setActiveSession(persistentUserId, session);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error updating active session ID:', error);
            return false;
        }
    }

    // Utility methods
    async getAllUserStates() {
        if (!this.isConnected) return {};
        
        try {
            const keys = await this.client.keys('user:*');
            const states = {};
            
            for (const key of keys) {
                const userId = key.replace('user:', '');
                states[userId] = await this.client.hGetAll(key);
            }
            
            return states;
        } catch (error) {
            console.error('Error getting all user states:', error);
            return {};
        }
    }

    async cleanup() {
        if (!this.isConnected) return;
        
        try {
            // Clean up expired keys (Redis handles this automatically, but we can force it)
            const patterns = ['user:*', 'session:*', 'handoff:*', 'timer:*'];
            
            for (const pattern of patterns) {
                const keys = await this.client.keys(pattern);
                // Redis will automatically expire keys with TTL, but we can check for orphaned keys
                console.log(`Found ${keys.length} keys matching ${pattern}`);
            }
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

// Singleton instance
const redisService = new RedisService();

module.exports = redisService;