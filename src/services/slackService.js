const { WebClient } = require('@slack/web-api');
const OpenAI = require('openai');
const databaseService = require('./databaseService');
const redisService = require('./redisService');

class SlackService {
    constructor() {
        this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
        this.channelId = process.env.SLACK_CHANNEL_ID;
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        // Keep local intervals for timers (can't be stored in Redis)
        this.updateIntervals = new Map();
        this.sessionDurationIntervals = new Map();
        this.handoffTimeouts = new Map();
        this.connectionRequestTimes = new Map();
        this.sessionConversationHistory = new Map();
        this.cachedSummaries = new Map();
        this.activeSessions = new Map();
        this.waitingSessions = new Map();
        this.userInactivityTimeouts = new Map(); // Track user inactivity timeouts
        
        // Initialize Redis connection
        this.initializeRedis();
    }
    
    async initializeRedis() {
        const connected = await redisService.connect();
        if (connected) {
            console.log('✅ Redis connected successfully');
        } else {
            console.error('❌ Redis connection failed');
        }
    }
    
    // Helper method to map user to session in Redis
    async mapUserToSession(persistentUserId, sessionId) {
        await redisService.updateCurrentSession(persistentUserId, sessionId);
        await redisService.setSessionMapping(sessionId, persistentUserId);
        
        // Also update the active session's currentSessionId for proper WebSocket routing
        await redisService.updateActiveSessionId(persistentUserId, sessionId);
        console.log(`🔄 Updated active session currentSessionId to ${sessionId} for user ${persistentUserId}`);
    }
    
    // Set 10-minute timeout for handoff requests
    setHandoffTimeout(persistentUserId, sessionId) {
        // Clear any existing timeout
        this.clearHandoffTimeout(persistentUserId);
        
        const timeoutId = setTimeout(async () => {
            console.log(`Handoff timeout for user ${persistentUserId}`);
            
            // Log timeout to database
            await databaseService.logHandoffTimeout(persistentUserId);
            
            // Get handoff state to find the Slack message to update
            const handoffState = await redisService.getHandoffState(persistentUserId);
            
            // Update Slack message to show timeout status
            if (handoffState && handoffState.messageTs) {
                const waitingTime = Math.floor((Date.now() - handoffState.requestTime) / 1000);
                const waitingMinutes = Math.floor(waitingTime / 60);
                const waitingTimeText = waitingMinutes > 0 
                    ? `${waitingMinutes}m ${waitingTime % 60}s`
                    : `${waitingTime}s`;
                
                let summaryText = '';
                if (handoffState.summary) {
                    summaryText = `\n\n*Conversation Summary:*\n${handoffState.summary}`;
                }
                
                try {
                    const updateResult = await this.slack.chat.update({
                        channel: this.channelId,
                        ts: handoffState.messageTs,
                        text: `⏰ Request Timed Out - Session ${handoffState.sessionId}`,
                        blocks: [
                            {
                                type: "section",
                                text: {
                                    type: "mrkdwn",
                                    text: `⏰ *Request Timed Out*\nSession: \`${handoffState.sessionId}\`\nTime: ${new Date(handoffState.requestTime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: true })}\n⏱️ *Total Wait Time: ${waitingTimeText}*${summaryText}\n\nNo agents were available within 10 minutes. User returned to AI chat.`
                                }
                            }
                        ]
                    });
                    
                    if (updateResult.ok) {
                        console.log(`✅ Successfully updated Slack message for timed out handoff request: ${handoffState.sessionId}`);
                    } else {
                        console.error(`❌ Slack API returned error for timeout update:`, updateResult);
                    }
                    
                    // Also post a follow-up message in the thread to make it very clear
                    await this.slack.chat.postMessage({
                        channel: this.channelId,
                        thread_ts: handoffState.messageTs,
                        text: `⏰ This handoff request has timed out after 10 minutes. The user has been returned to AI chat.`
                    });
                    
                } catch (slackError) {
                    console.error('Error updating Slack message for timeout:', slackError);
                    console.error('Slack error details:', slackError.data || slackError.message);
                    
                    // Try to post a new message if update fails
                    try {
                        await this.slack.chat.postMessage({
                            channel: this.channelId,
                            text: `⏰ Handoff request for session ${handoffState.sessionId} has timed out after 10 minutes.`
                        });
                        console.log(`Posted fallback timeout message for session: ${handoffState.sessionId}`);
                    } catch (fallbackError) {
                        console.error('Failed to post fallback timeout message:', fallbackError);
                    }
                }
            }
            
            // Reset session state back to SEEKING_HANDOFF
            const aiService = require('./aiService');
            const userState = await redisService.getUserState(persistentUserId);
            const currentSessionId = userState?.currentSessionId || sessionId;
            
            if (currentSessionId) {
                await aiService.setSessionState(currentSessionId, aiService.SessionState.SEEKING_HANDOFF, persistentUserId);
                console.log(`Session state reset to SEEKING_HANDOFF for user ${persistentUserId} after timeout`);
                
                // Notify user via WebSocket that the timeout occurred and they're back to AI
                if (global.io) {
                    global.io.to(currentSessionId).emit('handoff_timeout', {
                        sessionId: currentSessionId,
                        message: 'Our team is currently busy. You can continue chatting with our AI Assistant, or try requesting human assistance again later.',
                        type: 'timeout',
                        timestamp: new Date().toISOString()
                    });
                    
                    // Also send a regular message event so it appears in chat
                    global.io.to(currentSessionId).emit('message', {
                        sessionId: currentSessionId,
                        message: "I apologise, but no one from our team is currently available to assist you. You can continue chatting with me, or try requesting human assistance again later.",
                        type: 'system',
                        timestamp: new Date().toISOString()
                    });
                    
                    console.log(`✅ Sent timeout notifications to session ${currentSessionId}`);
                } else {
                    console.warn(`⚠️  No WebSocket connection available to notify session ${currentSessionId} of timeout`);
                }
            }
            
            // Clean up Redis state
            await redisService.deleteHandoffState(persistentUserId);
            await redisService.deleteTimer(persistentUserId);
            
            // Stop waiting time updater
            await this.stopWaitingTimeUpdater(persistentUserId);
            
            // Remove from timeout tracking
            this.handoffTimeouts.delete(persistentUserId);
        }, 600000); // 10 minutes
        
        this.handoffTimeouts.set(persistentUserId, timeoutId);
    }
    
