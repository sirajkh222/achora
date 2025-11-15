const BasePromptBuilder = require('./BasePromptBuilder');

/**
 * Prompt builder for NORMAL_CHAT state
 * Focused on answering questions with helpful NDIS information and building rapport
 */
class NormalChatPrompt extends BasePromptBuilder {
    constructor(contextWeights) {
        super(contextWeights);
    }

    /**
     * Build the complete prompt for NORMAL_CHAT state
     */
    buildPrompt(searchResult) {
        let knowledgeSection;
        if (!searchResult.context) {
            knowledgeSection = `NO KNOWLEDGE FOUND: You don't have information about this topic. Do NOT make up answers. Instead, acknowledge you don't have that specific information and say: "I don't have specific details about that right now, but our team will be able to provide more information when they follow up with you."`;
        } else {
            knowledgeSection = this.buildKnowledgeContext(searchResult);
        }

        return `${this.buildRoleSection()}

${knowledgeSection}

Task: Answer NDIS questions, build rapport. Try and include the url links when appropriate.

${this.buildOutputRules()}`;
    }
}

module.exports = NormalChatPrompt;