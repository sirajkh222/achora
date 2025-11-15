# Achora Chatbot

## Overview
Node.js chatbot service for Achora, an NDIS provider. Intelligent customer support with automated human handoff, lead capture, and knowledge base integration.

## Key Features
- Real-time chat powered by OpenAI GPT-4o
- RAG (Retrieval-Augmented Generation) with Pinecone vector database
- Intelligent human handoff via Slack integration
- Redis-based session persistence with graceful fallback
- Progressive lead capture with validation
- PostgreSQL database for persistent storage
- WebSocket support for real-time bidirectional communication
- Rate limiting and security middleware
- Australian timezone support (AEST)

## Architecture

### Core Services
- **ConversationService**: RAG integration and AI response generation
- **SessionService**: 4-state session management with Redis persistence
- **HandoffService**: Intelligent human handoff analysis and triggers
- **PromptBuilder**: Dynamic context-aware prompt construction
- **OpenAIRetryService**: Resilient OpenAI API calls with exponential backoff
- **SlackService**: Human agent integration via Slack
- **RedisService**: Session persistence and state management
- **DatabaseService**: PostgreSQL operations via Sequelize ORM

### Session States
1. **SEEKING_HANDOFF**: Default state, analyzing for handoff triggers
2. **CALLBACK_REQUEST**: Progressive lead collection (name → email → phone)
3. **LEAD_CAPTURE**: Alternative lead capture path
4. **NORMAL_CHAT**: Regular AI chat with knowledge base integration
5. **HUMAN_CONNECTED**: Active human agent session via Slack

## Technology Stack
- **Backend**: Node.js with Express.js
- **Real-time**: Socket.IO for WebSocket connections
- **AI**: OpenAI GPT-4o (chat completion & embeddings)
- **Vector DB**: Pinecone for knowledge base search
- **Cache**: Redis with in-memory fallback
- **Database**: PostgreSQL (Sequelize ORM)
- **Integration**: Slack for human handoff
- **Deployment**: Railway-ready configuration

## Project Structure
```
achora/
├── src/
│   ├── app.js                      # Main Express server
│   ├── controllers/
│   │   └── chatController.js       # Request routing and webhooks
│   ├── routes/
│   │   └── chat.js                 # Chat and webhook endpoints
│   ├── services/
│   │   ├── prompts/                # Prompt templates by state
│   │   │   ├── BasePromptBuilder.js
│   │   │   ├── PromptFactory.js
│   │   │   ├── SeekingHandoffPrompt.js
│   │   │   ├── NormalChatPrompt.js
│   │   │   ├── LeadCapturePrompt.js
│   │   │   └── CallbackRequestPrompt.js
│   │   ├── conversationService.js  # RAG & response generation
│   │   ├── sessionService.js       # State management
│   │   ├── handoffService.js       # Handoff analysis
│   │   ├── slackService.js         # Slack integration
│   │   ├── redisService.js         # Redis persistence
│   │   ├── databaseService.js      # Database operations
│   │   ├── pineconeServiceV2.js    # Vector search
│   │   ├── openaiRetryService.js   # API resilience
│   │   ├── aiService.js            # Legacy core service
│   │   ├── memoryService.js        # Conversation history
│   │   └── states.js               # State enum definitions
│   └── utils/
│       └── timezoneUtils.js        # AEST timezone handling
├── public/
│   ├── index.html                  # Main chat interface
│   ├── chatbot-widget.html         # Desktop widget
│   ├── chatbot-widget-mobile.html  # Mobile widget
│   └── achora-embed.txt            # Embedding instructions
├── package.json
├── .env.example
└── README.md
```

## Installation

### Prerequisites
- Node.js 18+
- PostgreSQL database (or Supabase)
- Redis instance
- OpenAI API key
- Pinecone account with index created
- Slack workspace with bot configured

### Setup Steps

