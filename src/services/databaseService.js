const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();
const TimezoneUtils = require('../utils/timezoneUtils');

// Initialize Sequelize with PostgreSQL
const sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false, // Disable SQL query logging for production
    pool: {
        max: parseInt(process.env.DB_POOL_MAX || '20'), // Supabase paid plan can handle this
        min: parseInt(process.env.DB_POOL_MIN || '5'), // Keep 5 connections alive
        acquire: 30000, // Maximum time in ms to get connection
        idle: 600000, // Close idle connections after 10 minutes
        evict: 60000, // Check for idle connections every minute
        handleDisconnects: true // Automatically handle disconnects
    },
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false
        }
    }
});

// Define Lead model
const Lead = sequelize.define('Lead', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    sessionId: {
        type: DataTypes.STRING,
        allowNull: false
    },
    clientId: {
        type: DataTypes.STRING,
        defaultValue: 'achora'
    },
    firstName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    lastName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            isEmail: true
        }
    },
    phone: {
        type: DataTypes.STRING,
        allowNull: false
    },
    capturedAt: {
        type: DataTypes.DATE,
        defaultValue: () => TimezoneUtils.nowInAEST()
    },
    source: {
        type: DataTypes.STRING,
        defaultValue: 'chatbot'
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'new'
    },
    notes: {
        type: DataTypes.TEXT
    }
});

// Define ChatLog model for logging
const ChatLog = sequelize.define('ChatLog', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    sessionId: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true
    },
    convoId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    clientId: {
        type: DataTypes.STRING,
        defaultValue: 'achora'
    },
    messageType: {
        type: DataTypes.ENUM('user', 'bot', 'human', 'system'),
        allowNull: false
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    metadata: {
        type: DataTypes.JSONB,
        defaultValue: {}
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: () => TimezoneUtils.nowInAEST()
    }
});

// Define UserEvents model for event tracking
const UserEvents = sequelize.define('UserEvents', {
    sessionId: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    clientId: {
        type: DataTypes.STRING,
        defaultValue: 'achora'
    },
    pageLoaded: {
        type: DataTypes.DATE,
        allowNull: true
    },
    widgetOpened: {
        type: DataTypes.DATE,
        allowNull: true
    },
    requestedHuman: {
        type: DataTypes.DATE,
        allowNull: true
    },
    pressedAccept: {
        type: DataTypes.DATE,
        allowNull: true
    },
    pressedCallback: {
        type: DataTypes.DATE,
        allowNull: true
    },
    pressedContinue: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    timestamps: true,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    hooks: {
        beforeCreate: (userEvent, options) => {
            userEvent.createdAt = TimezoneUtils.nowInAEST();
            userEvent.updatedAt = TimezoneUtils.nowInAEST();
        },
        beforeUpdate: (userEvent, options) => {
            userEvent.updatedAt = TimezoneUtils.nowInAEST();
        }
    }
});

// Define LinksClicked model
const LinksClicked = sequelize.define('LinksClicked', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    sessionId: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true
    },
    clientId: {
        type: DataTypes.STRING,
        defaultValue: 'achora'
    },
    url: {
        type: DataTypes.STRING,
        allowNull: false
    },
    dateCreated: {
        type: DataTypes.DATE,
        defaultValue: () => TimezoneUtils.nowInAEST()
    }
});

// Define AgentConnection model
const AgentConnection = sequelize.define('AgentConnection', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    sessionId: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true
    },
    persistentUserId: {
        type: DataTypes.STRING,
        allowNull: true,
        index: true
    },
    clientId: {
        type: DataTypes.STRING,
        defaultValue: 'achora'
    },
    agentName: {
        type: DataTypes.STRING,
        allowNull: false
    },
    agentId: {
        type: DataTypes.STRING
    },
    // Slack-specific fields
    threadTs: {
        type: DataTypes.STRING,
        allowNull: true
    },
    messageTs: {
        type: DataTypes.STRING,
        allowNull: true
    },
    conversationSummary: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // Timing fields
    handoffRequestedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    connectedAt: {
        type: DataTypes.DATE,
        defaultValue: () => TimezoneUtils.nowInAEST()
    },
    disconnectedAt: {
        type: DataTypes.DATE
    },
    waitingDuration: {
        type: DataTypes.INTEGER // seconds between request and connection
    },
    sessionDuration: {
        type: DataTypes.INTEGER // seconds of actual chat time
    },
    status: {
        type: DataTypes.ENUM('connected', 'disconnected', 'failed', 'timeout', 'user_inactive'),
        defaultValue: 'connected'
    },
    disconnectionReason: {
        type: DataTypes.ENUM('agent_ended', 'user_left', 'timeout', 'system_error', 'user_inactivity_10min'),
        allowNull: true
    }
});

// Database service class
class DatabaseService {
    constructor() {
        this.sequelize = sequelize;
        this.Lead = Lead;
        this.ChatLog = ChatLog;
        this.UserEvents = UserEvents;
        this.LinksClicked = LinksClicked;
        this.AgentConnection = AgentConnection;
    }