    // Clear handoff timeout
    clearHandoffTimeout(persistentUserId) {
        if (this.handoffTimeouts.has(persistentUserId)) {
            clearTimeout(this.handoffTimeouts.get(persistentUserId));
            this.handoffTimeouts.delete(persistentUserId);
        }
    }

    // Set 10-minute user inactivity timeout for active conversations
    setUserInactivityTimeout(persistentUserId) {
        // Clear any existing timeout
        this.clearUserInactivityTimeout(persistentUserId);
        
        const timeoutId = setTimeout(async () => {
            console.log(`User inactivity timeout for user ${persistentUserId} - ending conversation`);
            
            try {
                // Get the active session to get thread info
                const activeSession = await redisService.getActiveSession(persistentUserId);
                if (activeSession) {
                    // Calculate final duration
                    const finalDuration = Math.floor((Date.now() - activeSession.connectedAt) / 1000);
                    const finalDurationText = this.formatDuration(finalDuration);
                    
                    // Get cached summary to preserve it
                    let summaryText = '';
                    const cachedSummary = this.cachedSummaries.get(activeSession.currentSessionId);
                    if (cachedSummary) {
                        summaryText = `\n\n*Conversation Summary:*\n${cachedSummary}`;
                    }
                    
                    // Update the original message to show inactivity timeout and remove End Chat button
                    await this.slack.chat.update({
                        channel: this.channelId,
                        ts: activeSession.originalMessageTs || activeSession.threadTs,
                        text: `⏰ Conversation Ended - Inactivity Timeout`,
                        blocks: [
                            {
                                type: "section",
                                text: {
                                    type: "mrkdwn",
                                    text: `⏰ *Conversation Ended - Customer Inactive*\nSession: \`${activeSession.currentSessionId}\`\n⏱️ Total Duration: ${finalDurationText}\nAgent: ${activeSession.agentName}${summaryText}\n\nCustomer was inactive for 10 minutes. Conversation ended automatically.`
                                }
                            }
                        ]
                    });
                    
                    // Post message to Slack thread notifying agent of inactivity
                    await this.slack.chat.postMessage({
                        channel: this.channelId,
                        thread_ts: activeSession.threadTs,
                        text: `⏰ Customer has been inactive for 10 minutes. Conversation ended automatically.`
                    });
                    
                    // Clean up cached summary after using it
                    this.cachedSummaries.delete(activeSession.currentSessionId);
                    
                    // Notify user via WebSocket
                    if (global.io && activeSession.currentSessionId) {
                        global.io.to(activeSession.currentSessionId).emit('agent_disconnected', {
                            sessionId: activeSession.currentSessionId,
                            message: 'The conversation has ended due to inactivity. You can continue chatting with our AI Assistant.',
                            type: 'inactivity_timeout'
                        });
                    }
                    
                    // End the session
                    await this.forceEndSessionByPersistentUserId(persistentUserId);
                    
                    // Log the inactivity timeout to database
                    await databaseService.logUserInactivityTimeout(persistentUserId);
                    console.log(`Session ended due to user inactivity: ${persistentUserId}`);
                }
                
            } catch (error) {
                console.error('Error handling user inactivity timeout:', error);
            }
            
            // Remove from timeout tracking
            this.userInactivityTimeouts.delete(persistentUserId);
        }, 600000); // 10 minutes
        
        this.userInactivityTimeouts.set(persistentUserId, timeoutId);
        console.log(`Set 10-minute inactivity timeout for user ${persistentUserId}`);
    }

    // Clear user inactivity timeout
    clearUserInactivityTimeout(persistentUserId) {
        if (this.userInactivityTimeouts.has(persistentUserId)) {
            clearTimeout(this.userInactivityTimeouts.get(persistentUserId));
            this.userInactivityTimeouts.delete(persistentUserId);
            console.log(`Cleared inactivity timeout for user ${persistentUserId}`);
        }
    }

