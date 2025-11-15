const aiService = require('../services/aiService');
const slackService = require('../services/slackService');
const databaseService = require('../services/databaseService');
const redisService = require('../services/redisService');
const memoryService = require('../services/memoryService');

class ChatController {
    async handleChatMessage(req, res) {
        console.log('=== INCOMING WEBHOOK ===');
        console.log('Headers:', req.headers);
        console.log('Body:', req.body);
        console.log('========================');

        try {
            // Extract the data from the request
            const { message, sessionId, persistentUserId, type, isHumanConnected, eventType } = req.body;
            
            // Handle session reconnection for persistent users
            if (persistentUserId && sessionId) {
                // Check if this persistent user has a pending handoff or active session
                const reconnected = await slackService.handleSessionReconnection(sessionId, persistentUserId);
                if (reconnected) {
                    console.log(`Reconnected persistent user ${persistentUserId} to session ${sessionId}`);
                }
            }

            // Handle session state check (for page refresh/reconnection)
            if (type === 'check_session_state') {
                console.log(`🔍 Session state check for session ${sessionId}, user ${persistentUserId}`);
                
                const isActive = persistentUserId ? 
                    await slackService.isSessionActiveForUser(persistentUserId) : 
                    await slackService.isSessionActive(sessionId);
                
                if (isActive) {
                    // Get specialist info if available
                    const activeSession = persistentUserId ? 
                        await slackService.getActiveSessionForUser(persistentUserId) : null;
                    
                    return res.json({
                        specialistConnected: true,
                        specialistName: activeSession?.agentName || 'Support Specialist',
                        type: 'specialist_connected',
                        sessionId: sessionId
                    });
                } else {
                    // Check if user is waiting for a specialist
                    if (persistentUserId) {
                        const handoffState = await redisService.getHandoffState(persistentUserId);
                        
                        if (handoffState && handoffState.requestTime) {
                            console.log(`🔍 Found waiting state for user ${persistentUserId}, request time: ${handoffState.requestTime}`);
                            return res.json({
                                specialistConnected: false,
                                waiting: true,
                                waitingStartTime: handoffState.requestTime,
                                type: 'waiting_for_specialist',
                                sessionId: sessionId
                            });
                        }
                    }
                    
                    return res.json({
                        specialistConnected: false,
                        waiting: false,
                        type: 'no_specialist',
                        sessionId: sessionId
                    });
                }
            }

            // Handle event tracking
            if (type === 'track_event') {
                console.log(`Event tracking: ${eventType} for session ${sessionId}`);
                
                switch (eventType) {
                    case 'WIDGET_OPENED':
                        await databaseService.trackWidgetOpened(sessionId);
                        break;
                    case 'CONTINUE_PRESSED':
                        await databaseService.trackContinuePressed(sessionId);
                        break;
                }
                
                return res.json({ status: 'ok' });
            }

            // Handle link click tracking
            if (type === 'link_click') {
                const clickedUrl = req.body.metadata?.clickedUrl;
                console.log(`Link clicked: ${clickedUrl} for session ${sessionId}`);
                
                if (clickedUrl && sessionId) {
                    await databaseService.recordLinkClick(sessionId, clickedUrl);
                } else {
                    console.log(`Missing sessionId (${sessionId}) or clickedUrl (${clickedUrl}) for link click tracking`);
                }
                
                return res.json({ status: 'ok' });
            }

            // Route 0: Human handoff request (from button or Accept response)
            if (message === 'REQUEST_HUMAN_HANDOFF' || type === 'human_handoff_request' || type === 'accept_human_handoff') {
                console.log('Route 0: Human handoff request');
                
                // Track human request event
                await databaseService.trackHumanRequested(sessionId);
                
                const conversationHistory = req.body.conversationHistory || [];
                const result = await slackService.requestHumanAgent(sessionId, message, conversationHistory, persistentUserId);

                return res.json({
                    output: result.message,
                    sessionId: sessionId,
                    type: result.status
                });
            }

            // Handle decline of human handoff suggestion
            if (type === 'decline_human_handoff') {
                console.log('User declined human handoff suggestion');
                
                // Clean up any waiting session
                if (slackService.isSessionWaiting(sessionId)) {
                    await slackService.handleWaitingSessionDisconnect(sessionId);
                }
                
                // Check current state
                const currentState = await aiService.getSessionState(sessionId, persistentUserId);
                
                // Check if already in LEAD_CAPTURE or NORMAL_CHAT state
                if (currentState !== aiService.SessionState.SEEKING_HANDOFF) {
                    console.log(`Session ${sessionId} already in ${currentState} state - ignoring decline`);
                    return res.json({
                        output: "No worries! I'm here whenever you need help with NDIS information. Feel free to ask me any questions!",
                        sessionId: sessionId,
                        type: 'bot_response'
                    });
                }
                
                // Mark session as declined human handoff (transitions to LEAD_CAPTURE state)
                await aiService.markHumanHandoffDeclined(sessionId, persistentUserId);
                
                // Log the interaction
                await databaseService.logMessage(sessionId, 'system', 'User declined human handoff - entering LEAD_CAPTURE state');
                
                // Acknowledge and continue - AI will handle lead capture naturally
                const acknowledgmentMessage = "No problem at all! I'm here to help with any NDIS questions you have. What would you like to know more about?";
                
                await databaseService.logMessage(sessionId, 'bot', acknowledgmentMessage);
                
                return res.json({
                    output: acknowledgmentMessage,
                    sessionId: sessionId,
                    type: 'bot_response',
                    leadCaptureMode: true  // Indicate to frontend that we're in lead capture mode
                });
            }

            // Duplicate handler removed - accept_human_handoff is handled in Route 0 above

            // Route 1: User message to human OR active session check
            const isActive = persistentUserId ? 
                await slackService.isSessionActiveForUser(persistentUserId) : 
                await slackService.isSessionActive(sessionId);
                
            if (type === 'user_to_human' || isActive) {
                console.log('Route 1: User to human message');
                const result = await slackService.sendToHuman(sessionId, message, persistentUserId);

                // If thread was deleted, clean up and route to AI instead
                if (result.status === 'thread_deleted') {
                    console.log('Thread was deleted, routing message to AI instead');
                    // Fall through to AI processing below
                } else {
                    return res.json({
                        output: result.message,
                        sessionId: sessionId,
                        type: result.status
                    });
                }
            }

            // user_disconnect type removed - no longer needed with persistent user IDs

            // Check for callback requests from the frontend button (only appears after hours)
            if (message === "I would like to request a callback. Can you please help me schedule a call?") {
                console.log('Callback request detected');
                
                // Track callback button pressed
                await databaseService.trackCallbackPressed(sessionId);
                
                // Get current state
                const currentState = await aiService.getSessionState(sessionId, persistentUserId);
                console.log(`Current state for callback request: ${currentState}`);
                
                // Log the interaction
                await databaseService.logMessage(sessionId, 'user', message);
                
                // Always transition to CALLBACK_REQUEST state when callback is requested (unless already captured)
                if (currentState !== aiService.SessionState.NORMAL_CHAT) {
                    console.log(`Transitioning from ${currentState} to CALLBACK_REQUEST`);
                    
                    // Transition to CALLBACK_REQUEST state
                    await aiService.markCallbackRequested(sessionId, persistentUserId);
                    
                    // Let AI handle the response in CALLBACK_REQUEST mode
                    const aiResponse = await aiService.getChatResponse(message, sessionId, persistentUserId);
                    const responseText = typeof aiResponse === 'string' ? aiResponse : aiResponse.message;
                    
                    await databaseService.logMessage(sessionId, 'bot', responseText);
                    
                    return res.json({
                        output: responseText,
                        sessionId: sessionId,
                        type: 'bot_response',
                        leadCaptureMode: true
                    });
                }
                
                // For other states (LEAD_CAPTURE or NORMAL_CHAT), let AI handle it normally
                const aiResponse = await aiService.getChatResponse(message, sessionId, persistentUserId);
                
                // Handle response
                const responseText = typeof aiResponse === 'string' ? aiResponse : aiResponse.message;
                await databaseService.logMessage(sessionId, 'bot', responseText);
                
                // Clean LEAD_CAPTURED marker from response
                let cleanResponse = responseText;
                if (responseText.includes('LEAD_CAPTURED:')) {
                    cleanResponse = responseText.replace(/LEAD_CAPTURED:.*?(?=\n|$)/g, '').trim();
                }
                
                // Get session state once for response building
                const responseState = await aiService.getSessionState(sessionId, persistentUserId);
                
                return res.json({
                    output: cleanResponse,
                    sessionId: sessionId,
                    type: 'bot_response',
                    leadCaptureMode: responseState === aiService.SessionState.LEAD_CAPTURE
                });
            }

            // Check for explicit human handoff requests - process these immediately
            const explicitHumanPatterns = [
                /\b(talk|speak)\s+to\s+(a\s+)?(human|person|real\s+person|agent|someone)\b/i,
                /\b(connect|put)\s+me\s+(to|with)\s+(a\s+)?(human|person|agent|someone)\b/i,
                /\bcan\s+i\s+talk\s+to\s+someone\b/i,
                /\b(human|customer)\s+(service|support|agent|help)\b/i,
                /\b(transfer|escalate)\s+me\b/i,
                /\b(manager|supervisor)\b/i
            ];

            const isExplicitHumanRequest = explicitHumanPatterns.some(pattern => 
                pattern.test(message.toLowerCase())
            );

            if (isExplicitHumanRequest) {
                // Explicit human request - bypass AI and offer handoff immediately
                console.log('Explicit human request detected - offering handoff');
                
                // Log the message to database
                await databaseService.logMessage(sessionId, 'user', message);
                await databaseService.logMessage(sessionId, 'bot', 'Human connection requested');

                const response = {
                    output: "I understand you'd like to speak with a Support Specialist directly. Let me connect you right away.",
                    sessionId: sessionId,
                    type: 'human_handoff_suggestion',
                    suggestion: "It seems like you might benefit from speaking with someone from our team. Would you like me to connect you with a Support Specialist?"
                };

                return res.json(response);
            }

            // Default: Regular AI processing
            console.log('Default route: AI processing');
            
            // Track conversation initiation if this is the first message from this session
            // We'll use the memory service to check if this is the first interaction
            const conversationHistory = memoryService.getConversationHistory(sessionId);
            if (!conversationHistory || conversationHistory.length === 0) {
                // First message - no previous context
            }
            
            const aiResponse = await aiService.getChatResponse(message, sessionId, persistentUserId);

            // Handle structured AI responses (handoff suggestions or lead capture)
            if (typeof aiResponse === 'object' && aiResponse.type) {
                // Log the message to database
                await databaseService.logMessage(sessionId, 'user', message);
                await databaseService.logMessage(sessionId, 'bot', aiResponse.message);

                console.log(`🤖 AI routing decision: ${aiResponse.type} - ${aiResponse.reason}`);

                // Process lead capture only if response contains marker
                if (aiResponse.message && aiResponse.message.includes('LEAD_CAPTURED:')) {
                    const lead = await this.handleLeadCapture(sessionId, aiResponse.message, persistentUserId);
                    if (lead) {
                        console.log(`🎯 New lead captured: ${lead.name} (${lead.email})`);
                    }
                }

                // Handle callback escape - user refuses to provide details
                if (aiResponse.message && aiResponse.message.includes('CALLBACK_ESCAPE')) {
                    console.log(`🚪 User escaped from callback mode - transitioning to NORMAL_CHAT`);
                    await aiService.markLeadCaptured(sessionId, persistentUserId);
                }

                // Remove LEAD_CAPTURED marker from response before sending to client
                let cleanResponse = aiResponse.message;
                if (aiResponse.message && aiResponse.message.includes('LEAD_CAPTURED:')) {
                    cleanResponse = aiResponse.message.replace(/LEAD_CAPTURED:.*?(?=\n|$)/g, '').trim();
                }

                // Remove CALLBACK_ESCAPE marker from response before sending to client
                if (cleanResponse.includes('CALLBACK_ESCAPE')) {
                    cleanResponse = cleanResponse.replace(/CALLBACK_ESCAPE/g, '').trim();
                }

                if (aiResponse.type === 'human_handoff_suggestion') {
                    // Mark handoff as offered now that we're presenting it to user
                    await aiService.markHandoffOffered(sessionId, persistentUserId);
                    
                    return res.json({
                        output: cleanResponse,
                        sessionId: sessionId,
                        type: 'human_handoff_suggestion',
                        suggestion: aiResponse.suggestion || "Would you like me to connect you with a Support Specialist?"
                    });
                }
            }

            // Normal AI response (string)
            const responseText = typeof aiResponse === 'string' ? aiResponse : aiResponse.message;

            // Log the message to database
            await databaseService.logMessage(sessionId, 'user', message);
            await databaseService.logMessage(sessionId, 'bot', responseText);

            // Process lead capture only if response contains marker
            if (responseText && responseText.includes('LEAD_CAPTURED:')) {
                const lead = await this.handleLeadCapture(sessionId, responseText, persistentUserId);
                if (lead) {
                    console.log(`🎯 New lead captured: ${lead.name} (${lead.email})`);
                }
            }

            // Handle callback escape - user refuses to provide details
            if (responseText && responseText.includes('CALLBACK_ESCAPE')) {
                console.log(`🚪 User escaped from callback mode - transitioning to NORMAL_CHAT`);
                await aiService.markLeadCaptured(sessionId, persistentUserId);
            }

            // Remove LEAD_CAPTURED marker from response before sending to client
            let cleanResponse = responseText;
            if (responseText.includes('LEAD_CAPTURED:')) {
                cleanResponse = responseText.replace(/LEAD_CAPTURED:.*?(?=\n|$)/g, '').trim();
            }

            // Remove CALLBACK_ESCAPE marker from response before sending to client
            if (cleanResponse.includes('CALLBACK_ESCAPE')) {
                cleanResponse = cleanResponse.replace(/CALLBACK_ESCAPE/g, '').trim();
            }

            // Get session state once for response building - avoid hanging on async call
            const currentSessionState = await aiService.getSessionState(sessionId, persistentUserId);
            
            const response = {
                output: cleanResponse,
                sessionId: sessionId,
                type: 'bot_response',
                // Include lead capture mode flag if in LEAD_CAPTURE state
                leadCaptureMode: currentSessionState === aiService.SessionState.LEAD_CAPTURE
            };

            res.json(response);

        } catch (error) {
            console.error('Error processing request:', error);
            res.status(500).json({
                output: "I'm sorry, I'm having trouble responding right now. Please try again!",
                sessionId: req.body.sessionId,
                type: 'error_response'
            });
        }
    }