    async initialize() {
        try {
            await sequelize.authenticate();
            console.log('✅ Database connection established');

            // Sync all models with database
            await sequelize.sync({ alter: true });
            console.log('✅ Database models synchronized');

            // Connection keepalive removed - let pool manage connections naturally

            return true;
        } catch (error) {
            console.error('❌ Unable to connect to database:', error);
            return false;
        }
    }


    // Lead capture methods
    async captureLead(leadData) {
        try {
            const lead = await this.Lead.create(leadData);
            console.log(`✅ Lead captured: ${lead.firstName} ${lead.lastName} (${lead.email})`);
            return lead;
        } catch (error) {
            console.error('Error capturing lead:', error);
            throw error;
        }
    }

    async getLeadBySession(sessionId) {
        return await this.Lead.findOne({ 
            where: { sessionId },
            order: [['createdAt', 'DESC']]
        });
    }

    async updateLeadStatus(leadId, status) {
        return await this.Lead.update(
            { status },
            { where: { id: leadId } }
        );
    }

    // Chat logging methods
    async logMessage(sessionId, messageType, message, metadata = {}) {
        try {
            // Get the next convo_id for this session
            const lastMessage = await this.ChatLog.findOne({
                where: { sessionId },
                order: [['convoId', 'DESC']],
                attributes: ['convoId']
            });
            
            const convoId = lastMessage ? lastMessage.convoId + 1 : 1;
            
            const log = await this.ChatLog.create({
                sessionId,
                convoId,
                messageType,
                message,
                metadata
            });
            return log;
        } catch (error) {
            console.error('Error logging message:', error);
            // Don't throw - logging shouldn't break the app
        }
    }

    async getChatHistory(sessionId, limit = 50) {
        return await this.ChatLog.findAll({
            where: { sessionId },
            order: [['timestamp', 'ASC']],
            limit
        });
    }

    // Link click tracking methods
    async recordLinkClick(sessionId, url) {
        try {
            const linkClick = await this.LinksClicked.create({
                sessionId,
                url
            });
            console.log(`✅ Link click recorded: ${url} for session ${sessionId}`);
            return linkClick;
        } catch (error) {
            console.error('Error recording link click:', error);
            throw error;
        }
    }

    async getLinkClicksBySession(sessionId) {
        return await this.LinksClicked.findAll({
            where: { sessionId },
            order: [['dateCreated', 'DESC']]
        });
    }

    async getLinkClickStats(clientId = 'achora', days = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        return await this.LinksClicked.findAll({
            where: {
                clientId,
                dateCreated: {
                    [Sequelize.Op.gte]: startDate
                }
            },
            attributes: [
                'url',
                [sequelize.fn('COUNT', sequelize.col('id')), 'clicks'],
                [sequelize.fn('DATE', sequelize.col('dateCreated')), 'date']
            ],
            group: ['url', sequelize.fn('DATE', sequelize.col('dateCreated'))],
            order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']]
        });
    }

    // Agent connection methods
    async logAgentConnection(sessionId, agentName, agentId, additionalData = {}) {
        try {
            const connection = await this.AgentConnection.create({
                sessionId,
                agentName,
                agentId,
                persistentUserId: additionalData.persistentUserId,
                threadTs: additionalData.threadTs,
                messageTs: additionalData.messageTs,
                conversationSummary: additionalData.conversationSummary,
                handoffRequestedAt: additionalData.handoffRequestedAt,
                waitingDuration: additionalData.waitingDuration
            });
            console.log(`✅ Agent connection logged: ${agentName} connected to session ${sessionId}`);
            return connection;
        } catch (error) {
            console.error('Error logging agent connection:', error);
        }
    }

    async logAgentDisconnection(sessionId, disconnectionReason = 'agent_ended') {
        try {
            // Try to find by sessionId first
            let connection = await this.AgentConnection.findOne({
                where: { 
                    sessionId,
                    status: 'connected'
                },
                order: [['connectedAt', 'DESC']]
            });

            // If not found by sessionId, try to find by persistentUserId
            if (!connection) {
                // Get persistentUserId from Redis mapping if available
                const redisService = require('./redisService');
                const persistentUserId = await redisService.getSessionMapping(sessionId);
                if (persistentUserId) {
                    connection = await this.AgentConnection.findOne({
                        where: { 
                            persistentUserId,
                            status: 'connected'
                        },
                        order: [['connectedAt', 'DESC']]
                    });
                }
            }

            if (connection) {
                const disconnectedAt = TimezoneUtils.nowInAEST();
                const sessionDuration = Math.floor((disconnectedAt - connection.connectedAt) / 1000);
                
                await connection.update({
                    disconnectedAt,
                    sessionDuration,
                    status: 'disconnected',
                    disconnectionReason
                });
                console.log(`✅ Agent disconnection logged: ${connection.agentName} disconnected from session ${sessionId} (${sessionDuration}s)`);
            } else {
                console.log(`⚠️ No active agent connection found for session ${sessionId}`);
            }
        } catch (error) {
            console.error('Error logging agent disconnection:', error);
        }
    }