    /**
     * Summarize conversation history for Slack agents
     */
    async summarizeConversation(conversationHistory) {
        if (!conversationHistory || conversationHistory.length === 0) {
            return 'No conversation history available.';
        }

        try {
            // Build conversation text
            let conversationText = '';
            conversationHistory.forEach(msg => {
                const sender = msg.sender === 'user' ? 'Customer' : 'Bot';
                conversationText += `${sender}: ${msg.message}\n`;
            });

            const summaryPrompt = `Please provide a concise summary of this customer support conversation for our Achora agents. Focus on:
- What the customer was asking about
- Key information provided
- Any specific needs or concerns mentioned
- Current status/outcome

Conversation:
${conversationText}

IMPORTANT: Use Australian spelling and writing style (e.g., realise, colour, centre, organised). Keep the summary to 2-3 sentences maximum. Be specific and actionable for the agent.`;

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "You are summarizing customer conversations for support agents. Be concise and focus on actionable information." },
                    { role: "user", content: summaryPrompt }
                ],
                max_completion_tokens: 150,
                temperature: 0.3
            });

            return completion.choices[0].message.content.trim();
        } catch (error) {
            console.error('Error summarizing conversation:', error);
            // Fallback to simple format
            const recent = conversationHistory.slice(-2);
            return `Recent messages: ${recent.map(msg => `${msg.sender}: ${msg.message.substring(0, 50)}...`).join(' | ')}`;
        }
    }

    async startWaitingTimeUpdater(sessionId, messageTs, persistentUserId) {
        // Clear any existing interval for this USER (not session)
        if (this.updateIntervals.has(persistentUserId)) {
            clearInterval(this.updateIntervals.get(persistentUserId));
        }

        // Update the Slack message every 10 seconds with new waiting time  
        const intervalId = setInterval(async () => {
            const requestTime = await redisService.getTimerStart(persistentUserId);
            if (!requestTime) {
                clearInterval(intervalId);
                this.updateIntervals.delete(persistentUserId);
                return;
            }

            const waitingSeconds = Math.floor((Date.now() - requestTime) / 1000);
            const waitingMinutes = Math.floor(waitingSeconds / 60);
            const remainingSeconds = waitingSeconds % 60;
            const waitingText = waitingMinutes > 0 
                ? `${waitingMinutes}m ${remainingSeconds}s`
                : `${waitingSeconds}s`;

            try {
                // Use the cached summary instead of regenerating every 10 seconds
                let historyText = '';
                const cachedSummary = await redisService.getHandoffState(persistentUserId);
                if (cachedSummary && cachedSummary.summary) {
                    historyText = `\n\n*Conversation Summary:*\n${cachedSummary.summary}`;
                }

                // Update the message with new waiting time
                await this.slack.chat.update({
                    channel: this.channelId,
                    ts: messageTs,
                    text: `🔔 New support request from session ${sessionId}`,
                    blocks: [
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: `🔔 *New Support Request*\nSession: \`${sessionId}\`\nTime: ${new Date(requestTime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: true })}\n⏱️ *Waiting: ${waitingText}*${historyText}`
                            }
                        },
                        {
                            type: "actions",
                            elements: [
                                {
                                    type: "button",
                                    text: {
                                        type: "plain_text",
                                        text: `Accept Chat (Waiting: ${waitingText})`
                                    },
                                    style: "primary",
                                    value: persistentUserId || sessionId,  // Use persistentUserId for reconnection safety
                                    action_id: "accept_chat"
                                }
                            ]
                        }
                    ]
                });
            } catch (error) {
                console.error(`Error updating waiting time for session ${sessionId}:`, error);
                // Stop updating if there's an error
                clearInterval(intervalId);
                this.updateIntervals.delete(sessionId);
            }
        }, 10000); // Update every 10 seconds

        this.updateIntervals.set(persistentUserId, intervalId);
    }

    async stopWaitingTimeUpdater(persistentUserId) {
        if (this.updateIntervals.has(persistentUserId)) {
            clearInterval(this.updateIntervals.get(persistentUserId));
            this.updateIntervals.delete(persistentUserId);
        }
        // Clean up Redis data
        await redisService.deleteTimer(persistentUserId);
        await redisService.deleteHandoffState(persistentUserId);
    }

    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${secs}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    async startSessionDurationUpdater(persistentUserId, messageTs) {
        // Clear any existing interval for this user
        if (this.sessionDurationIntervals.has(persistentUserId)) {
            clearInterval(this.sessionDurationIntervals.get(persistentUserId));
        }

        const session = await redisService.getActiveSession(persistentUserId);
        if (!session) return;

        // Update every 30 seconds
        const intervalId = setInterval(async () => {
            const currentSession = await redisService.getActiveSession(persistentUserId);
            if (!currentSession) {
                clearInterval(intervalId);
                this.sessionDurationIntervals.delete(persistentUserId);
                return;
            }

            const duration = Math.floor((Date.now() - currentSession.connectedAt) / 1000);
            const durationText = this.formatDuration(duration);

            try {
                // Get conversation summary from cached summaries to preserve it
                let summaryText = '';
                const cachedSummary = this.cachedSummaries.get(currentSession.currentSessionId);
                if (cachedSummary) {
                    summaryText = `\n\n*Conversation Summary:*\n${cachedSummary}`;
                }
                
                // Update the original message with current duration AND preserve summary
                await this.slack.chat.update({
                    channel: this.channelId,
                    ts: messageTs,
                    text: `🟢 Chat accepted by ${currentSession.agentName}`,
                    blocks: [
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: `🟢 *Chat Accepted by ${currentSession.agentName}*\nSession: \`${currentSession.currentSessionId}\`\n⏱️ Duration: ${durationText}${summaryText}\n\n*Reply in thread to chat with the customer*`
                            }
                        },
                        {
                            type: "actions",
                            elements: [
                                {
                                    type: "button",
                                    text: {
                                        type: "plain_text",
                                        text: `End Chat (${durationText})`
                                    },
                                    style: "danger",
                                    value: persistentUserId || sessionId,  // Use persistentUserId for reconnection safety
                                    action_id: "end_chat"
                                }
                            ]
                        }
                    ]
                });
            } catch (error) {
                console.error(`Error updating session duration for ${persistentUserId}:`, error);
                clearInterval(intervalId);
                this.sessionDurationIntervals.delete(persistentUserId);
            }
        }, 30000); // Update every 30 seconds

        this.sessionDurationIntervals.set(persistentUserId, intervalId);
    }

    stopSessionDurationUpdater(sessionId) {
        if (this.sessionDurationIntervals.has(sessionId)) {
            clearInterval(this.sessionDurationIntervals.get(sessionId));
            this.sessionDurationIntervals.delete(sessionId);
        }
    }

    async requestHumanAgent(sessionId, userMessage = '', conversationHistory = [], persistentUserId = null) {
        try {
            // Map persistent user ID to current session
            if (persistentUserId) {
                await this.mapUserToSession(persistentUserId, sessionId);
                console.log(`Mapped persistent user ${persistentUserId} to session ${sessionId}`);
                
                const existingRequest = await redisService.getHandoffState(persistentUserId);
                if (existingRequest) {
                    console.log(`Found existing handoff request for user ${persistentUserId}, updating session from ${existingRequest.sessionId} to ${sessionId}`);
                    
                    // Update the existing request with new session ID
                    existingRequest.sessionId = sessionId;
                    await redisService.setHandoffState(persistentUserId, existingRequest, 300);
                
                    // Update WebSocket room for this session
                    if (global.io) {
                        global.io.to(sessionId).emit('agent_waiting', {
                            sessionId: sessionId,
                            message: 'Your request for human assistance is still being processed. An agent will be with you shortly.'
                        });
                    }
                    
                    return {
                        status: 'human_requested',
                        message: 'Your previous request for human assistance is still active. Someone will be with you shortly!'
                    };
                }
            }
            
            // Store conversation history for later use when agent accepts
            this.sessionConversationHistory.set(sessionId, conversationHistory);
            
            // Store the request timestamp
            this.connectionRequestTimes.set(sessionId, Date.now());
            
            // Summarize conversation history for agents and cache it
            let historyText = '';
            let summary = null;
            if (conversationHistory && conversationHistory.length > 0) {
                console.log(`Summarizing conversation with ${conversationHistory.length} messages...`);
                summary = await this.summarizeConversation(conversationHistory);
                historyText = `\n\n*Conversation Summary:*\n${summary}`;
                // Cache the summary to avoid regenerating every 10 seconds
                this.cachedSummaries.set(sessionId, summary);
            }

            // Send message to Slack with Accept button
            const messageResult = await this.slack.chat.postMessage({
                channel: this.channelId,
                text: `🔔 New support request from session ${sessionId}`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `🔔 *New Support Request*\nSession: \`${sessionId}\`\nTime: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: true })}\n⏱️ *Waiting: 0s*${historyText}`
                        }
                    },
                    {
                        type: "actions",
                        elements: [
                            {
                                type: "button",
                                text: {
                                    type: "plain_text",
                                    text: "Accept Chat (Waiting: 0s)"
                                },
                                style: "primary",
                                value: persistentUserId || sessionId,
                                action_id: "accept_chat"
                            }
                        ]
                    }
                ]
            });

            // Store message timestamp for updates and track as waiting session
            if (messageResult.ts) {
                const waitingSessionData = {
                    messageTs: messageResult.ts,
                    requestTime: Date.now(),
                    persistentUserId: persistentUserId
                };
                
                this.waitingSessions.set(sessionId, waitingSessionData);
                
                // Track pending handoff by persistent user ID in Redis
                if (persistentUserId) {
                    await redisService.setHandoffState(persistentUserId, {
                        sessionId: sessionId,
                        messageTs: messageResult.ts,
                        requestTime: Date.now(),
                        conversationHistory: conversationHistory,
                        summary: summary
                    }, 600); // 10 minutes TTL
                    
                    // Set timer start for waiting time tracking
                    await redisService.setTimerStart(persistentUserId, Date.now());
                    
                    // Set 10-minute timeout for handoff request
                    this.setHandoffTimeout(persistentUserId, sessionId);
                }
                
                await this.startWaitingTimeUpdater(sessionId, messageResult.ts, persistentUserId);
            }

            console.log(`Slack notification sent for session ${sessionId}`);

            return {
                status: 'human_requested',
                message: 'Human agent request sent to our team. Someone will be with you shortly!'
            };

        } catch (error) {
            console.error('Error sending Slack notification:', error);
            return {
                status: 'error',
                message: 'Unable to connect to human agent right now. Please try again.'
            };
        }
    }

    async sendToHuman(sessionId, message, persistentUserId = null) {
        const currentTime = new Date().toISOString();
        console.log(`🔍 [${currentTime}] sendToHuman called - sessionId: ${sessionId}, persistentUserId: ${persistentUserId}, message: "${message}"`);
        
        // Check Redis connection first
        console.log(`🔍 [${currentTime}] Redis connected:`, redisService.isConnected);
        
        // First, let's check what's actually in Redis
        console.log(`🔍 [${currentTime}] Checking all active sessions in Redis...`);
        const allActiveSessions = await redisService.getAllActiveSessions();
        console.log(`🔍 [${currentTime}] All active sessions:`, Object.keys(allActiveSessions).length, 'found');
        console.log(`🔍 [${currentTime}] Active session keys:`, Object.keys(allActiveSessions));
        if (Object.keys(allActiveSessions).length > 0) {
            console.log(`🔍 [${currentTime}] First session details:`, allActiveSessions[Object.keys(allActiveSessions)[0]]);
        }
        
        // Also check user state
        if (persistentUserId) {
            const userState = await redisService.getUserState(persistentUserId);
            console.log(`🔍 [${currentTime}] User state for ${persistentUserId}:`, userState);
        }
        
        // Try to find session by persistentUserId first
        let session = null;
        if (persistentUserId) {
            console.log(`🔍 Trying to find session by persistentUserId: ${persistentUserId}`);
            session = await redisService.getActiveSession(persistentUserId);
            console.log(`🔍 Session found by persistentUserId:`, session ? 'YES' : 'NO');
            if (session) {
                console.log(`🔍 Session details:`, session);
            }
        }
        
        if (!session) {
            // Fallback: try to find persistentUserId from sessionId mapping
            console.log(`🔍 No session found, trying sessionId mapping for: ${sessionId}`);
            const mappedUserId = await redisService.getSessionMapping(sessionId);
            console.log(`🔍 Mapped userId:`, mappedUserId);
            if (mappedUserId) {
                session = await redisService.getActiveSession(mappedUserId);
                console.log(`🔍 Session found by mapped userId:`, session ? 'YES' : 'NO');
            }
        }

        if (!session) {
            console.log(`❌ No active session found for sessionId: ${sessionId}, persistentUserId: ${persistentUserId}`);
            return {
                status: 'error',
                message: 'No human agent connected. Please request human assistance first.'
            };
        }
        
        console.log(`✅ Found active session, sending message to Slack thread: ${session.threadTs}`);

        try {
            // Send user message as a threaded reply with better formatting
            await this.slack.chat.postMessage({
                channel: this.channelId,
                thread_ts: session.threadTs,
                text: message,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Customer:* ${message}`
                        }
                    }
                ]
            });

            console.log(`Message sent to agent ${session.agentName} for session ${sessionId}`);

            // Reset the user inactivity timeout since user just sent a message
            if (persistentUserId) {
                this.setUserInactivityTimeout(persistentUserId);
            }

            return {
                status: 'sent_to_human'
                // No message - agent will respond directly
            };

        } catch (error) {
            console.error('Error sending message to Slack:', error);
            
            // Check if this is because the thread was deleted
            if (error.data?.error === 'thread_not_found' || error.data?.error === 'message_not_found') {
                console.log(`🧹 Thread ${session.threadTs} deleted, cleaning up session and routing to AI`);
                
                // Clean up the broken session
                await this.forceEndSession(sessionId);
                
                // Return a special status to indicate the session was cleaned up
                return {
                    status: 'thread_deleted',
                    message: 'Session cleaned up - please continue with AI assistant'
                };
            }
            
            return {
                status: 'error',
                message: 'Failed to send message to human agent'
            };
        }
    }

    async handleAcceptButton(identifier, userId, userName, originalMessageTs) {
        const acceptTime = new Date().toISOString();
        console.log(`🎯 [${acceptTime}] handleAcceptButton called - identifier: ${identifier}, userId: ${userId}, userName: ${userName}, messageTs: ${originalMessageTs}`);
        
        // Handle both persistentUserId and sessionId in button value
        let persistentUserId = identifier;
        let sessionId;
        
        // Check if identifier is a persistentUserId by looking up user state
        const userState = await redisService.getUserState(identifier);
        if (userState && userState.currentSessionId) {
            // It's a persistentUserId
            sessionId = userState.currentSessionId;
        } else {
            // It might be an old sessionId, try to find persistentUserId
            persistentUserId = await redisService.getSessionMapping(identifier);
            sessionId = identifier;
        }
        
        if (!persistentUserId || !sessionId) {
            console.error(`Could not resolve identifiers: ${identifier}`);
            return {
                status: 'error',
                message: 'Session not found'
            };
        }
        
        // Check if session is already accepted by someone else
        const activeSession = await redisService.getActiveSession(persistentUserId);
        if (activeSession) {
            // Update original message to show it's already taken
            await this.slack.chat.update({
                channel: this.channelId,
                ts: originalMessageTs,
                text: `❌ Already accepted by ${activeSession.agentName}`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `❌ *Already Accepted*\nSession: \`${sessionId}\` is already being handled by ${activeSession.agentName}`
                        }
                    }
                ]
            });

            return {
                status: 'already_taken',
                message: `This chat is already being handled by ${activeSession.agentName}`
            };
        }

        try {
            // Get conversation summary to preserve in main message
            let summaryText = '';
            const cachedSummary = this.cachedSummaries.get(sessionId);
            if (cachedSummary) {
                summaryText = `\n\n*Conversation Summary:*\n${cachedSummary}`;
            }
            
            // Update the original message to show it's been accepted with End Chat button AND preserve summary
            await this.slack.chat.update({
                channel: this.channelId,
                ts: originalMessageTs,
                text: `🟢 Chat accepted by ${userName}`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `🟢 *Chat Accepted by ${userName}*\nSession: \`${sessionId}\`\n⏱️ Duration: 0s${summaryText}\n\n*Reply in thread to start chatting with the customer*`
                        }
                    },
                    {
                        type: "actions",
                        elements: [
                            {
                                type: "button",
                                text: {
                                    type: "plain_text",
                                    text: "End Chat (0s)"
                                },
                                style: "danger",
                                value: persistentUserId || sessionId,
                                action_id: "end_chat"
                            }
                        ]
                    }
                ]
            });

            // Clean up stored conversation history - no thread summary needed
            this.sessionConversationHistory.delete(sessionId);

            console.log(`📋 About to create session data for Redis storage`);
            
            // Mark session as connected in Redis using persistentUserId as key
            const sessionData = {
                agentId: userId,
                agentName: userName,
                threadTs: originalMessageTs,  // Use original message for threading
                originalMessageTs: originalMessageTs,
                connectedAt: Date.now(),  // Store as timestamp for easier calculations
                persistentUserId: persistentUserId,
                currentSessionId: sessionId  // Track current connection for WebSocket routing
            };
            
            // Store in Redis with persistentUserId as key
            console.log(`💾 Storing active session in Redis - persistentUserId: ${persistentUserId}, sessionData:`, sessionData);
            console.log(`🔍 Redis connection status:`, redisService.isConnected);
            try {
                const storeResult = await redisService.setActiveSession(persistentUserId, sessionData, 3600);  // 1 hour TTL
                console.log(`✅ Active session stored successfully, result:`, storeResult);
                
                // Immediately verify it was stored
                const verifySession = await redisService.getActiveSession(persistentUserId);
                console.log(`🔍 Verification - Session stored:`, verifySession ? 'YES' : 'NO');
                if (verifySession) {
                    console.log(`🔍 Verification - Session data:`, verifySession);
                }
                
                // Check if the TTL key exists
                const ttlKeyExists = await redisService.client.exists(`session:${persistentUserId}:ttl`);
                console.log(`🔍 TTL key exists:`, ttlKeyExists);
                
                // Check the raw hash data
                const rawHashData = await redisService.client.hGet('activeSessions', persistentUserId);
                console.log(`🔍 Raw hash data:`, rawHashData ? 'EXISTS' : 'NULL');
                
                // Test getAllActiveSessions right after storage
                const allActiveSessions = await redisService.getAllActiveSessions();
                console.log(`🔍 All active sessions count after storage:`, Object.keys(allActiveSessions).length);
                console.log(`🔍 All active sessions:`, allActiveSessions);
                
            } catch (error) {
                console.error(`❌ Failed to store active session:`, error);
                throw error;
            }
            
            console.log(`📋 About to update Redis user state for ${persistentUserId}`);
            
            // Update Redis user state to show agent connected
            if (persistentUserId) {
                try {
                    await redisService.setUserState(persistentUserId, {
                        agentConnected: 'true',  // String, not boolean
                        agentName: userName,
                        agentId: userId,
                        connectedAt: new Date().toISOString(),
                        currentSessionId: sessionId
                    });
                    console.log(`✅ User state updated successfully`);
                } catch (error) {
                    console.error(`❌ Failed to update user state:`, error);
                }
                
                // Stop the waiting time updater and clean up Redis state
                await this.stopWaitingTimeUpdater(persistentUserId);  // Use persistentUserId
                await redisService.deleteHandoffState(persistentUserId);  // Clean up handoff state
                this.clearHandoffTimeout(persistentUserId);
                this.clearUserInactivityTimeout(persistentUserId);
            }
            
            // Start the session duration updater with persistentUserId
            await this.startSessionDurationUpdater(persistentUserId, originalMessageTs);
            
            // Mark this session as having completed human handoff to prevent future offers
            const aiService = require('./aiService');
            await aiService.markHumanHandoffAccepted(sessionId, persistentUserId);

            // Start 10-minute user inactivity timeout for the conversation
            if (persistentUserId) {
                this.setUserInactivityTimeout(persistentUserId);
            }

            console.log(`Agent ${userName} accepted session ${sessionId}`);

            // No need for duplicate update - already updated above

            // Log agent connection to database with full Slack context
            const handoffState = await redisService.getHandoffState(persistentUserId);
            const handoffRequestedAt = handoffState?.requestTime ? new Date(handoffState.requestTime) : null;
            const waitingDuration = handoffRequestedAt ? Math.floor((Date.now() - handoffState.requestTime) / 1000) : null;
            
            await databaseService.logAgentConnection(sessionId, userName, userId, {
                persistentUserId: persistentUserId,
                threadTs: originalMessageTs,
                messageTs: originalMessageTs,
                conversationSummary: cachedSummary,
                handoffRequestedAt: handoffRequestedAt,
                waitingDuration: waitingDuration
            });

            // Notify user via WebSocket that agent connected
            this.notifyUserOfConnection(sessionId, userName);

            console.log(`🎉 handleAcceptButton completed successfully for ${persistentUserId} with sessionId ${sessionId}`);
            
            return {
                status: 'accepted',
                threadTs: originalMessageTs
            };

        } catch (error) {
            console.error('Error creating thread:', error);
            return {
                status: 'error',
                message: 'Failed to create chat thread'
            };
        }
    }

    notifyUserOfConnection(sessionId, agentName) {
        // Get io instance from global (we'll set this up)
        if (global.io) {
            global.io.to(sessionId).emit('agent_connected', {
                sessionId: sessionId,
                agentName: agentName,
                message: `A Support Specialist has joined the conversation!`
            });
            console.log(`Sent agent connection notification to session ${sessionId}`);
        }
    }

    async notifyAgentOfDisconnection(sessionId) {
        const session = this.activeSessions.get(sessionId);

        if (!session) {
            console.log(`No active session found for ${sessionId}`);
            return;
        }

        // Calculate final duration
        const finalDuration = Math.floor((Date.now() - session.connectedAt.getTime()) / 1000);
        const finalDurationText = this.formatDuration(finalDuration);

        try {
            console.log(`Updating Slack message for session ${sessionId}, threadTs: ${session.threadTs}`);
            
            // Update the original message to show customer disconnected and remove the End Chat button
            const updateResult = await this.slack.chat.update({
                channel: this.channelId,
                ts: session.threadTs,  // This is now the same as originalMessageTs
                text: `🔴 Customer Disconnected - Session ${sessionId}`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `🔴 *Customer Disconnected*\nSession: \`${sessionId}\`\n⏱️ Total Duration: ${finalDurationText}\nAgent: ${session.agentName}\n\nThe customer has left the chat.`
                        }
                    }
                ]
            });
            
            console.log('Slack update result:', updateResult.ok ? 'Success' : 'Failed');

            // Also send a message to the thread for clarity
            await this.slack.chat.postMessage({
                channel: this.channelId,
                thread_ts: session.threadTs,
                text: `🔴 Customer has disconnected from the chat session after ${finalDurationText}.`
            });

            console.log(`Disconnection notification sent to agent ${session.agentName} for session ${sessionId}`);

        } catch (error) {
            console.error('Error sending disconnection notification:', error);
            console.error('Error details:', error.data || error.message);
        }
    }

    async isSessionActive(sessionId) {
        // Fallback: try to find by sessionId mapping
        const persistentUserId = await redisService.getSessionMapping(sessionId);
        if (persistentUserId) {
            const session = await redisService.getActiveSession(persistentUserId);
            return session !== null;
        }
        return false;
    }

    async isSessionActiveForUser(persistentUserId) {
        const session = await redisService.getActiveSession(persistentUserId);
        return session !== null;
    }

    async isSessionWaiting(sessionId) {
        // Check if there's a handoff request for this session's persistent user
        const persistentUserId = await redisService.getSessionMapping(sessionId);
        if (persistentUserId) {
            const handoffState = await redisService.getHandoffState(persistentUserId);
            return handoffState !== null;
        }
        return false;
    }

    async handleWaitingSessionDisconnect(sessionId) {
        if (!this.isSessionWaiting(sessionId)) {
            return;
        }

        console.log(`Handling disconnect for waiting session: ${sessionId}`);
        
        const waitingSession = this.waitingSessions.get(sessionId);
        const persistentUserId = waitingSession?.persistentUserId;
        
        // For persistent users, DON'T update Slack - let the 10-minute timeout handle it
        if (persistentUserId) {
            console.log(`Session ${sessionId} disconnected, maintaining handoff request for persistent user ${persistentUserId} - will timeout after 10 minutes total`);
            // DON'T stop the waiting time updater or clean up - let timeout handle it
        } else {
            // No persistent user ID - handle as immediate disconnect
            this.stopWaitingTimeUpdater(sessionId);
            
            if (waitingSession && waitingSession.messageTs) {
                const waitedDuration = Math.floor((Date.now() - waitingSession.requestTime) / 1000);
                const waitedDurationText = this.formatDuration(waitedDuration);
                
                try {
                    await this.slack.chat.update({
                        channel: this.channelId,
                        ts: waitingSession.messageTs,
                        text: `❌ User Disconnected - Session ${sessionId}`,
                        blocks: [
                            {
                                type: "section",
                                text: {
                                    type: "mrkdwn",
                                    text: `❌ *User Disconnected*\nSession: \`${sessionId}\`\n⏱️ *Waited: ${waitedDurationText}*\n\nThe user closed their browser while waiting for an agent.`
                                }
                            }
                        ]
                    });
                    
                    await this.slack.chat.postMessage({
                        channel: this.channelId,
                        thread_ts: waitingSession.messageTs,
                        text: `❌ Customer disconnected after waiting ${waitedDurationText} for an agent to accept.`
                    });
                    
                    console.log(`Updated Slack message for disconnected session: ${sessionId} (waited ${waitedDurationText})`);
                } catch (error) {
                    console.error(`Error updating disconnect message: ${sessionId}`, error);
                }
            }
            
            // Clean up waiting session and cached summary for non-persistent users
            this.waitingSessions.delete(sessionId);
            this.cachedSummaries.delete(sessionId);
        }
    }

    async disconnectSession(sessionId) {
        // Get persistent user ID to clean up properly
        const persistentUserId = await redisService.getSessionMapping(sessionId);
        
        // For persistent users, DON'T delete active session - let 10-minute timeout handle it
        // This allows users to reconnect with same or different sessionId
        if (persistentUserId) {
            console.log(`Session ${sessionId} disconnected for persistent user ${persistentUserId} - maintaining agent session for reconnection`);
            // Don't delete active session - user can reconnect
        } else {
            // For non-persistent users (legacy), clean up immediately
            await redisService.deleteActiveSession(sessionId);
        }
        
        // Don't stop the session duration updater for persistent users - let timeout handle it
        if (!persistentUserId) {
            this.stopSessionDurationUpdater(sessionId);
        }
        
        console.log(`Session ${sessionId} disconnect handled`);
    }

    async handleEndChatButton(identifier, userId, userName, messageTs) {
        console.log(`🔴 handleEndChatButton called - identifier: ${identifier}, userId: ${userId}, userName: ${userName}, messageTs: ${messageTs}`);
        
        try {
            // Handle both persistentUserId and sessionId (similar to handleAcceptButton)
            let persistentUserId = identifier;
            let sessionId;
            
            // Check if identifier is a persistentUserId by looking up active session directly
            console.log(`🔴 Looking up active session for identifier: ${identifier}`);
            let session = await redisService.getActiveSession(identifier);
            if (session) {
                // It's a persistentUserId
                persistentUserId = identifier;
                sessionId = session.currentSessionId;
                console.log(`🔴 Found active session for persistentUserId ${persistentUserId}, sessionId: ${sessionId}`);
            } else {
                // It might be a sessionId, try to find persistentUserId
                console.log(`🔴 No active session found, trying as sessionId mapping`);
                persistentUserId = await redisService.getSessionMapping(identifier);
                sessionId = identifier;
                session = persistentUserId ? await redisService.getActiveSession(persistentUserId) : null;
                console.log(`🔴 Treating as sessionId ${sessionId}, found persistentUserId: ${persistentUserId}, session: ${session ? 'FOUND' : 'NULL'}`);
            }

            if (!session) {
                console.log(`🔴 No active session found for identifier: ${identifier}`);
                return {
                    status: 'session_not_found',
                    message: 'Session not found or already ended'
                };
            }

            console.log(`🔴 Session found, proceeding with end chat logic`);
            
            // Calculate final duration (connectedAt stored as timestamp)
            const finalDuration = Math.floor((Date.now() - session.connectedAt) / 1000);
            const finalDurationText = this.formatDuration(finalDuration);
            
            // Stop the duration updater using persistentUserId
            this.stopSessionDurationUpdater(session.persistentUserId || persistentUserId);

            // Get conversation summary to preserve it in final message
            let summaryText = '';
            const cachedSummary = this.cachedSummaries.get(sessionId);
            if (cachedSummary) {
                summaryText = `\n\n*Conversation Summary:*\n${cachedSummary}`;
            }
            
            // Update the original message to show chat ended AND preserve summary
            await this.slack.chat.update({
                channel: this.channelId,
                ts: messageTs,  // This is the original message timestamp
                text: `🔴 Chat Ended by ${userName}`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `🔴 *Chat Ended by ${userName}*\nSession: \`${sessionId}\`\n⏱️ Total Duration: ${finalDurationText}${summaryText}\n\nChat has been closed.`
                        }
                    }
                ]
            });
            
            // Send a final message in the thread
            await this.slack.chat.postMessage({
                channel: this.channelId,
                thread_ts: messageTs,
                text: `🔴 Chat ended by ${userName} after ${finalDurationText}.`
            });

            // Log disconnection to database
            await databaseService.logAgentDisconnection(sessionId, 'agent_ended');

            // Notify customer via WebSocket
            if (global.io) {
                global.io.to(sessionId).emit('agent_disconnected', {
                    sessionId: sessionId,
                    message: `The Support Specialist has ended the conversation. You can continue chatting with our Assistant.`
                });
            }

            // Remove from active sessions in Redis using persistentUserId
            if (session.persistentUserId || persistentUserId) {
                await redisService.deleteActiveSession(session.persistentUserId || persistentUserId);
                console.log(`🔴 Deleted active session for ${session.persistentUserId || persistentUserId}`);
                
                // Clear user inactivity timeout
                this.clearUserInactivityTimeout(session.persistentUserId || persistentUserId);
            }
            
            // Clean up cached summary after preserving it in the final message
            this.cachedSummaries.delete(sessionId);
            
            console.log(`🔴 Agent ${userName} ended session ${sessionId} successfully`);
            return { status: 'ended' };

        } catch (error) {
            console.error(`🔴 Error in handleEndChatButton:`, error);
            return {
                status: 'error',
                message: 'Error ending chat session'
            };
        }
    }


    // Find session by thread timestamp using Redis
    async getSessionByThreadTs(threadTs) {
        const activeSessions = await redisService.getAllActiveSessions();
        
        for (const [persistentUserId, session] of Object.entries(activeSessions)) {
            if (session && session.threadTs === threadTs) {
                return { persistentUserId, session };
            }
        }
        return null;
    }

    // Handle incoming messages from Slack agents
    async handleAgentMessage(threadTs, message, userId, userName) {
        // Find the session associated with this thread
        const sessionData = await this.getSessionByThreadTs(threadTs);
        
        if (!sessionData) {
            console.log(`No active session found for thread ${threadTs}`);
            return { status: 'no_session' };
        }

        const { persistentUserId, session } = sessionData;

        // Send to current sessionId for WebSocket routing
        if (global.io && session.currentSessionId) {
            global.io.to(session.currentSessionId).emit('agent_message', {
                sessionId: session.currentSessionId,
                message: message,
                agentName: userName || session.agentName,
                timestamp: new Date().toISOString()
            });
            console.log(`Sent agent message to session ${session.currentSessionId}: ${message}`);
            
            // Check if the thread still exists - if not, clean up the session
            try {
                await this.slack.conversations.replies({
                    channel: this.channelId,
                    ts: threadTs,
                    limit: 1
                });
            } catch (threadError) {
                if (threadError.data?.error === 'thread_not_found' || threadError.data?.error === 'message_not_found') {
                    console.log(`🧹 Thread ${threadTs} no longer exists, cleaning up session`);
                    await this.forceEndSession(session.currentSessionId);
                    return { status: 'thread_deleted', message: 'Thread was deleted, session cleaned up' };
                }
            }
            
            // Add ✅ reaction to confirm delivery to chatbot
            try {
                // We need the timestamp of the agent's message to react to it
                // Since this is called from handleAgentMessage, we need to find the agent's message
                // For now, let's add the reaction to a recent message in the thread
                const recentMessages = await this.slack.conversations.replies({
                    channel: this.channelId,
                    ts: threadTs,
                    limit: 5,
                    oldest: threadTs
                });
                
                // Find the most recent message from this agent
                if (recentMessages.messages) {
                    const agentMessage = recentMessages.messages
                        .reverse()
                        .find(msg => msg.user === userId && msg.text && msg.text.trim());
                    
                    if (agentMessage) {
                        await this.slack.reactions.add({
                            channel: this.channelId,
                            timestamp: agentMessage.ts,
                            name: 'white_check_mark'
                        });
                        console.log(`✅ Added delivery confirmation to message: ${agentMessage.text.substring(0, 50)}...`);
                    }
                }
            } catch (reactionError) {
                // Don't let reaction errors affect the core functionality
                console.log('Could not add delivery confirmation:', reactionError.message);
            }
        }

        return { status: 'sent_to_user' };
    }
    
    // Reconnect a persistent user to an existing handoff request  
    async reconnectPersistentUser(persistentUserId, newSessionId) {
        const pendingHandoff = await redisService.getHandoffState(persistentUserId);
        
        if (pendingHandoff) {
            console.log(`Reconnecting persistent user ${persistentUserId} from session ${pendingHandoff.sessionId} to ${newSessionId}`);
            
            // Update session mapping in Redis - NO user notifications
            await this.mapUserToSession(persistentUserId, newSessionId);
            pendingHandoff.sessionId = newSessionId;
            await redisService.setHandoffState(persistentUserId, pendingHandoff, 300);
            
            return true;
        }
        
        // Check if user has an active agent session in Redis
        const userState = await redisService.getUserState(persistentUserId);
        if (userState && userState.agentConnected === 'true') {  // Redis stores booleans as strings
            console.log(`Reconnecting persistent user ${persistentUserId} to active agent session, updating to ${newSessionId}`);
            
            // Update session mapping in Redis - NO user notifications
            await this.mapUserToSession(persistentUserId, newSessionId);
            
            return true;
        }
        
        return false;
    }
    
    // Handle session reconnection for other services
    async handleSessionReconnection(newSessionId, persistentUserId) {
        return await this.reconnectPersistentUser(persistentUserId, newSessionId);
    }

    // Helper function to end session by persistent user ID
    async forceEndSessionByPersistentUserId(persistentUserId) {
        console.log(`🧹 Force ending session for persistent user: ${persistentUserId}`);
        
        // Get current session ID for this user
        const userState = await redisService.getUserState(persistentUserId);
        const currentSessionId = userState?.currentSessionId;
        
        if (currentSessionId) {
            await this.forceEndSession(currentSessionId);
        } else {
            // Clean up directly if no current session ID
            await this.cleanupSessionData(persistentUserId, null);
        }
    }

    // Clean up session data when no sessionId available
    async cleanupSessionData(persistentUserId, sessionId) {
        console.log(`🧹 Cleaning up session data for user: ${persistentUserId}, session: ${sessionId}`);
        
        // Clean up Redis state
        if (persistentUserId) {
            await redisService.deleteActiveSession(persistentUserId);
            await redisService.deleteUserState(persistentUserId);
            await redisService.deleteHandoffState(persistentUserId);
        }
        
        // Clean up timers
        if (persistentUserId) {
            this.clearHandoffTimeout(persistentUserId);
            this.clearUserInactivityTimeout(persistentUserId);
            this.stopWaitingTimeUpdater(persistentUserId);
        }
        
        if (sessionId) {
            this.stopSessionDurationUpdater(sessionId);
        }
        
        console.log(`🧹 Session data cleaned up`);
    }

    // Manual cleanup function for broken sessions (when threads get deleted)
    async forceEndSession(sessionId) {
        console.log(`🧹 Force ending session: ${sessionId}`);
        
        // Find the persistent user ID for this session
        const persistentUserId = await redisService.getSessionMapping(sessionId);
        if (persistentUserId) {
            // Clean up Redis state
            await redisService.deleteActiveSession(persistentUserId);
            await redisService.deleteUserState(persistentUserId);
            await redisService.deleteHandoffState(persistentUserId);
            
            // Stop any running timers
            this.stopSessionDurationUpdater(persistentUserId);
            this.clearHandoffTimeout(persistentUserId);
            this.clearUserInactivityTimeout(persistentUserId);
            
            console.log(`🧹 Cleaned up session ${sessionId} for user ${persistentUserId}`);
            return { status: 'cleaned', persistentUserId };
        } else {
            console.log(`🧹 No persistent user found for session ${sessionId}`);
            return { status: 'not_found' };
        }
    }
}

module.exports = new SlackService();