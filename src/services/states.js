/**
 * Session states enum for NDIS chatbot
 * 4-state session management pattern + human connected state
 */
const SessionState = {
    SEEKING_HANDOFF: 'seeking_handoff',     // Default - AI tries to create human connections
    CALLBACK_REQUEST: 'callback_request',   // User clicked "Request Callback" - direct lead collection
    LEAD_CAPTURE: 'lead_capture',           // User declined handoff - conversational lead capture
    NORMAL_CHAT: 'normal_chat',             // Handoff completed OR lead captured - just chat
    HUMAN_CONNECTED: 'human_connected'      // Active human agent connection
};

module.exports = { SessionState };