1. **Clone and Install**
   ```bash
   cd C:\Users\siraj\source\repos\achora
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your credentials:
   - `DATABASE_URL`: PostgreSQL connection string
   - `REDIS_URL`: Redis connection string (or component variables)
   - `OPENAI_API_KEY`: Your OpenAI API key
   - `PINECONE_API_KEY`: Your Pinecone API key
   - `PINECONE_INDEX_NAME`: **IMPORTANT** - Set to your Achora-specific index
   - `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`: Slack configuration

3. **Initialize Database**
   ```bash
   npm start
   ```
   Database tables will be created automatically via Sequelize sync.

4. **Populate Pinecone Knowledge Base**
   Upload your Achora-specific knowledge base documents to your Pinecone index using text-embedding-ada-002.

## Configuration

### Environment Variables

#### Required
- `DATABASE_URL`: PostgreSQL connection string
- `OPENAI_API_KEY`: OpenAI API key for GPT-4o
- `PINECONE_API_KEY`: Pinecone API key
- `PINECONE_INDEX_NAME`: Pinecone index name for Achora knowledge base
- `SLACK_BOT_TOKEN`: Slack bot token for human handoff
- `SLACK_CHANNEL_ID`: Slack channel for agent notifications

#### Optional
- `PORT`: Server port (default: 3000)
- `ALLOWED_ORIGINS`: CORS origins (default: *)
- `REDIS_URL`: Redis connection (falls back to in-memory if not set)
- `DB_POOL_MAX`: Database pool size (default: 20)
- `DB_POOL_MIN`: Minimum pool connections (default: 5)

### Pinecone Index Configuration
The `PINECONE_INDEX_NAME` environment variable is critical. Ensure it points to your Achora-specific knowledge base index.

## API Endpoints

### Chat Endpoints
- `POST /chat` - Main chat message handling
- `POST /slack/webhook` - Slack Events API and Interactive Components
- `GET /health` - Service health check

## Database Models

### Lead
Contact information captured from chat sessions.
- UUID primary key
- Session ID for tracking
- Client ID (default: 'achora')
- Contact details: firstName, lastName, email, phone
- Source tracking and status
- AEST timestamps

### ChatLog
Complete conversation history with metadata.
- UUID primary key
- Session ID and conversation sequence (convoId)
- Message type: user, bot, human, system
- JSONB metadata for extensibility
- AEST timestamps

### UserEvents
User interaction analytics.
- Session ID primary key
- Event tracking: pageLoaded, widgetOpened, requestedHuman
- Button click tracking: pressedAccept, pressedCallback, pressedContinue
- AEST timestamps

### AgentConnection
Human handoff session tracking.
- UUID primary key
- Session and persistent user IDs
- Agent identification
- Slack thread tracking
- Duration calculations
- Disconnection reason tracking
- AEST timestamps

### LinksClicked
Link interaction tracking.
- UUID primary key
- Session ID and URL
- AEST timestamps

## Business Logic

### Handoff Rules
- **24-Hour Cooldown**: Users can request live chat once per 24 hours
- **Callback Exemption**: Callback requests always allowed
- **Business Hours**: Different behavior during 9AM-5PM AEST
- **Context Prioritization**: AI weighs relevance, depth, and state (0-10 scale)

### Handoff Triggers
- Direct requests for human assistance
- No relevant knowledge base match
- Conversation ending expressions
- Complex queries (plan management, funding)
- AI suggests human would be better

## Development

### Running Locally
```bash
npm start
```

Server will start on port 3000 (or PORT environment variable):
- Chat endpoint: http://localhost:3000/chat
- Health check: http://localhost:3000/health
- Slack webhook: http://localhost:3000/slack/webhook

### Clearing Redis Cache
```bash
npm run clear-redis
```

## Deployment

### Railway Deployment
This project is configured for Railway deployment:

1. Connect your GitHub repository to Railway
2. Set environment variables in Railway dashboard
3. Railway will automatically detect and deploy using `npm start`
4. Ensure `DATABASE_URL` and `REDIS_URL` are properly configured

### Environment Checklist
- [ ] DATABASE_URL configured
- [ ] REDIS_URL configured (or in-memory fallback accepted)
- [ ] OPENAI_API_KEY set
- [ ] PINECONE_API_KEY and PINECONE_INDEX_NAME set
- [ ] SLACK_BOT_TOKEN and SLACK_CHANNEL_ID configured
- [ ] ALLOWED_ORIGINS set for your domain

## Architecture Notes

### Excluded Components
- No Salesforce integration
- Streamlined database models without CRM sync fields
- Focused on core chatbot functionality

### Changed
- Client ID default changed from 'maplecommunity' to 'achora'
- Branding updated in all HTML files
- Package name changed to 'achora-chatbot'
- Server startup message references Achora

### Unchanged
- All core chat functionality
- Session management and state transitions
- Slack integration for human handoff
- Lead capture and database logging
- Redis session persistence
- OpenAI and Pinecone integrations

## Important Notes

### Pinecone Index
Make sure your `PINECONE_INDEX_NAME` environment variable points to the Achora knowledge base index. Using the wrong index will result in incorrect knowledge base responses.

### Australian Context
- All timestamps use AEST (Australian Eastern Standard Time)
- Business hours logic assumes Australian timezone
- Spelling uses Australian English conventions

### Memory Management
- Redis TTL: 1 hour for session data
- In-memory sessions cleaned every 24 hours
- Conversation context limited to last 5 interactions
- Database connection pooling optimized for Supabase

## Error Handling
- OpenAI failures: Exponential backoff with graceful fallbacks
- Redis failures: Automatic fallback to in-memory sessions
- Database errors: Logged but don't crash the service
- Slack API errors: Use fallback notification methods

## Support & Maintenance
For issues or questions, contact the development team.

## License
ISC

## Author
Siraj Khan