    async handleSlackWebhook(req, res) {
        console.log('=== SLACK WEBHOOK ===');
        console.log('Headers:', req.headers);
        console.log('Body:', req.body);
        console.log('Body type:', typeof req.body);
        console.log('Challenge present:', !!req.body?.challenge);
        console.log('Payload present:', !!req.body?.payload);
        console.log('Event type:', req.body?.event?.type);
        console.log('Content-Type header:', req.headers['content-type']);
        console.log('Event present:', !!req.body?.event);
        console.log('Raw body keys:', Object.keys(req.body || {}));
        console.log('Body has string payload?', typeof req.body?.payload === 'string');
        console.log('=====================');

        try {
            // Handle Slack URL verification challenge
            if (req.body?.challenge) {
                console.log('Slack challenge received:', req.body.challenge);
                return res.status(200).json({ challenge: req.body.challenge });
            }

            // Handle Slack Events API (for messages)
            if (req.body?.event) {
                const event = req.body.event;
                console.log('Slack event received:', event.type);
                
                // Handle message events
                if (event.type === 'message' && event.thread_ts && !event.bot_id) {
                    console.log('Agent message in thread:', event.text);
                    console.log('Thread TS:', event.thread_ts);
                    console.log('User:', event.user);
                    
                    // Get user info if available
                    let userName = 'Agent';
                    try {
                        const userInfo = await slackService.slack.users.info({ user: event.user });
                        userName = userInfo.user?.real_name || userInfo.user?.name || 'Agent';
                    } catch (error) {
                        console.log('Could not fetch user info:', error.message);
                    }
                    
                    // Send message to the user via WebSocket
                    await slackService.handleAgentMessage(
                        event.thread_ts,
                        event.text,
                        event.user,
                        userName
                    );
                }
                
                return res.status(200).json({ status: 'ok' });
            }

            // Check if payload exists (for interactive components)
            if (!req.body?.payload) {
                console.log('No payload found in request');
                return res.status(200).json({ status: 'ok' });
            }

            // Parse the payload
            console.log('Raw payload:', req.body.payload);
            const payload = JSON.parse(req.body.payload);
            console.log('Parsed payload type:', payload.type);

            // Handle button clicks (Block Kit uses 'block_actions')
            if (payload.type === 'block_actions' && payload.actions?.length > 0) {
                const action = payload.actions[0];
                console.log('🔥 BUTTON CLICK DETECTED!');
                console.log('Action received:', action.action_id);
                console.log('Session ID:', action.value);
                console.log('User:', payload.user?.username);

                if (action.action_id === 'accept_chat') {
                    console.log('🎯 ACCEPT CHAT BUTTON CLICKED!');
                    const sessionId = action.value;
                    const user = payload.user;
                    const messageTs = payload.message.ts;

                    console.log(`Agent ${user.username} accepting session ${sessionId}`);

                    const result = await slackService.handleAcceptButton(
                        sessionId,
                        user.id,
                        user.username,
                        messageTs
                    );

                    console.log('Accept button result:', result.status);
                    return res.status(200).json({ status: 'ok' });
                }

                if (action.action_id === 'end_chat') {
                    const sessionId = action.value;
                    const user = payload.user;
                    const messageTs = payload.message.ts;

                    console.log(`Agent ${user.username} ending session ${sessionId}`);

                    const result = await slackService.handleEndChatButton(
                        sessionId,
                        user.id,
                        user.username,
                        messageTs
                    );

                    console.log('End chat result:', result.status);
                    return res.status(200).json({ status: 'ok' });
                }
            }

            // Default response
            res.status(200).json({ status: 'ok' });

        } catch (error) {
            console.error('Error handling Slack webhook:', error);
            console.error('Error details:', error.message);
            res.status(200).json({ status: 'ok' }); // Always return 200 to avoid Slack retries
        }
    }

