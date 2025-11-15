require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const chatRoutes = require('./routes/chat');
const databaseService = require('./services/databaseService');

const app = express();

// Trust proxy for Railway/cloud deployments
app.set('trust proxy', 1);

const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PORT = process.env.PORT || 3000;

// Rate limiting configuration
const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Limit each IP to 50 chat requests per windowMs
    message: {
        output: "Too many messages sent. Please wait a moment before trying again.",
        sessionId: null,
        type: 'rate_limit_error'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for health checks
        return req.path === '/health';
    }
});

const slackLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // Limit Slack webhooks to 30 requests per minute
    message: {
        status: 'rate_limited',
        message: 'Too many webhook requests'
    },
    standardHeaders: true,
    legacyHeaders: false
});

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // Limit each IP to 200 requests per windowMs (general protection)
    message: {
        error: "Too many requests from this IP, please try again later.",
        retryAfter: 15 * 60 // 15 minutes in seconds
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Middleware
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : "*",
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: '10mb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply general rate limiting to all routes
app.use(generalLimiter);

// Make io available globally for services
global.io = io;

// Routes with specific rate limiting
app.use('/chat', chatLimiter); // Apply chat-specific rate limiting
app.use('/slack', slackLimiter); // Apply Slack-specific rate limiting
app.use('/', chatRoutes);

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let userSessionId = null;

    socket.on('join_session', (sessionId) => {
        socket.join(sessionId);
        userSessionId = sessionId; // Store the session ID for this socket
        console.log(`User ${socket.id} joined session ${sessionId}`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        // If this user was in a session, handle the disconnection
        if (userSessionId) {
            const slackService = require('./services/slackService');

            // Check if it's an active session (agent already connected) - now async
            slackService.isSessionActive(userSessionId).then(isActive => {
                if (isActive) {
                    console.log(`Notifying agent about disconnection for active session: ${userSessionId}`);
                    slackService.disconnectSession(userSessionId).catch(err => {
                        console.error('Error disconnecting active session:', err);
                    });
                }
            }).catch(err => {
                console.error('Error checking session status:', err);
            });

            // Check if it's a waiting session (user accepted but no agent yet) - now async
            slackService.isSessionWaiting(userSessionId).then(isWaiting => {
                if (isWaiting) {
                    console.log(`Handling disconnection for waiting session: ${userSessionId}`);
                    slackService.handleWaitingSessionDisconnect(userSessionId).catch(err => {
                        console.error('Error handling waiting session disconnect:', err);
                    });
                }
            }).catch(err => {
                console.error('Error checking waiting session status:', err);
            });
        }
    });
});

// Initialize database and start server
async function startServer() {
    // Initialize database connection
    const dbConnected = await databaseService.initialize();

    if (!dbConnected) {
        console.error('❌ Failed to connect to database. Check your DATABASE_URL in .env');
        console.log('Continuing without database features...');
    }

    // Start server
    server.listen(PORT, () => {
        console.log(`Achora Chatbot running on port ${PORT}`);
        console.log(`Webhook endpoint: http://localhost:${PORT}/chat`);
        console.log(`Health check: http://localhost:${PORT}/health`);
        console.log(`Slack webhook: http://localhost:${PORT}/slack/webhook`);
        console.log(`WebSocket server running`);

        if (dbConnected) {
            console.log(`✅ Database connected - Lead capture active`);
        }
    });
}

startServer();
