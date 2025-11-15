const express = require('express');
const chatController = require('../controllers/chatController');

const router = express.Router();

// Chat webhook endpoint
router.post('/chat', (req, res) => chatController.handleChatMessage(req, res));

// Slack webhook endpoint (for button clicks)
router.post('/slack/webhook', (req, res) => chatController.handleSlackWebhook(req, res));

// Health check endpoint
router.get('/health', (req, res) => chatController.healthCheck(req, res));

// EMERGENCY: Clear Redis - visit /clear-redis in browser
router.get('/clear-redis', async (req, res) => {
    try {
        const redisService = require('../services/redisService');
        
        if (!redisService.isConnected) {
            await redisService.connect();
        }
        
        if (redisService.isConnected && redisService.client) {
            await redisService.client.flushAll();
            res.json({ success: true, message: 'All Redis data cleared successfully!' });
        } else {
            res.json({ success: false, error: 'Could not connect to Redis' });
        }
    } catch (error) {
        console.error('Redis clear error:', error);
        res.json({ success: false, error: error.message });
    }
});

module.exports = router;