    async logHandoffTimeout(persistentUserId) {
        try {
            const connection = await this.AgentConnection.findOne({
                where: { 
                    persistentUserId,
                    status: 'connected'
                },
                order: [['handoffRequestedAt', 'DESC']]
            });

            if (connection) {
                await connection.update({
                    status: 'timeout',
                    disconnectionReason: 'timeout',
                    disconnectedAt: TimezoneUtils.nowInAEST()
                });
                console.log(`✅ Handoff timeout logged for user ${persistentUserId}`);
            }
        } catch (error) {
            console.error('Error logging handoff timeout:', error);
        }
    }

    async logUserInactivityTimeout(persistentUserId) {
        try {
            const connection = await this.AgentConnection.findOne({
                where: { 
                    persistentUserId,
                    status: 'connected'
                },
                order: [['handoffRequestedAt', 'DESC']]
            });

            if (connection) {
                await connection.update({
                    status: 'user_inactive',
                    disconnectionReason: 'user_inactivity_10min',
                    disconnectedAt: TimezoneUtils.nowInAEST()
                });
                console.log(`✅ User inactivity timeout logged for user ${persistentUserId}`);
            }
        } catch (error) {
            console.error('Error logging user inactivity timeout:', error);
        }
    }

    // Analytics methods
    async getLeadStats(clientId = 'achora', days = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const stats = await this.Lead.findAll({
            where: {
                clientId,
                createdAt: {
                    [Sequelize.Op.gte]: startDate
                }
            },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
                [sequelize.fn('DATE', sequelize.col('createdAt')), 'date']
            ],
            group: [sequelize.fn('DATE', sequelize.col('createdAt'))],
            order: [[sequelize.fn('DATE', sequelize.col('createdAt')), 'ASC']]
        });

        return stats;
    }

    // User Events tracking methods
    async trackPageLoad(sessionId) {
        try {
            const [userEvent, created] = await this.UserEvents.findOrCreate({
                where: { sessionId },
                defaults: {
                    sessionId,
                    pageLoaded: TimezoneUtils.nowInAEST()
                }
            });

            // Always update pageLoaded timestamp when page loads (including refreshes)
            if (!created) {
                await userEvent.update({ pageLoaded: TimezoneUtils.nowInAEST() });
            }

            return userEvent;
        } catch (error) {
            console.error('Error tracking page load:', error);
        }
    }

    async trackWidgetOpened(sessionId) {
        try {
            const [userEvent] = await this.UserEvents.findOrCreate({
                where: { sessionId },
                defaults: { sessionId }
            });

            if (!userEvent.widgetOpened) {
                await userEvent.update({ widgetOpened: TimezoneUtils.nowInAEST() });
            }

            return userEvent;
        } catch (error) {
            console.error('Error tracking widget opened:', error);
        }
    }

    async trackHumanRequested(sessionId) {
        try {
            const [userEvent] = await this.UserEvents.findOrCreate({
                where: { sessionId },
                defaults: { sessionId }
            });

            if (!userEvent.requestedHuman) {
                await userEvent.update({ requestedHuman: TimezoneUtils.nowInAEST() });
            }

            return userEvent;
        } catch (error) {
            console.error('Error tracking human requested:', error);
        }
    }

    async trackAcceptPressed(sessionId) {
        try {
            const [userEvent] = await this.UserEvents.findOrCreate({
                where: { sessionId },
                defaults: { sessionId }
            });

            if (!userEvent.pressedAccept) {
                await userEvent.update({ pressedAccept: TimezoneUtils.nowInAEST() });
            }

            return userEvent;
        } catch (error) {
            console.error('Error tracking accept pressed:', error);
        }
    }

    async trackCallbackPressed(sessionId) {
        try {
            const [userEvent] = await this.UserEvents.findOrCreate({
                where: { sessionId },
                defaults: { sessionId }
            });

            if (!userEvent.pressedCallback) {
                await userEvent.update({ pressedCallback: TimezoneUtils.nowInAEST() });
            }

            return userEvent;
        } catch (error) {
            console.error('Error tracking callback pressed:', error);
        }
    }

    async trackContinuePressed(sessionId) {
        try {
            const [userEvent] = await this.UserEvents.findOrCreate({
                where: { sessionId },
                defaults: { sessionId }
            });

            if (!userEvent.pressedContinue) {
                await userEvent.update({ pressedContinue: TimezoneUtils.nowInAEST() });
            }

            return userEvent;
        } catch (error) {
            console.error('Error tracking continue pressed:', error);
        }
    }

    async getEventStats(sessionId) {
        try {
            return await this.UserEvents.findOne({
                where: { sessionId }
            });
        } catch (error) {
            console.error('Error getting event stats:', error);
            return null;
        }
    }
}

module.exports = new DatabaseService();