    async healthCheck(req, res) {
        res.json({ status: 'ok', service: 'achora-chatbot' });
    }

    /**
     * Handle lead capture directly - simplified architecture
     * Parse LEAD_CAPTURED marker and save to database
     */
    async handleLeadCapture(sessionId, botResponse, persistentUserId = null) {
        try {
            // Check if AI response contains LEAD_CAPTURED marker
            if (!botResponse || !botResponse.includes('LEAD_CAPTURED:')) {
                return null;
            }

            const dataString = botResponse.split('LEAD_CAPTURED:')[1];
            if (!dataString) {
                console.error('No data after LEAD_CAPTURED marker');
                return null;
            }

            // Extract only the first line after LEAD_CAPTURED: to avoid capturing extra text
            const firstLine = dataString.split('\n')[0].trim();
            const parts = firstLine.split(',').map(part => part.trim());

            if (parts.length < 4) {
                console.error('LEAD_CAPTURED: Insufficient data parts:', parts);
                return null;
            }

            const [firstName, lastName, email, phone] = parts;
            const fullName = `${firstName} ${lastName}`.trim();

            // Create lead object
            const leadData = {
                name: fullName,
                firstName: firstName,
                lastName: lastName,
                email: email,
                phone: phone,
                source: 'chatbot',
                clientId: 'achora',
                sessionId: sessionId
            };

            console.log(`✅ Lead captured: ${fullName} (${email})`);

            // Save to database
            const savedLead = await databaseService.captureLead(leadData);
            console.log(`🎯 Lead captured: ${fullName} (${email}) ${phone} - saved to database`);

            // Mark lead as captured in session state (triggers NORMAL_CHAT transition)
            await aiService.markLeadCaptured(sessionId, persistentUserId);

            return savedLead;

        } catch (error) {
            console.error('Error handling lead capture:', error);
            return null;
        }
    }
}

module.exports = new ChatController();