const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');

class PineconeServiceV2 {
    constructor() {
        this.pinecone = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY
        });

        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        this.indexName = process.env.PINECONE_INDEX_NAME;
        this.index = null;
        this.MODEL = 'text-embedding-3-small'; // Better model for search
    }

    async initialize() {
        if (!this.index) {
            this.index = this.pinecone.index(this.indexName);
        }
    }

    async searchKnowledge(query, options = {}) {
        try {
            await this.initialize();

            // Expand NDIS abbreviations for better matching
            const expandedQuery = this.expandAbbreviations(query);

            // Detect query intent for smarter retrieval
            const queryIntent = this.detectQueryIntent(query);

            // Create embedding with better model
            const embedding = await this.openai.embeddings.create({
                model: this.MODEL,
                input: expandedQuery
            });

            // Dynamic topK based on query type - max 5 for better coverage
            let topK = options.topK || 5;

            if (queryIntent.isListing || queryIntent.needsComprehensive) {
                topK = 5; // Max 5 for comprehensive results
            }

            // Build filter based on query intent
            const filter = this.buildFilter(queryIntent, options);

            // Search with metadata filtering (only include filter if not empty)
            const queryParams = {
                vector: embedding.data[0].embedding,
                topK: topK,
                includeMetadata: true
            };

            // Only add filter if it has properties
            if (filter && Object.keys(filter).length > 0) {
                queryParams.filter = filter;
            }

            const searchResponse = await this.index.query(queryParams);

            console.log(`Found ${searchResponse.matches.length} matches for: "${query}"`);

            // Filter by minimum score threshold
            const scoreThreshold = options.scoreThreshold || 0.1;
            const relevantMatches = searchResponse.matches.filter(match => match.score >= scoreThreshold);

            console.log(`Filtered to ${relevantMatches.length} relevant matches (score >= ${scoreThreshold})`);

            // Process and rank results
            const processedResults = this.processResults(
                relevantMatches,
                queryIntent,
                expandedQuery
            );

            // Calculate metrics for logging
            const bestScore = relevantMatches.length > 0 ? Math.max(...relevantMatches.map(m => m.score)) : 0;
            const highPriorityCount = relevantMatches.filter(m => m.metadata?.priority === 'high').length;

            return {
                context: processedResults.context,
                urls: processedResults.urls,
                bestScore: bestScore,
                totalMatches: relevantMatches.length,
                highPriorityCount: highPriorityCount,
                categoryMatches: processedResults.categories.length,
                categories: processedResults.categories
            };

        } catch (error) {
            console.error('Pinecone search error:', error);
            return {
                context: '',
                matches: 0,
                urls: [],
                categories: []
            };
        }
    }

    expandAbbreviations(query) {
        const abbreviations = {
            'SIL': 'Supported Independent Living',
            'SDA': 'Specialist Disability Accommodation',
            'STA': 'Short Term Accommodation respite',
            'AT': 'Assistive Technology',
            'OT': 'Occupational Therapy',
            'SC': 'Support Coordination',
            'SSC': 'Specialist Support Coordination',
            'NDIA': 'National Disability Insurance Agency',
            'LAC': 'Local Area Coordinator',
            'AAT': 'Administrative Appeals Tribunal'
        };

        let expanded = query;
        for (const [abbr, full] of Object.entries(abbreviations)) {
            const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
            if (regex.test(query)) {
                expanded = expanded.replace(regex, `${abbr} ${full}`);
            }
        }
        return expanded;
    }

    detectQueryIntent(query) {
        const lower = query.toLowerCase();

        return {
            isListing: /\b(all|list|show|what are|available|options)\b/.test(lower),
            isVacancy: /\b(vacanc|available|room|accommodation|SIL|SDA)\b/i.test(query),
            isPricing: /\b(cost|price|fee|rate|budget|pay|afford)\b/.test(lower),
            isFunding: /\b(funding|plan budget|NDIS funding|categories)\b/i.test(query),
            isBenefits: /\b(benefits|advantages|why|what.*good|help me)\b/.test(lower),
            isCoreSupports: /\b(core support|daily|personal care|transport|household)\b/i.test(query),
            isEligibility: /\b(eligib|qualify|can i|am i|requirement)\b/.test(lower),
            isProcess: /\b(how|process|step|apply|submit|request)\b/.test(lower),
            isUrgent: /\b(urgent|asap|immediately|emergency|now)\b/.test(lower),
            needsComprehensive: /\b(everything|all|complete|full|comprehensive)\b/.test(lower),
            location: this.extractLocation(query)
        };
    }

    extractLocation(query) {
        const locationPattern = /\b(Sydney|Melbourne|Brisbane|Perth|Adelaide|NSW|VIC|QLD|WA|SA|Western Sydney|Eastern Sydney|North Shore|[A-Z][a-z]+ Park|[A-Z][a-z]+ Hills?)\b/gi;
        const matches = query.match(locationPattern);
        return matches ? matches[0] : null;
    }

    buildFilter(queryIntent, options) {
        const filter = {};

        // Add category filters based on intent
        if (queryIntent.isVacancy) {
            filter.content_type = 'vacancy';
        }
        if (queryIntent.isPricing) {
            filter.content_type = 'pricing';
        }
        if (queryIntent.isFunding) {
            filter.content_type = 'funding_information';
        }
        if (queryIntent.isBenefits) {
            filter.content_type = 'benefits';
        }
        if (queryIntent.isCoreSupports) {
            filter.content_type = 'core_supports';
        }
        if (queryIntent.isEligibility) {
            filter.content_type = 'eligibility';
        }

        // Location handled by semantic search, no metadata filtering needed

        // Priority boost for urgent queries
        if (queryIntent.isUrgent) {
            filter.priority = { $in: ['high', 'medium'] };
        }

        // Merge with any provided filters
        return { ...filter, ...options.filter };
    }

    processResults(matches, queryIntent, query) {
        const urls = new Set();
        const categories = new Set();
        const chunks = new Map(); // Group chunks by original document

        // Group chunks from same document
        console.log(`Processing ${matches.length} raw matches`);
        matches.forEach((match, index) => {
            const metadata = match.metadata || {};
            const recordId = match.id || `match_${index}`;  // Use match.id not metadata.id
            const baseId = recordId.split('_chunk')[0] || recordId;

            console.log(`Match ${index}: recordId=${recordId}, baseId=${baseId}, score=${match.score?.toFixed(3)}`);

            if (!chunks.has(baseId)) {
                chunks.set(baseId, []);
            }
            chunks.get(baseId).push({
                score: match.score,
                metadata: metadata
            });

            // Collect URLs and categories
            if (metadata.url) urls.add(metadata.url);
            if (metadata.categories) {
                metadata.categories.split(',').forEach(cat => categories.add(cat));
            }
        });

        console.log(`Grouped into ${chunks.size} documents with ${urls.size} URLs`);
        console.log(`Using top 5 documents for context`);

        // Build context with smart ordering
        const contextParts = [];

        // Sort documents by relevance
        const sortedDocs = Array.from(chunks.entries())
            .map(([id, chunks]) => ({
                id,
                chunks,
                maxScore: Math.max(...chunks.map(c => c.score)),
                priority: chunks[0].metadata.priority || 'medium'
            }))
            .sort((a, b) => {
                // Prioritize high priority content
                if (a.priority === 'high' && b.priority !== 'high') return -1;
                if (b.priority === 'high' && a.priority !== 'high') return 1;
                // Then by score
                return b.maxScore - a.maxScore;
            });

        // Format context (limit to 5 documents)
        sortedDocs.slice(0, 5).forEach(doc => {
            const metadata = doc.chunks[0].metadata;
            const topic = metadata.topic || 'Information';
            const source = metadata.source || 'Knowledge Base';

            // Combine chunks if multiple
            let content = '';
            if (doc.chunks.length > 1) {
                // Sort chunks by index and combine
                doc.chunks
                    .sort((a, b) => (a.metadata.chunk_index || 0) - (b.metadata.chunk_index || 0))
                    .forEach(chunk => {
                        content += chunk.metadata.text + ' ';
                    });
                content = content.trim();
            } else {
                content = metadata.text || '';
            }

            // URLs are available in the urls array for GPT to use naturally
            // No need to add "Reference:" lines that cause duplication

            contextParts.push(
                `Topic: ${topic}\n` +
                `Source: ${source}\n` +
                `Content: ${content}`
            );
        });

        return {
            context: contextParts.join('\n\n---\n\n'),
            urls: Array.from(urls),
            categories: Array.from(categories)
        };
    }

}

module.exports = new PineconeServiceV2();